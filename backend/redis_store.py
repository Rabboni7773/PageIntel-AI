"""
Redis Vector Store & Page Lifecycle Manager
Manages page embeddings, vector similarity search, and TTL lifecycle in Redis Docker.
"""

import os
import json
import time
from typing import List, Dict, Any, Optional
import redis
from redis.commands.search.field import TextField, TagField, NumericField, VectorField
from redis.commands.search.index_definition import IndexDefinition, IndexType
from redis.commands.search.query import Query
import numpy as np

from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
from hf_embeddings import HuggingFaceEndpointEmbeddings


class RedisPageVectorStore:
    def __init__(
        self,
        redis_url: Optional[str] = None,
        index_name: str = "pageintel_idx",
        embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2",
        vector_dim: int = 384,
        hf_token: Optional[str] = None,
    ):
        self.redis_url = redis_url or os.getenv("REDIS_URL") or "redis://localhost:6379"
        self.index_name = index_name
        self.vector_dim = vector_dim
        self.embedding_model = embedding_model
        
        # Connect to Redis
        self.redis_client = redis.Redis.from_url(self.redis_url, decode_responses=False)
        
        # Initialize remote HF Endpoint embeddings (no local models)
        self.embeddings = HuggingFaceEndpointEmbeddings(
            model=self.embedding_model,
            token=hf_token or os.getenv("HUGGINGFACEHUB_API_TOKEN"),
            dimensions=self.vector_dim,
        )
        
        # Text splitter for chunking extracted webpage content
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=900,
            chunk_overlap=150,
            separators=["\n\n", "\n", ". ", " ", ""],
        )
        
        # Ensure RediSearch vector index exists
        self._ensure_index()

    def _ensure_index(self):
        """Creates the RediSearch index if it does not already exist."""
        try:
            self.redis_client.ft(self.index_name).info()
        except redis.ResponseError:
            # Index does not exist, create it
            schema = [
                TagField("page_id"),
                TextField("url"),
                TextField("title"),
                TextField("content"),
                NumericField("chunk_index"),
                VectorField(
                    "vector",
                    "HNSW",
                    {
                        "TYPE": "FLOAT32",
                        "DIM": self.vector_dim,
                        "DISTANCE_METRIC": "COSINE",
                    },
                ),
            ]
            definition = IndexDefinition(
                prefix=["pageintel:doc:"],
                index_type=IndexType.HASH,
            )
            try:
                self.redis_client.ft(self.index_name).create_index(
                    fields=schema,
                    definition=definition,
                )
            except Exception as e:
                # If created concurrently or already exists
                if "Index already exists" not in str(e):
                    print(f"[RedisPageVectorStore] Index creation notice: {e}")

    def is_page_indexed(self, page_id: str) -> bool:
        """Check if a page has active document chunks stored in Redis."""
        meta_key = f"pageintel:meta:{page_id}"
        exists = self.redis_client.exists(meta_key)
        return bool(exists)

    def get_page_meta(self, page_id: str) -> Optional[Dict[str, Any]]:
        """Retrieve stored metadata and remaining TTL for a page."""
        meta_key = f"pageintel:meta:{page_id}"
        data = self.redis_client.get(meta_key)
        if not data:
            return None
        meta = json.loads(data.decode("utf-8"))
        meta["ttl_seconds"] = self.redis_client.ttl(meta_key)
        return meta

    def index_page(
        self,
        page_id: str,
        url: str,
        title: str,
        content: str,
        previous_page_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Indexes page content chunks and vector embeddings into Redis.
        
        If previous_page_id is provided, sets previous page TTL to 5 minutes (300s).
        """
        # If previous_page_id given, decrease its lifespan to 5 minutes
        if previous_page_id and previous_page_id != page_id:
            self.set_page_ttl(previous_page_id, ttl_seconds=300)

        # Check if page is already indexed
        if self.is_page_indexed(page_id):
            # Page already indexed; remove any pending expiration so it stays active
            self._persist_page(page_id)
            meta = self.get_page_meta(page_id)
            return {
                "success": True,
                "already_indexed": True,
                "page_id": page_id,
                "chunk_count": meta.get("chunk_count", 0) if meta else 0,
                "message": "Page is already indexed in Redis vector store.",
            }

        if not content or not content.strip():
            return {
                "success": False,
                "already_indexed": False,
                "page_id": page_id,
                "chunk_count": 0,
                "message": "No text content provided to index.",
            }

        # Step 1: Split webpage text into semantic chunks
        chunks = self.text_splitter.split_text(content)
        if not chunks:
            chunks = [content[:1000]]

        # Step 2: Generate vector embeddings via remote HF Endpoint
        embeddings = self.embeddings.embed_documents(chunks)

        # Step 3: Store document chunks in Redis Hashes
        doc_keys = []
        pipe = self.redis_client.pipeline()

        for idx, (chunk_text, vector) in enumerate(zip(chunks, embeddings)):
            doc_key = f"pageintel:doc:{page_id}:{idx}"
            doc_keys.append(doc_key)
            vector_bytes = np.array(vector, dtype=np.float32).tobytes()

            mapping = {
                b"page_id": page_id.encode("utf-8"),
                b"url": (url or "").encode("utf-8"),
                b"title": (title or "").encode("utf-8"),
                b"content": chunk_text.encode("utf-8"),
                b"chunk_index": str(idx).encode("utf-8"),
                b"vector": vector_bytes,
            }
            pipe.hset(doc_key, mapping=mapping)

        # Track all chunk keys for this page_id in a Redis Set
        set_key = f"pageintel:docs:{page_id}"
        if doc_keys:
            pipe.sadd(set_key, *[k.encode("utf-8") for k in doc_keys])

        # Store metadata
        meta_key = f"pageintel:meta:{page_id}"
        meta_data = {
            "page_id": page_id,
            "url": url,
            "title": title,
            "chunk_count": len(chunks),
            "indexed_at": time.time(),
        }
        pipe.set(meta_key, json.dumps(meta_data).encode("utf-8"))

        pipe.execute()

        return {
            "success": True,
            "already_indexed": False,
            "page_id": page_id,
            "chunk_count": len(chunks),
            "message": f"Successfully indexed {len(chunks)} chunks in Redis vector store.",
        }

    def append_page_content(
        self,
        page_id: str,
        url: str,
        title: str,
        content: str,
        source_tag: str = "ocr",
    ) -> Dict[str, Any]:
        """Appends additional chunks (e.g. from visual OCR or snipped diagram/table)
        to an existing or new page in the Redis vector store.
        """
        if not content or not content.strip():
            return {"success": False, "chunk_count": 0, "message": "No content to append."}

        # If page not yet indexed, index it as the initial content
        if not self.is_page_indexed(page_id):
            return self.index_page(page_id=page_id, url=url, title=title, content=content)

        # Page is indexed: persist keys
        self._persist_page(page_id)

        chunks = self.text_splitter.split_text(content)
        if not chunks:
            chunks = [content[:1000]]

        embeddings = self.embeddings.embed_documents(chunks)
        timestamp = int(time.time() * 1000)

        meta = self.get_page_meta(page_id) or {}
        existing_count = meta.get("chunk_count", 0)

        doc_keys = []
        pipe = self.redis_client.pipeline()

        for idx, (chunk_text, vector) in enumerate(zip(chunks, embeddings)):
            chunk_num = existing_count + idx
            doc_key = f"pageintel:doc:{page_id}:{source_tag}:{chunk_num}_{timestamp}"
            doc_keys.append(doc_key)
            vector_bytes = np.array(vector, dtype=np.float32).tobytes()

            mapping = {
                b"page_id": page_id.encode("utf-8"),
                b"url": (url or "").encode("utf-8"),
                b"title": (title or "").encode("utf-8"),
                b"content": f"[{source_tag.upper()} Visual Content]\n{chunk_text}".encode("utf-8"),
                b"chunk_index": str(chunk_num).encode("utf-8"),
                b"vector": vector_bytes,
            }
            pipe.hset(doc_key, mapping=mapping)

        set_key = f"pageintel:docs:{page_id}"
        if doc_keys:
            pipe.sadd(set_key, *[k.encode("utf-8") for k in doc_keys])

        meta_key = f"pageintel:meta:{page_id}"
        meta["chunk_count"] = existing_count + len(chunks)
        meta["last_updated_at"] = time.time()
        meta["has_ocr"] = True
        pipe.set(meta_key, json.dumps(meta).encode("utf-8"))

        pipe.execute()

        return {
            "success": True,
            "page_id": page_id,
            "new_chunks_count": len(chunks),
            "total_chunks_count": meta["chunk_count"],
            "message": f"Successfully appended {len(chunks)} {source_tag} chunks in Redis vector store.",
        }

    def set_page_ttl(self, page_id: str, ttl_seconds: int = 300) -> Dict[str, Any]:
        """Decreases the lifespan of all keys associated with a page to ttl_seconds (default 5 minutes).
        
        When the TTL expires, Redis automatically evicts the keys and drops them from the vector index.
        """
        set_key = f"pageintel:docs:{page_id}"
        meta_key = f"pageintel:meta:{page_id}"
        history_key = f"pageintel:chat:{page_id}"

        # Get all chunk keys
        raw_keys = self.redis_client.smembers(set_key)
        pipe = self.redis_client.pipeline()

        count = 0
        for raw_k in raw_keys:
            pipe.expire(raw_k, ttl_seconds)
            count += 1

        pipe.expire(set_key, ttl_seconds)
        pipe.expire(meta_key, ttl_seconds)
        pipe.expire(history_key, ttl_seconds)
        pipe.execute()

        return {
            "success": True,
            "page_id": page_id,
            "ttl_seconds": ttl_seconds,
            "expired_keys_count": count + 3,
            "message": f"Lifespan for page {page_id} decreased to {ttl_seconds} seconds (5 minutes).",
        }

    def _persist_page(self, page_id: str):
        """Removes expiration from an active page's keys so it stays persistent while active."""
        set_key = f"pageintel:docs:{page_id}"
        meta_key = f"pageintel:meta:{page_id}"
        history_key = f"pageintel:chat:{page_id}"

        raw_keys = self.redis_client.smembers(set_key)
        pipe = self.redis_client.pipeline()
        for raw_k in raw_keys:
            pipe.persist(raw_k)
        pipe.persist(set_key)
        pipe.persist(meta_key)
        pipe.persist(history_key)
        pipe.execute()

    def similarity_search(
        self,
        page_id: str,
        query: str,
        top_k: int = 4,
    ) -> List[Document]:
        """Performs vector similarity search in Redis restricted to the given page_id."""
        # Embed query using remote HF Endpoint
        query_vector = self.embeddings.embed_query(query)
        query_bytes = np.array(query_vector, dtype=np.float32).tobytes()

        # Build RediSearch Vector Search Query filtered by page_id tag
        escaped_page_id = page_id.replace("-", "\\-")
        search_query = (
            Query(f"(@page_id:{{{escaped_page_id}}})=>[KNN {top_k} @vector $vec_param AS score]")
            .sort_by("score")
            .return_fields("content", "chunk_index", "url", "title", "score")
            .paging(0, top_k)
            .dialect(2)
        )

        params = {"vec_param": query_bytes}

        try:
            results = self.redis_client.ft(self.index_name).search(search_query, query_params=params)
        except Exception as e:
            print(f"[RedisPageVectorStore] Search query failed: {e}")
            return []

        docs = []
        for doc in results.docs:
            content = getattr(doc, "content", "")
            if isinstance(content, bytes):
                content = content.decode("utf-8", errors="ignore")
            metadata = {
                "chunk_index": getattr(doc, "chunk_index", 0),
                "url": getattr(doc, "url", ""),
                "title": getattr(doc, "title", ""),
                "score": float(getattr(doc, "score", 0.0)),
                "page_id": page_id,
            }
            docs.append(Document(page_content=content, metadata=metadata))

        return docs

    def get_chat_history(self, page_id: str) -> List[Dict[str, str]]:
        """Retrieve conversational chat history for a page from Redis."""
        key = f"pageintel:chat:{page_id}"
        raw = self.redis_client.get(key)
        if not raw:
            return []
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return []

    def append_chat_turn(self, page_id: str, user_msg: str, assistant_msg: str):
        """Append a question/answer turn to the page's conversation history."""
        key = f"pageintel:chat:{page_id}"
        history = self.get_chat_history(page_id)
        history.append({"role": "user", "content": user_msg})
        history.append({"role": "assistant", "content": assistant_msg})
        # Keep last 10 turns (20 messages)
        history = history[-20:]
        self.redis_client.set(key, json.dumps(history).encode("utf-8"))
