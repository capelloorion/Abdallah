"""The LangGraph skeleton (ADR-0009): ``retrieve → answer`` (+ an optional tool loop).

Shape a project copies for its own graphs:

- **Typed state** (``GraphState``): the message history (``add_messages`` reducer) and the
  retrieved context.
- **Nodes are small async functions** that do one I/O each, with telemetry *inside* the node.
- **Retrieval is deterministic** — it runs before the model on every turn, so grounding never
  depends on the model deciding to call a tool.
- **The model is injected** (``chat_model=``) or taken from the ``client.py`` seam; tests pass
  a fake. Same for the retriever.
- **Tools are optional**: pass ``tools=[...]`` to add a ``ToolNode`` loop
  (``answer → tools → answer`` until the model stops calling tools).

``ask()`` is the non-streaming entry point; ``streaming.py`` streams the same compiled graph.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Annotated, Any, TypedDict

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, SystemMessage
from langchain_core.tools import BaseTool
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition

from app.ai.config import get_ai_settings
from app.ai.prompts import render_prompt
from app.ai.telemetry import extract_usage, model_call_span, record_retrieval
from app.ai.tools.retrieve import (
    DEFAULT_TOP_K,
    RetrievedChunk,
    Retriever,
    chunk_title,
    get_default_retriever,
)


class GraphState(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]
    context: list[RetrievedChunk]


def format_context(chunks: list[RetrievedChunk]) -> str:
    """Numbered context block for the system prompt (the model cites ``[n]``)."""
    if not chunks:
        return "(no context available)"
    return "\n\n".join(
        f"[{i}] ({c.get('source') or 'unknown'})\n{c.get('content', '')}"
        for i, c in enumerate(chunks, start=1)
    )


def last_user_text(messages: list[AnyMessage]) -> str:
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            content = message.content
            return content if isinstance(content, str) else str(content)
    return ""


# A follow-up is searched together with the turn before it; that turn is cut to this many
# characters so the query stays small whatever was written earlier (a cost and injection bound).
MAX_PREVIOUS_TURN_CHARS = 1000


def retrieval_query(messages: list[AnyMessage]) -> str:
    """What to search for: the new question, preceded by the previous *user* turn when there is one.

    A follow-up such as "And on the api side?" means nothing alone; searched together with the turn
    before it, it finds the conversation's topic (decision Q3: no extra model call, no extra node).
    Only user turns are used — never the assistant's earlier answer, which could echo anything.
    A blank turn, or the same question asked again after a failed answer (the failed question stays
    stored), adds nothing, so the search looks one user turn further back.
    The query is search input only: it is never logged (rule 70).
    """
    question = last_user_text(messages)
    if not question:
        return ""
    user_turns = [m for m in messages if isinstance(m, HumanMessage)]
    for message in reversed(user_turns[:-1]):
        previous = _message_text(message).strip()
        if previous and previous != question.strip():
            return f"{previous[:MAX_PREVIOUS_TURN_CHARS]}\n{question}"
    return question


def _message_text(message: Any) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    # Content blocks → join the text parts.
    parts = [b.get("text", "") if isinstance(b, dict) else str(b) for b in content]
    return "".join(parts)


def build_graph(
    *,
    chat_model: BaseChatModel | None = None,
    retriever: Retriever | None = None,
    tools: list[BaseTool] | None = None,
    top_k: int = DEFAULT_TOP_K,
    deployment_label: str | None = None,
) -> Any:
    """Compile the ``retrieve → answer`` graph. Nothing connects until the first run."""

    def _model() -> BaseChatModel:
        if chat_model is not None:
            return chat_model
        from app.ai.client import get_chat_model

        return get_chat_model()

    def _label() -> str:
        return deployment_label or get_ai_settings().chat_deployment or "unknown"

    bound_tools = list(tools or [])

    async def retrieve(state: GraphState) -> GraphState:
        question = retrieval_query(state.get("messages", []))
        active = retriever if retriever is not None else get_default_retriever()
        started = time.perf_counter()
        try:
            chunks = await active.retrieve(question, top_k) if question else []
        except Exception:
            record_retrieval((time.perf_counter() - started) * 1000, "error")
            raise
        return {"context": chunks}

    async def answer(state: GraphState) -> GraphState:
        model = _model()
        if bound_tools:
            model = model.bind_tools(bound_tools)
        system = SystemMessage(
            content=render_prompt("system", context=format_context(state.get("context", [])))
        )
        with model_call_span(_label()) as call:
            response = await model.ainvoke([system, *state.get("messages", [])])
            call.set_usage(response)
        return {"messages": [response]}

    graph = StateGraph(GraphState)
    graph.add_node("retrieve", retrieve)
    graph.add_node("answer", answer)
    graph.add_edge(START, "retrieve")
    graph.add_edge("retrieve", "answer")
    if bound_tools:
        graph.add_node("tools", ToolNode(bound_tools))
        graph.add_conditional_edges("answer", tools_condition, {"tools": "tools", END: END})
        graph.add_edge("tools", "answer")
    else:
        graph.add_edge("answer", END)
    return graph.compile()


class Citation(TypedDict):
    """What a user sees for a source: the document's title and its path."""

    title: str
    path: str


@dataclass
class Answer:
    text: str
    citations: list[Citation] = field(default_factory=list)
    context: list[RetrievedChunk] = field(default_factory=list)
    input_tokens: int | None = None
    output_tokens: int | None = None


def citations_for(chunks: list[RetrievedChunk]) -> list[Citation]:
    """One citation per distinct source path, in retrieval order (the first chunk's title wins).

    Titles and paths are document content: never log them (rule 70).
    """
    seen: set[str] = set()
    citations: list[Citation] = []
    for chunk in chunks:
        path = chunk.get("source") or ""
        if path and path not in seen:
            seen.add(path)
            citations.append({"title": chunk_title(chunk), "path": path})
    return citations


async def ask(
    graph: Any,
    question: str,
    *,
    history: list[AnyMessage] | None = None,
    config: dict[str, Any] | None = None,
) -> Answer:
    """Run the graph once for ``question`` (with optional prior turns) and collect the answer."""
    inputs: GraphState = {
        "messages": [*(history or []), HumanMessage(content=question)],
        "context": [],
    }
    result = await graph.ainvoke(inputs, config)
    final = result["messages"][-1]
    text = _message_text(final) if isinstance(final, AIMessage) else str(final)
    input_tokens, output_tokens = extract_usage(final)
    context = result.get("context", []) or []
    return Answer(
        text=text,
        citations=citations_for(context),
        context=context,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )
