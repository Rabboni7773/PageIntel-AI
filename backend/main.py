"""
FastAPI Backend for PageIntel AI
Provides endpoints for page content indexing into Redis Vector Store,
decreasing previous page lifespan to 5 minutes, and RAG question answering.
"""

import os
from typing import Optional, List, Dict, Any
from pathlib import Path
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# Load environment variables from .env
env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=env_path)

import sys
backend_dir = Path(__file__).resolve().parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))

from redis_store import RedisPageVectorStore
from rag_based_wf import PageIntelRAGWorkflow
from pdf_extractor import extract_pdf_from_url, is_pdf_url
from ocr_service import process_ocr_request

app = FastAPI(
    title="PageIntel AI Backend",
    description="Vector store in Redis Stack (Docker) + RAG via remote Hugging Face Embeddings & Groq + OCR & PDF Extraction",
    version="2.1.0",
)

# Enable CORS for browser extension and localhost
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global Vector Store & RAG Workflow instances
vector_store = RedisPageVectorStore(redis_url=os.getenv("REDIS_URL"))
rag_workflow = PageIntelRAGWorkflow(vector_store=vector_store)


# ------------------ Request Models ------------------ #

class IndexPageRequest(BaseModel):
    page_id: str = Field(..., description="Unique persistent identifier for this webpage (e.g. UUIDv4)")
    url: str = Field(..., description="URL of the webpage")
    title: Optional[str] = Field("", description="Title of the webpage")
    content: str = Field(..., description="Clean extracted text content of the webpage")
    previous_page_id: Optional[str] = Field(None, description="ID of the previously active page to decrease lifespan")
    hf_token: Optional[str] = Field(None, description="Optional Hugging Face API token override")


class PDFExtractRequest(BaseModel):
    page_id: str = Field(..., description="Unique persistent identifier for this webpage")
    url: str = Field(..., description="URL of the PDF or arXiv paper")
    title: Optional[str] = Field("", description="Optional Title override")
    previous_page_id: Optional[str] = Field(None, description="Previous page ID to expire to 5 minutes")


class OCRRequest(BaseModel):
    image_base64: str = Field(..., description="Base64 encoded screenshot image (PNG/JPEG)")
    page_id: str = Field(..., description="Active page ID")
    url: Optional[str] = Field("", description="URL of the page")
    title: Optional[str] = Field("", description="Title of the page")
    crop: Optional[Dict[str, Any]] = Field(None, description="Optional crop coordinates {x, y, width, height}")
    enhance_with_llm: bool = Field(True, description="Clean up typos and format formulas into LaTeX using Groq")
    index_into_redis: bool = Field(True, description="Index extracted text chunks into Redis vector store")
    previous_page_id: Optional[str] = Field(None, description="Previous page ID to expire to 5 minutes")
    groq_api_key: Optional[str] = Field(None, description="Optional Groq API key override")
    groq_model: Optional[str] = Field(None, description="Optional Groq model override")


class PageChangeRequest(BaseModel):
    previous_page_id: str = Field(..., description="ID of the previously active page")
    current_page_id: Optional[str] = Field(None, description="ID of newly active page")
    ttl_seconds: Optional[int] = Field(300, description="Lifespan in seconds for previous page (default 5 minutes)")


class AskQueryRequest(BaseModel):
    page_id: str = Field(..., description="Page unique ID to query against")
    query: str = Field(..., description="User question")
    url: Optional[str] = Field("", description="Page URL")
    title: Optional[str] = Field("", description="Page Title")
    content: Optional[str] = Field(None, description="Extracted content to index on-demand if not already in vector store")
    previous_page_id: Optional[str] = Field(None, description="Previous page ID to expire to 5 minutes")
    groq_api_key: Optional[str] = Field(None, description="Optional Groq API key override")
    groq_model: Optional[str] = Field(None, description="Optional Groq model override")
    tavily_api_key: Optional[str] = Field(None, description="Optional Tavily API key override")


# ------------------ API Routes ------------------ #

