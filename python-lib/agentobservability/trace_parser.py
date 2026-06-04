from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional
import logging

logger = logging.getLogger(__name__)

# Mapping from raw span name to internal span_type.
# Any span name not listed here is classified as "custom_tool_span" (user-defined) or "unknown".
SPAN_TYPE_MAP = {
    "DKU_LLM_MESH_COMPLETION_QUERY_STREAMED": "mesh_query",
    "DKU_LLM_MESH_COMPLETION_QUERY": "mesh_query",
    "DKU_LLM_MESH_QUERY_ENFORCEMENT": "enforcement",
    "DKU_LLM_MESH_RESPONSE_ENFORCEMENT": "enforcement",
    "DKU_LLM_MESH_LLM_CALL_STREAMED": "mesh_llm_call_streamed",
    "DKU_LLM_MESH_LLM_CALL": "mesh_llm_call",
    "DKU_LLM_MESH_LLM_CALL_STREAMED_FIRST_CHUNK": "event",
    "DKU_LLM_MESH_LLM_CALL_STREAMED_STREAM_COMPLETE": "event",
    "DKU_AGENT_CALL": "agent_call",
    "DKU_AGENT_ITERATION": "agent_iteration",
    "DKU_AGENT_LLM_CALL": "agent_llm_call",
    "DKU_AGENT_TOOL_CALLS": "agent_tool_calls",
    "DKU_MANAGED_TOOL_CALL": "managed_tool_call",
    "PYTHON_AGENT_TOOL_CALL": "python_tool_call",
}


@dataclass
class Span:
    name: str
    span_type: str          # see SPAN_TYPE_MAP for values; "custom_tool_span" for unknown DKU spans
    begin_ts: float         # epoch seconds
    end_ts: float
    duration_ms: float
    attributes: dict = field(default_factory=dict)
    inputs: dict = field(default_factory=dict)
    outputs: dict = field(default_factory=dict)
    usage_metadata: dict = field(default_factory=dict)  # direct field on the span (not in attributes)
    children: List["Span"] = field(default_factory=list)


@dataclass
class Event:
    name: str
    timestamp_ts: float
    attributes: dict = field(default_factory=dict)


@dataclass
class ParsedTrace:
    root: Optional[Span]
    flat_spans: List[Span]
    events: List[Event]
    agents: List[dict]          # one dict per agent call: {llmId, inputs, outputs}
    available_tools: List[str]  # tool function names from completionQuerySettings
    executed_tool_calls: List[dict]  # one dict per DKU_MANAGED_TOOL_CALL span


def _parse_ts(ts_str) -> float:
    if not ts_str:
        return 0.0
    try:
        s = str(ts_str).replace("Z", "+00:00")
        return datetime.fromisoformat(s).timestamp()
    except (ValueError, AttributeError):
        return 0.0


def _parse_node(
    node: dict,
    flat_spans: List[Span],
    events: List[Event],
) -> Optional[Span]:
    """Recursively parse a trace node. Events are appended to `events`; returns Span or None."""
    if not isinstance(node, dict):
        return None

    node_type = node.get("type", "span")
    name = node.get("name", "unknown")

    if node_type == "event":
        ts = _parse_ts(node.get("timestamp", ""))
        events.append(Event(
            name=name,
            timestamp_ts=ts,
            attributes=node.get("attributes") or {},
        ))
        return None

    span_type = SPAN_TYPE_MAP.get(name)
    if span_type is None:
        span_type = "custom_tool_span" if name else "unknown"

    begin_ts = _parse_ts(node.get("begin", ""))
    end_ts = _parse_ts(node.get("end", ""))

    duration_raw = node.get("duration")
    try:
        duration_ms = float(duration_raw) if duration_raw is not None else 0.0
    except (TypeError, ValueError):
        duration_ms = max(0.0, (end_ts - begin_ts) * 1000)

    span = Span(
        name=name,
        span_type=span_type,
        begin_ts=begin_ts,
        end_ts=end_ts,
        duration_ms=duration_ms,
        attributes=node.get("attributes") or {},
        inputs=node.get("inputs") or {},
        outputs=node.get("outputs") or {},
        usage_metadata=node.get("usageMetadata") or {},
        children=[],
    )
    flat_spans.append(span)

    for child_node in node.get("children") or []:
        try:
            child_span = _parse_node(child_node, flat_spans, events)
            if child_span is not None:
                span.children.append(child_span)
        except Exception as e:
            logger.warning("Skipping child node under %r: %s", name, e)

    return span


def _collect_available_tools(flat_spans: List[Span]) -> List[str]:
    """Collect unique tool function names from completionQuerySettings across all LLM call spans."""
    seen = {}
    for span in flat_spans:
        if span.span_type not in ("mesh_llm_call_streamed", "mesh_llm_call"):
            continue
        try:
            cq = span.attributes.get("completionQuery") or {}
            settings = cq.get("completionQuerySettings") or {}
            for tool in settings.get("tools") or []:
                fn_name = (tool.get("function") or {}).get("name", "")
                if fn_name:
                    seen[fn_name] = True
        except Exception:
            pass
    return list(seen.keys())


def _collect_executed_tool_calls(root: Optional[Span]) -> List[dict]:
    """Collect top-level managed tool calls only.

    A tool call is "top-level" when it is not nested inside another managed_tool_call.
    Nested calls (e.g. a sub-agent tool internally invoking more tools) are excluded
    because their duration is already included in the parent tool's duration.
    """
    if root is None:
        return []
    calls = []

    def walk(span: Span, inside_managed_tool: bool) -> None:
        if span.span_type == "managed_tool_call":
            if not inside_managed_tool:
                attrs = span.attributes or {}
                name = attrs.get("toolFunctionName") or attrs.get("toolId") or span.name
                inputs = (span.inputs or {}).get("input", span.inputs or {})
                outputs = (span.outputs or {}).get("output", "")
                calls.append({
                    "name": name,
                    "tool_id": attrs.get("toolId", ""),
                    "tool_call_id": attrs.get("toolCallId", ""),
                    "duration_ms": span.duration_ms,
                    "inputs": inputs,
                    "outputs": outputs,
                })
            for child in span.children:
                walk(child, True)
        else:
            for child in span.children:
                walk(child, inside_managed_tool)

    walk(root, False)
    return calls


def _collect_agents(flat_spans: List[Span]) -> List[dict]:
    """Collect agent calls from LLM call spans that target a saved-model agent."""
    result = []
    for span in flat_spans:
        if span.span_type not in ("mesh_llm_call_streamed", "mesh_llm_call"):
            continue
        attrs = span.attributes or {}
        if attrs.get("llmProvider") == "SAVED_MODEL_AGENT":
            llm_id = attrs.get("llmId", "")
            if llm_id:
                result.append({
                    "llmId": llm_id,
                    "inputs": span.inputs,
                    "outputs": span.outputs,
                })
    return result


def parse_trace(trace_json: dict) -> ParsedTrace:
    """Parse a dku_trace JSON dict into a ParsedTrace. Never raises — bad nodes are skipped."""
    flat_spans: List[Span] = []
    events: List[Event] = []
    root = None

    try:
        root = _parse_node(trace_json, flat_spans, events)
    except Exception as e:
        logger.error("Failed to parse trace root: %s", e)

    return ParsedTrace(
        root=root,
        flat_spans=flat_spans,
        events=events,
        agents=_collect_agents(flat_spans),
        available_tools=_collect_available_tools(flat_spans),
        executed_tool_calls=_collect_executed_tool_calls(root),
    )
