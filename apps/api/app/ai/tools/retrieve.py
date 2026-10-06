"""Retrieval over Azure AI Search (ADR-0009, team decision D7).

``AzureSearchRetriever`` embeds the question with the configured embedding deployment and runs a
**hybrid** query (keyword + vector, ``VectorizedQuery``) against the index the ingestion job
built (``app/ai/ingest.py`` owns the field names below). The graph calls it deterministically
before the model; it is not a model-callable tool.

The SDK's sync ``SearchClient`` runs in a worker thread (``asyncio.to_thread``) — the async
client would add ``aiohttp`` to the image for no gain at this call rate.

``NullRetriever`` is what a project without retrieval gets: the graph still answers, with an
empty context. Nothing here connects at construction.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import PurePosixPath
from typing import Any, NotRequired, Protocol, TypedDict

from langchain_core.embeddings import Embeddings

from app.ai.config import AISettings, get_ai_settings
from app.ai.telemetry import record_retrieval
from app.logging_config import get_logger

# Field names shared with app/ai/ingest.py (the index definition).
ID_FIELD = "id"
CONTENT_FIELD = "content"
SOURCE_FIELD = "source"
TITLE_FIELD = "title"
VECTOR_FIELD = "content_vector"
DEFAULT_TOP_K = 5
TITLE_MAX_CHARS = 200

# Control characters become a space; bidi embedding/override/isolate characters are dropped
# (they let a title display differently from what it says — spoofing, not code execution).
_TITLE_TRANSLATION: dict[int, str | None] = {
    **dict.fromkeys([*range(0, 32), 127], " "),
    **dict.fromkeys([*range(0x202A, 0x202F), *range(0x2066, 0x206A)], None),
}


class RetrievedChunk(TypedDict):
    id: str
    content: str
    source: str
    score: float | None
    # The document title stored at ingestion. Absent/empty for chunks indexed before the field
    # existed; use ``chunk_title`` to read it with the file-name fallback.
    title: NotRequired[str]


def fallback_title(source: str) -> str:
    """The file name of a source path — the title when a document has no heading."""
    return PurePosixPath(source.replace("\\", "/")).name or source


def clean_title(value: str) -> str:
    """A title safe to show: no control or bidi-override characters, single spaces, at most
    ``TITLE_MAX_CHARS`` characters. Applied at ingestion AND on read, so a stale or externally
    written index document cannot return an oversized or spoofed title. It is still text, not
    HTML: consumers must render it as plain text.
    """
    return " ".join(value.translate(_TITLE_TRANSLATION).split())[:TITLE_MAX_CHARS].strip()


def chunk_title(chunk: RetrievedChunk) -> str:
    """The chunk's document title, else the file name of its source (always cleaned)."""
    return clean_title(chunk.get("title") or "") or clean_title(
        fallback_title(chunk.get("source") or "")
    )


class Retriever(Protocol):
    async def retrieve(self, query: str, top_k: int = DEFAULT_TOP_K) -> list[RetrievedChunk]: ...


class NullRetriever:
    """No retrieval configured — always empty context."""

    async def retrieve(self, query: str, top_k: int = DEFAULT_TOP_K) -> list[RetrievedChunk]:
        return []


def build_search_credential(settings: AISettings) -> Any:
    """API key in dev when provided, otherwise the app's identity (Search Index Data Reader)."""
    if settings.search_api_key:
        from azure.core.credentials import AzureKeyCredential

        return AzureKeyCredential(settings.search_api_key)
    from azure.identity import DefaultAzureCredential

    return DefaultAzureCredential()


def build_search_client(
    settings: AISettings | None = None, *, index_name: str | None = None
) -> Any:
    """A ``SearchClient`` for the configured (or given) index. Lazy — no request is made."""
    from azure.search.documents import SearchClient

    s = settings or get_ai_settings()
    s.require_search()
    return SearchClient(
        endpoint=s.search_endpoint,
        index_name=index_name or s.search_index,
        credential=build_search_credential(s),
    )


class AzureSearchRetriever:
    """Hybrid retrieval: keyword + vector query over one index."""

    def __init__(
        self,
        search_client: Any,
        embeddings: Embeddings,
        *,
        id_field: str = ID_FIELD,
        content_field: str = CONTENT_FIELD,
        source_field: str = SOURCE_FIELD,
        title_field: str = TITLE_FIELD,
        vector_field: str = VECTOR_FIELD,
    ) -> None:
        self._client = search_client
        self._embeddings = embeddings
        self._id_field = id_field
        self._content_field = content_field
        self._source_field = source_field
        self._title_field = title_field
        self._vector_field = vector_field

    def _search(self, query: str, vector: list[float], top_k: int) -> list[dict[str, Any]]:
        from azure.search.documents.models import VectorizedQuery

        results = self._client.search(
            search_text=query,
            vector_queries=[
                VectorizedQuery(vector=vector, k_nearest_neighbors=top_k, fields=self._vector_field)
            ],
            select=[self._id_field, self._content_field, self._source_field, self._title_field],
            top=top_k,
        )
        return [dict(r) for r in results]

    async def retrieve(self, query: str, top_k: int = DEFAULT_TOP_K) -> list[RetrievedChunk]:
        started = time.perf_counter()
        try:
            vector = await self._embeddings.aembed_query(query)
            raw = await asyncio.to_thread(self._search, query, vector, top_k)
        except Exception:
            record_retrieval((time.perf_counter() - started) * 1000, "error")
            raise
        chunks: list[RetrievedChunk] = [
            {
                "id": str(r.get(self._id_field, "")),
                "content": str(r.get(self._content_field, "")),
                "source": str(r.get(self._source_field, "")),
                "score": r.get("@search.score"),
                "title": str(r.get(self._title_field) or ""),
            }
            for r in raw
        ]
        record_retrieval((time.perf_counter() - started) * 1000, "ok", hits=len(chunks))
        return chunks


_default: Retriever | None = None


def get_default_retriever() -> Retriever:
    """The retriever the graph uses when none is injected: Azure AI Search when both the
    search index and an embedding deployment are configured, otherwise ``NullRetriever``."""
    global _default
    if _default is None:
        settings = get_ai_settings()
        if settings.has_search and settings.has_embeddings:
            from app.ai.client import get_embeddings

            _default = AzureSearchRetriever(build_search_client(settings), get_embeddings())
            get_logger("app.ai.retrieve").info(
                "retriever configured", kind="azure_search", index=settings.search_index
            )
        else:
            _default = NullRetriever()
            get_logger("app.ai.retrieve").info("retriever configured", kind="null")
    return _default


def _reset_for_tests() -> None:
    global _default
    _default = None
