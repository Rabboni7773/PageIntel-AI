"""
Agentic RAG Question Answering Workflow
Orchestrates dynamic tool routing (Redis vector similarity search, Tavily live web search,
or direct parametric LLM generation) with multi-turn chat memory in Redis.
"""

import os
import json
from pathlib import Path
from typing import List, Dict, Any, Optional
from dotenv import load_dotenv
from langchain_groq import ChatGroq
from langchain_core.messages import SystemMessage, HumanMessage
from langchain_core.tools import tool
from langchain_community.tools.tavily_search import TavilySearchResults

env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=env_path)

from redis_store import RedisPageVectorStore
from PROMPTS import (
    RAG_SYSTEM_PROMPT,
    RAG_USER_PROMPT,
    AGENT_ROUTER_SYSTEM_PROMPT,
    WEB_SEARCH_SYNTHESIS_PROMPT,
)


class PageIntelRAGWorkflow:
    def __init__(
        self,
        vector_store: Optional[RedisPageVectorStore] = None,
        default_groq_model: str = "openai/gpt-oss-120b",
        tavily_api_key: Optional[str] = None,
    ):
        self.vector_store = vector_store or RedisPageVectorStore()
        self.default_groq_model = os.getenv("GROQ_MODEL", default_groq_model)
        self.tavily_api_key = tavily_api_key or os.getenv("TAVILY_API_KEY") or os.getenv("tavily_api_key")
        if self.tavily_api_key:
            os.environ["TAVILY_API_KEY"] = self.tavily_api_key

    def _get_llm(self, api_key: Optional[str] = None, model: Optional[str] = None) -> ChatGroq:
        key = api_key or os.getenv("GROQ_API_KEY")
        if not key:
            raise ValueError(
                "GROQ_API_KEY is not configured. Please add GROQ_API_KEY to your backend .env file or enter it in the extension settings."
            )
        model_name = model or self.default_groq_model
        return ChatGroq(model=model_name, api_key=key, temperature=0.2)

    def _create_tools(self, page_id: str, top_k: int = 4, tavily_api_key: Optional[str] = None):
        """Create tools bound to the active page context and Tavily search API."""
        tav_key = tavily_api_key or self.tavily_api_key or os.getenv("TAVILY_API_KEY") or os.getenv("tavily_api_key")
        if tav_key:
            os.environ["TAVILY_API_KEY"] = tav_key

        @tool
        def retrieve_docs(query: str) -> List[Dict[str, Any]]:
            """Search the currently active webpage for relevant content chunks.
            Call this tool when the user is asking questions specifically about the active webpage,
            its article, text, content, summary, or details on this page.
            """
            docs = self.vector_store.similarity_search(page_id=page_id, query=query, top_k=top_k)
            formatted = []
            for doc in docs:
                formatted.append({
                    "chunk_index": doc.metadata.get("chunk_index"),
                    "score": doc.metadata.get("score"),
                    "snippet": doc.page_content[:200] + "...",
                    "content": doc.page_content,
                    "source_type": "document",
                })
            return formatted

        @tool
        def web_search(query: str) -> List[Dict[str, Any]]:
            """Search the live web using Tavily for real-time information, latest news,
            current facts, weather, stocks, or questions not found on the current webpage.
            """
            try:
                tavily = TavilySearchResults(tavily_api_key=tav_key, max_results=4)
                results = tavily.invoke({"query": query})
                formatted = []
                for r in results:
                    formatted.append({
                        "title": r.get("title", "Web Source"),
                        "url": r.get("url", ""),
                        "snippet": r.get("content", "")[:250] + "...",
                        "content": r.get("content", ""),
                        "source_type": "web",
                    })
                return formatted
            except Exception as e:
                return [{
                    "title": "Web Search Notice",
                    "url": "",
                    "snippet": f"Web search could not be completed: {str(e)}",
                    "content": str(e),
                    "source_type": "web",
                }]

        return retrieve_docs, web_search

    def index_page_content(
        self,
        page_id: str,
        url: str,
        title: str,
        content: str,
        previous_page_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Indexes extracted webpage content into Redis vector store."""
        return self.vector_store.index_page(
            page_id=page_id,
            url=url,
            title=title,
            content=content,
            previous_page_id=previous_page_id,
        )

    def set_previous_page_ttl(self, previous_page_id: str, ttl_seconds: int = 300) -> Dict[str, Any]:
        """Decreases lifespan of previous page data to 5 minutes (300 seconds)."""
        return self.vector_store.set_page_ttl(previous_page_id, ttl_seconds=ttl_seconds)

    async def answer_query(
        self,
        page_id: str,
        url: str,
        title: str,
        query: str,
        content: Optional[str] = None,
        previous_page_id: Optional[str] = None,
        groq_api_key: Optional[str] = None,
        groq_model: Optional[str] = None,
        tavily_api_key: Optional[str] = None,
        top_k: int = 4,
    ) -> Dict[str, Any]:
        """Agentic Question-Answering pipeline:
        1. Indexes webpage into Redis vector store if not yet indexed.
        2. Reasons via LLM tool-calling router to decide:
           a) retrieve_docs (Redis vector similarity search)
           b) web_search (Tavily live internet search)
           c) direct generation (LLM internal parametric knowledge)
        3. Executes selected pathway and synthesizes grounded answer.
        4. Persists conversational turn to Redis memory.
        """
        # Step 1: Check page index status
        if not self.vector_store.is_page_indexed(page_id):
            if content and content.strip():
                self.vector_store.index_page(
                    page_id=page_id,
                    url=url,
                    title=title,
                    content=content,
                    previous_page_id=previous_page_id,
                )
        else:
            if previous_page_id and previous_page_id != page_id:
                self.vector_store.set_page_ttl(previous_page_id, ttl_seconds=300)

        # Step 2: Set up LLM & Router
        llm = self._get_llm(api_key=groq_api_key, model=groq_model)
        retrieve_docs_tool, web_search_tool = self._create_tools(
            page_id=page_id, top_k=top_k, tavily_api_key=tavily_api_key
        )
        router_llm = llm.bind_tools([retrieve_docs_tool, web_search_tool])

        router_system_msg = SystemMessage(
            content=AGENT_ROUTER_SYSTEM_PROMPT.format(
                title=title or "Untitled Page",
                url=url or "Unknown URL",
            )
        )

        history = self.vector_store.get_chat_history(page_id)
        formatted_history = "\n".join(
            [f"{turn['role'].capitalize()}: {turn['content']}" for turn in history[-6:]]
        ) if history else "None (First question on this page)"

        router_res = await router_llm.ainvoke([router_system_msg, HumanMessage(content=query)])
        tool_calls = getattr(router_res, "tool_calls", [])

        # Pathway A: Web Search via Tavily
        if tool_calls and tool_calls[0]["name"] == "web_search":
            search_query = tool_calls[0]["args"].get("query") or query
            web_results = web_search_tool.invoke({"query": search_query})

            web_context_blocks = []
            sources = []
            for r in web_results:
                if r.get("url") or r.get("snippet"):
                    web_context_blocks.append(f"Title: {r.get('title')}\nURL: {r.get('url')}\nContent: {r.get('content')}")
                    sources.append({
                        "title": r.get("title"),
                        "url": r.get("url"),
                        "snippet": r.get("snippet"),
                        "source_type": "web",
                    })

            web_context_text = "\n\n---\n\n".join(web_context_blocks) if web_context_blocks else "No web results found."

            synthesis_msg = HumanMessage(
                content=WEB_SEARCH_SYNTHESIS_PROMPT.format(
                    web_context=web_context_text,
                    chat_history=formatted_history,
                    query=query,
                )
            )
            synthesis_res = await llm.ainvoke([synthesis_msg])
            answer_text = synthesis_res.content if hasattr(synthesis_res, "content") else str(synthesis_res)

            self.vector_store.append_chat_turn(page_id, query, answer_text)

            return {
                "success": True,
                "answer": answer_text,
                "sources": sources,
                "page_id": page_id,
                "url": url,
                "retrieved_count": len(sources),
                "route_taken": "web_search",
                "tool_used": "Tavily Web Search",
            }

        # Pathway B: Document Retrieval via Redis Vector Store
        elif tool_calls and tool_calls[0]["name"] == "retrieve_docs":
            doc_query = tool_calls[0]["args"].get("query") or query
            docs = self.vector_store.similarity_search(page_id=page_id, query=doc_query, top_k=top_k)

            if not docs and content:
                chunks = self.vector_store.text_splitter.split_text(content)[:top_k]
                context_text = "\n\n".join(chunks)
                sources = [{"chunk_index": i, "snippet": c[:200] + "...", "source_type": "document"} for i, c in enumerate(chunks)]
            else:
                context_blocks = []
                sources = []
                for doc in docs:
                    context_blocks.append(doc.page_content)
                    sources.append({
                        "chunk_index": doc.metadata.get("chunk_index"),
                        "score": doc.metadata.get("score"),
                        "snippet": doc.page_content[:200] + "...",
                        "source_type": "document",
                    })
                context_text = "\n\n---\n\n".join(context_blocks) if context_blocks else "No relevant page chunks found."

            system_msg = SystemMessage(content=RAG_SYSTEM_PROMPT)
            user_msg = HumanMessage(
                content=RAG_USER_PROMPT.format(
                    title=title or "Untitled Page",
                    url=url or "Unknown URL",
                    context=context_text,
                    chat_history=formatted_history,
                    query=query,
                )
            )

            response = await llm.ainvoke([system_msg, user_msg])
            answer_text = response.content if hasattr(response, "content") else str(response)

            self.vector_store.append_chat_turn(page_id, query, answer_text)

            return {
                "success": True,
                "answer": answer_text,
                "sources": sources,
                "page_id": page_id,
                "url": url,
                "retrieved_count": len(sources),
                "route_taken": "document",
                "tool_used": "Redis Vector Search",
            }

        # Pathway C: Direct Parametric Knowledge
        else:
            answer_text = router_res.content if hasattr(router_res, "content") and router_res.content else ""
            if not answer_text:
                direct_res = await llm.ainvoke([
                    SystemMessage(content="You are PageIntel AI. Answer the user's question directly, accurately, and concisely."),
                    HumanMessage(content=query),
                ])
                answer_text = direct_res.content if hasattr(direct_res, "content") else str(direct_res)

            self.vector_store.append_chat_turn(page_id, query, answer_text)

            return {
                "success": True,
                "answer": answer_text,
                "sources": [],
                "page_id": page_id,
                "url": url,
                "retrieved_count": 0,
                "route_taken": "direct",
                "tool_used": "Direct Knowledge",
            }

    async def answer_query_stream(
        self,
        page_id: str,
        url: str,
        title: str,
        query: str,
        content: Optional[str] = None,
        previous_page_id: Optional[str] = None,
        groq_api_key: Optional[str] = None,
        groq_model: Optional[str] = None,
        tavily_api_key: Optional[str] = None,
        top_k: int = 4,
    ):
        """Streaming Agentic pipeline emitting real-time tool lifecycle events (NDJSON)."""
        # Step 1: Check page indexing
        if not self.vector_store.is_page_indexed(page_id):
            if content and content.strip():
                yield json.dumps({
                    "stage": "indexing",
                    "tool": "Redis Page Indexer",
                    "icon": "📄",
                    "message": "Indexing page chunks & vector embeddings into Redis...",
                }) + "\n"
                self.vector_store.index_page(
                    page_id=page_id,
                    url=url,
                    title=title,
                    content=content,
                    previous_page_id=previous_page_id,
                )
        else:
            if previous_page_id and previous_page_id != page_id:
                self.vector_store.set_page_ttl(previous_page_id, ttl_seconds=300)

        # Step 2: Routing evaluation
        yield json.dumps({
            "stage": "routing",
            "tool": "Agentic Orchestrator",
            "icon": "🧠",
            "message": "Analyzing question & selecting optimal tool...",
        }) + "\n"

        llm = self._get_llm(api_key=groq_api_key, model=groq_model)
        retrieve_docs_tool, web_search_tool = self._create_tools(
            page_id=page_id, top_k=top_k, tavily_api_key=tavily_api_key
        )
        router_llm = llm.bind_tools([retrieve_docs_tool, web_search_tool])

        router_system_msg = SystemMessage(
            content=AGENT_ROUTER_SYSTEM_PROMPT.format(
                title=title or "Untitled Page",
                url=url or "Unknown URL",
            )
        )

        history = self.vector_store.get_chat_history(page_id)
        formatted_history = "\n".join(
            [f"{turn['role'].capitalize()}: {turn['content']}" for turn in history[-6:]]
        ) if history else "None (First question on this page)"

        router_res = await router_llm.ainvoke([router_system_msg, HumanMessage(content=query)])
        tool_calls = getattr(router_res, "tool_calls", [])

        # Pathway A: Web Search via Tavily
        if tool_calls and tool_calls[0]["name"] == "web_search":
            search_query = tool_calls[0]["args"].get("query") or query
            yield json.dumps({
                "stage": "retrieval",
                "tool": "Tavily Web Search",
                "icon": "🌐",
                "message": f"Searching live web for '{search_query}'...",
            }) + "\n"

            web_results = web_search_tool.invoke({"query": search_query})

            web_context_blocks = []
            sources = []
            for r in web_results:
                if r.get("url") or r.get("snippet"):
                    web_context_blocks.append(f"Title: {r.get('title')}\nURL: {r.get('url')}\nContent: {r.get('content')}")
                    sources.append({
                        "title": r.get("title"),
                        "url": r.get("url"),
                        "snippet": r.get("snippet"),
                        "source_type": "web",
                    })

            web_context_text = "\n\n---\n\n".join(web_context_blocks) if web_context_blocks else "No web results found."

            yield json.dumps({
                "stage": "generation",
                "tool": "Groq LLM Reasoner",
                "icon": "🤖",
                "message": "Synthesizing answer from web citations...",
            }) + "\n"

            synthesis_msg = HumanMessage(
                content=WEB_SEARCH_SYNTHESIS_PROMPT.format(
                    web_context=web_context_text,
                    chat_history=formatted_history,
                    query=query,
                )
            )
            synthesis_res = await llm.ainvoke([synthesis_msg])
            answer_text = synthesis_res.content if hasattr(synthesis_res, "content") else str(synthesis_res)

            self.vector_store.append_chat_turn(page_id, query, answer_text)

            yield json.dumps({
                "stage": "done",
                "tool": "Tavily Web Search",
                "icon": "🌐",
                "success": True,
                "answer": answer_text,
                "sources": sources,
                "page_id": page_id,
                "url": url,
                "retrieved_count": len(sources),
                "route_taken": "web_search",
                "tool_used": "Tavily Web Search",
            }) + "\n"

        # Pathway B: Document Retrieval via Redis Vector Store
        elif tool_calls and tool_calls[0]["name"] == "retrieve_docs":
            doc_query = tool_calls[0]["args"].get("query") or query
            yield json.dumps({
                "stage": "retrieval",
                "tool": "Redis Vector Search",
                "icon": "📄",
                "message": f"Searching page documents in Redis for '{doc_query}'...",
            }) + "\n"

            docs = self.vector_store.similarity_search(page_id=page_id, query=doc_query, top_k=top_k)

            if not docs and content:
                chunks = self.vector_store.text_splitter.split_text(content)[:top_k]
                context_text = "\n\n".join(chunks)
                sources = [{"chunk_index": i, "snippet": c[:200] + "...", "source_type": "document"} for i, c in enumerate(chunks)]
            else:
                context_blocks = []
                sources = []
                for doc in docs:
                    context_blocks.append(doc.page_content)
                    sources.append({
                        "chunk_index": doc.metadata.get("chunk_index"),
                        "score": doc.metadata.get("score"),
                        "snippet": doc.page_content[:200] + "...",
                        "source_type": "document",
                    })
                context_text = "\n\n---\n\n".join(context_blocks) if context_blocks else "No relevant page chunks found."

            yield json.dumps({
                "stage": "generation",
                "tool": "Groq LLM Reasoner",
                "icon": "🤖",
                "message": "Synthesizing answer from page documents...",
            }) + "\n"

            system_msg = SystemMessage(content=RAG_SYSTEM_PROMPT)
            user_msg = HumanMessage(
                content=RAG_USER_PROMPT.format(
                    title=title or "Untitled Page",
                    url=url or "Unknown URL",
                    context=context_text,
                    chat_history=formatted_history,
                    query=query,
                )
            )

            response = await llm.ainvoke([system_msg, user_msg])
            answer_text = response.content if hasattr(response, "content") else str(response)

            self.vector_store.append_chat_turn(page_id, query, answer_text)

            yield json.dumps({
                "stage": "done",
                "tool": "Redis Vector Search",
                "icon": "📄",
                "success": True,
                "answer": answer_text,
                "sources": sources,
                "page_id": page_id,
                "url": url,
                "retrieved_count": len(sources),
                "route_taken": "document",
                "tool_used": "Redis Vector Search",
            }) + "\n"

        # Pathway C: Direct Parametric Knowledge
        else:
            yield json.dumps({
                "stage": "generation",
                "tool": "Direct Knowledge",
                "icon": "💡",
                "message": "Generating answer directly from internal knowledge...",
            }) + "\n"

            answer_text = router_res.content if hasattr(router_res, "content") and router_res.content else ""
            if not answer_text:
                direct_res = await llm.ainvoke([
                    SystemMessage(content="You are PageIntel AI. Answer the user's question directly, accurately, and concisely."),
                    HumanMessage(content=query),
                ])
                answer_text = direct_res.content if hasattr(direct_res, "content") else str(direct_res)

            self.vector_store.append_chat_turn(page_id, query, answer_text)

            yield json.dumps({
                "stage": "done",
                "tool": "Direct Knowledge",
                "icon": "💡",
                "success": True,
                "answer": answer_text,
                "sources": [],
                "page_id": page_id,
                "url": url,
                "retrieved_count": 0,
                "route_taken": "direct",
                "tool_used": "Direct Knowledge",
            }) + "\n"