@app.get("/health")
async def health_check():
    """Verify backend status, Redis connection, and vector index health."""
    try:
        redis_ok = vector_store.redis_client.ping()
        index_info = vector_store.redis_client.ft(vector_store.index_name).info()
        num_docs = index_info.get("num_docs", 0)
        return {
            "status": "healthy",
            "redis_connected": bool(redis_ok),
            "vector_index": vector_store.index_name,
            "indexed_documents_count": num_docs,
            "embedding_model": vector_store.embedding_model,
            "groq_configured": bool(os.getenv("GROQ_API_KEY")),
            "tesseract_ocr": True,
            "pdf_support": True,
        }
    except Exception as e:
        return {
            "status": "degraded",
            "redis_connected": False,
            "error": str(e),
        }


@app.post("/api/ocr")
async def ocr_endpoint(req: OCRRequest):
    """Processes a screenshot of a webpage, PDF viewer, diagram, or formula.
    
    1. Preprocesses image and crops if coordinates provided.
    2. Runs Tesseract OCR.
    3. Cleans up formatting & converts math to LaTeX via Groq.
    4. Automatically indexes extracted text into Redis vector store for the page.
    """
    try:
        # Run OCR
        ocr_res = await process_ocr_request(
            image_base64=req.image_base64,
            crop=req.crop,
            enhance_with_llm=req.enhance_with_llm,
            groq_api_key=req.groq_api_key,
            groq_model=req.groq_model,
        )

        if not ocr_res.get("success"):
            return {
                "success": False,
                "error": ocr_res.get("error", "No text detected in screenshot."),
                "clean_text": "",
                "raw_text": "",
                "chunk_count": 0,
            }

        extracted_text = ocr_res.get("clean_text", "")
        chunk_count = 0

        # Index into Redis vector store if requested
        if req.index_into_redis and extracted_text:
            if req.previous_page_id and req.previous_page_id != req.page_id:
                rag_workflow.set_previous_page_ttl(req.previous_page_id, ttl_seconds=300)

            index_res = vector_store.append_page_content(
                page_id=req.page_id,
                url=req.url or "",
                title=req.title or "Visual Screenshot",
                content=extracted_text,
                source_tag="ocr",
            )
            chunk_count = index_res.get("new_chunks_count", 0)

        return {
            "success": True,
            "clean_text": extracted_text,
            "raw_text": ocr_res.get("raw_text", ""),
            "char_count": ocr_res.get("char_count", 0),
            "word_count": ocr_res.get("word_count", 0),
            "enhanced": ocr_res.get("enhanced", False),
            "chunk_count": chunk_count,
            "page_id": req.page_id,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OCR execution failed: {str(e)}")


@app.post("/api/extract_pdf")
async def extract_pdf_endpoint(req: PDFExtractRequest):
    """Fetches a PDF (such as arXiv papers or direct PDF links), extracts all readable text,
    and indexes into Redis vector store.
    """
    try:
        pdf_res = await extract_pdf_from_url(req.url)
        if not pdf_res.get("success") or not pdf_res.get("text"):
            return {
                "success": False,
                "error": pdf_res.get("error", "Unable to extract text from PDF URL."),
                "page_id": req.page_id,
                "chunk_count": 0,
            }

        title = req.title or pdf_res.get("title") or "Research Paper"
        index_res = rag_workflow.index_page_content(
            page_id=req.page_id,
            url=req.url,
            title=title,
            content=pdf_res["text"],
            previous_page_id=req.previous_page_id,
        )

        return {
            "success": True,
            "page_id": req.page_id,
            "title": title,
            "num_pages": pdf_res.get("num_pages", 0),
            "char_count": pdf_res.get("char_count", 0),
            "word_count": pdf_res.get("word_count", 0),
            "chunk_count": index_res.get("chunk_count", 0),
            "already_indexed": index_res.get("already_indexed", False),
            "message": f"Successfully parsed {pdf_res.get('pages_extracted', 0)} pages and indexed into Redis.",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF extraction failed: {str(e)}")


@app.post("/api/index_page")
async def index_page_endpoint(req: IndexPageRequest):
    """Step 2 & 7: Extension takes page data and sends to backend.
    
    1. If page content is empty or short and URL is a PDF/arXiv, automatically falls back to direct PDF download.
    2. Indexes webpage chunks into Redis Docker vector store.
    3. If previous_page_id is provided, decreases its lifespan to 5 minutes (300s).
    """
    try:
        content_to_index = req.content
        title_to_index = req.title or ""

        # Auto-fallback: If content is empty or too short, check if it is a PDF/arXiv
        if (not content_to_index or len(content_to_index.strip()) < 60) and is_pdf_url(req.url):
            print(f"[Backend] Content is empty on PDF URL {req.url}. Auto-extracting PDF via pypdf...")
            pdf_res = await extract_pdf_from_url(req.url)
            if pdf_res.get("success") and pdf_res.get("text"):
                content_to_index = pdf_res["text"]
                if not title_to_index:
                    title_to_index = pdf_res.get("title", "Research Paper")

        result = rag_workflow.index_page_content(
            page_id=req.page_id,
            url=req.url,
            title=title_to_index,
            content=content_to_index,
            previous_page_id=req.previous_page_id,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to index page in Redis: {str(e)}")


@app.post("/api/page_change")
async def page_change_endpoint(req: PageChangeRequest):
    """Step 8: User changes page -> decrease previous page data lifespan to 5 minutes."""
    try:
        ttl = req.ttl_seconds or 300
        result = rag_workflow.set_previous_page_ttl(req.previous_page_id, ttl_seconds=ttl)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update page lifespan: {str(e)}")


async def _ensure_page_content(req: AskQueryRequest) -> tuple[str, str]:
    """Ensures page content is resolved, auto-extracting from PDF/arXiv if needed."""
    content = req.content or ""
    title = req.title or ""
    if not vector_store.is_page_indexed(req.page_id):
        if (not content or len(content.strip()) < 60) and is_pdf_url(req.url):
            try:
                print(f"[Backend] Auto-extracting PDF before answering query on {req.url}...")
                pdf_res = await extract_pdf_from_url(req.url)
                if pdf_res.get("success") and pdf_res.get("text"):
                    content = pdf_res["text"]
                    if not title:
                        title = pdf_res.get("title", "Research Paper")
            except Exception as e:
                print(f"[Backend] PDF auto-extract failed: {e}")
    return content, title


@app.post("/api/ask")
async def ask_endpoint(req: AskQueryRequest, stream: Optional[bool] = False):
    """Steps 1-5 & 9: Ask a question about the page.
    
    - If first question and page not yet indexed, creates vector store in Redis using extracted content or PDF.
    - If already indexed, directly reuses existing vectors for the page.
    - Decreases previous page lifespan to 5 minutes if previous_page_id is passed.
    - Answers accurately via similarity search + Groq LLM.
    - Supports real-time streaming of tool progression if stream=true.
    """
    content, title = await _ensure_page_content(req)

    if stream:
        return StreamingResponse(
            rag_workflow.answer_query_stream(
                page_id=req.page_id,
                url=req.url or "",
                title=title or req.title or "",
                query=req.query,
                content=content,
                previous_page_id=req.previous_page_id,
                groq_api_key=req.groq_api_key,
                groq_model=req.groq_model,
                tavily_api_key=req.tavily_api_key,
            ),
            media_type="application/x-ndjson",
        )

    try:
        result = await rag_workflow.answer_query(
            page_id=req.page_id,
            url=req.url or "",
            title=req.title or "",
            query=req.query,
            content=req.content,
            previous_page_id=req.previous_page_id,
            groq_api_key=req.groq_api_key,
            groq_model=req.groq_model,
            tavily_api_key=req.tavily_api_key,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/ask/stream")
async def ask_stream_endpoint(req: AskQueryRequest):
    """Dedicated endpoint for real-time tool progress streaming (NDJSON)."""
    return StreamingResponse(
        rag_workflow.answer_query_stream(
            page_id=req.page_id,
            url=req.url or "",
            title=req.title or "",
            query=req.query,
            content=req.content,
            previous_page_id=req.previous_page_id,
            groq_api_key=req.groq_api_key,
            groq_model=req.groq_model,
            tavily_api_key=req.tavily_api_key,
        ),
        media_type="application/x-ndjson",
    )


@app.get("/api/page_status/{page_id}")
async def get_page_status(page_id: str):
    """Inspect whether a page is currently stored in Redis, its chunk count, and remaining TTL."""
    try:
        meta = vector_store.get_page_meta(page_id)
        if not meta:
            return {"is_indexed": False, "page_id": page_id, "meta": None}
        return {"is_indexed": True, "page_id": page_id, "meta": meta}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/chat_history/{page_id}")
async def get_page_chat_history(page_id: str):
    """Retrieve multi-turn conversation history for a specific page."""
    try:
        history = vector_store.get_chat_history(page_id)
        return {"page_id": page_id, "history": history}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))