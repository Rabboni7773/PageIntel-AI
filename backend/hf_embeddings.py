"""
Hugging Face Inference Endpoint Embeddings
Calls remote Hugging Face Inference API / endpoints without downloading or installing any model weights locally.
"""

import os
from typing import List, Optional
import numpy as np
from huggingface_hub import InferenceClient
from langchain_core.embeddings import Embeddings


class HuggingFaceEndpointEmbeddings(Embeddings):
    """LangChain-compatible Embeddings implementation using Hugging Face Inference Endpoint.
    
    Zero local weights downloaded - all vectorization is performed via remote API.
    """

    def __init__(
        self,
        model: str = "sentence-transformers/all-MiniLM-L6-v2",
        token: Optional[str] = None,
        dimensions: int = 384,
    ):
        self.model = model
        self.token = token or os.getenv("HUGGINGFACEHUB_API_TOKEN") or os.getenv("HF_TOKEN")
        self.dimensions = dimensions
        self.client = InferenceClient(token=self.token)

    def _normalize_vector(self, raw_result) -> List[float]:
        arr = np.array(raw_result, dtype=np.float32)
        # If output is 2D (sequence_length, dim), apply mean pooling
        if arr.ndim == 2:
            arr = np.mean(arr, axis=0)
        # Flatten if needed
        flat = arr.flatten().tolist()
        if len(flat) > self.dimensions:
            flat = flat[:self.dimensions]
        elif len(flat) < self.dimensions:
            flat = flat + [0.0] * (self.dimensions - len(flat))
        return flat

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        """Embed a list of text chunks using Hugging Face Inference API."""
        if not texts:
            return []

        embeddings: List[List[float]] = []
        batch_size = 16

        for i in range(0, len(texts), batch_size):
            batch = texts[i : i + batch_size]
            try:
                # Call HF Inference API feature_extraction
                raw_response = self.client.feature_extraction(batch, model=self.model)
                arr = np.array(raw_response, dtype=np.float32)

                # Batch output: could be 2D (batch_size, dim) or 3D (batch_size, seq_len, dim)
                if arr.ndim == 3:
                    # Apply mean pooling across tokens (axis 1)
                    arr = np.mean(arr, axis=1)

                for item in arr:
                    embeddings.append(item.tolist())
            except Exception as e:
                # In case batch fails or model is loading, fallback to single calls or raise
                for text in batch:
                    embeddings.append(self.embed_query(text))

        return embeddings

    def embed_query(self, text: str) -> List[float]:
        """Embed a single query string using Hugging Face Inference API."""
        try:
            raw_response = self.client.feature_extraction(text, model=self.model)
            return self._normalize_vector(raw_response)
        except Exception as e:
            # Fallback retry with options
            raise RuntimeError(f"Failed to generate embedding from Hugging Face Endpoint: {e}")
