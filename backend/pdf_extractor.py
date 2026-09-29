"""
PDF Extraction Service
Extracts clean readable text and metadata from PDF URLs (arXiv, academic papers, reports)
using pypdf.
"""

import io
import re
import httpx
from typing import Dict, Any, Optional
from pypdf import PdfReader


def is_pdf_url(url: str) -> bool:
    """Check if a URL points to a PDF document or arXiv PDF."""
    if not url:
        return False
    lower = url.lower()
    return (
        lower.endswith(".pdf")
        or "/pdf/" in lower
        or "arxiv.org/abs/" in lower
        or "arxiv.org/pdf/" in lower
    )


def normalize_pdf_url(url: str) -> str:
    """Normalize arXiv abstract or view URLs into direct PDF download URLs."""
    if not url:
        return ""
    # Transform arXiv abstract URL https://arxiv.org/abs/2301.12345 -> https://arxiv.org/pdf/2301.12345.pdf
    arxiv_match = re.search(r"arxiv\.org/abs/([0-9]+\.[0-9]+(?:v[0-9]+)?)", url)
    if arxiv_match:
        arxiv_id = arxiv_match.group(1)
        return f"https://arxiv.org/pdf/{arxiv_id}.pdf"
    
    # If arXiv pdf url without .pdf suffix
    arxiv_pdf_match = re.search(r"arxiv\.org/pdf/([0-9]+\.[0-9]+(?:v[0-9]+)?)(?:\.pdf)?", url)
    if arxiv_pdf_match:
        arxiv_id = arxiv_pdf_match.group(1)
        return f"https://arxiv.org/pdf/{arxiv_id}.pdf"

    return url


async def extract_pdf_from_url(
    url: str,
    max_pages: int = 40,
    timeout_sec: float = 30.0,
) -> Dict[str, Any]:
    """Downloads a PDF from a URL and extracts clean textual content and metadata.
    
    Returns:
        dict: {
            "success": bool,
            "title": str,
            "text": str,
            "num_pages": int,
            "char_count": int,
            "word_count": int,
            "error": Optional[str]
        }
    """
    download_url = normalize_pdf_url(url)
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/pdf,*/*",
    }

    try:
        async with httpx.AsyncClient(timeout=timeout_sec, follow_redirects=True) as client:
            resp = await client.get(download_url, headers=headers)
            if resp.status_code != 200:
                return {
                    "success": False,
                    "error": f"Failed to download PDF. HTTP status: {resp.status_code}",
                    "title": "",
                    "text": "",
                    "num_pages": 0,
                }
            pdf_bytes = resp.content

        # Parse with pypdf
        reader = PdfReader(io.BytesIO(pdf_bytes))
        total_pages = len(reader.pages)
        pages_to_read = min(total_pages, max_pages)

        # Extract title from metadata if available
        meta_title = ""
        if reader.metadata and reader.metadata.title:
            meta_title = str(reader.metadata.title).strip()

        page_texts = []
        for i in range(pages_to_read):
            try:
                page = reader.pages[i]
                extracted = page.extract_text() or ""
                cleaned_page = extracted.strip()
                if cleaned_page:
                    page_texts.append(f"--- Page {i + 1} ---\n{cleaned_page}")
            except Exception as page_err:
                page_texts.append(f"--- Page {i + 1} ---\n[Error reading page {i + 1}: {str(page_err)}]")

        full_text = "\n\n".join(page_texts).strip()

        # If metadata title is empty, infer from first lines
        if not meta_title and full_text:
            first_lines = [line.strip() for line in full_text.split("\n") if line.strip() and not line.startswith("---")]
            if first_lines:
                meta_title = first_lines[0][:150]

        word_count = len(full_text.split())
        return {
            "success": bool(full_text),
            "title": meta_title or "Research Paper / PDF Document",
            "text": full_text,
            "num_pages": total_pages,
            "pages_extracted": pages_to_read,
            "char_count": len(full_text),
            "word_count": word_count,
            "url": download_url,
            "error": None if full_text else "No extractable text found in PDF (scanned pages may require OCR)",
        }

    except Exception as e:
        return {
            "success": False,
            "error": f"PDF extraction exception: {str(e)}",
            "title": "",
            "text": "",
            "num_pages": 0,
            "char_count": 0,
            "word_count": 0,
            "url": download_url,
        }
