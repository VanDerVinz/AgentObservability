from typing import Optional
from agentobservability.trace_parser import ParsedTrace, Span


def _is_non_empty_usage(usage_metadata: dict) -> bool:
    return bool(usage_metadata)


def _compute_mesh_overhead(root: Optional[Span]) -> float:
    """Per mesh_query span: duration minus its first direct mesh_llm_call child duration."""
    if root is None:
        return 0.0
    total = 0.0

    def walk(span: Span) -> None:
        nonlocal total
        if span.span_type == "mesh_query":
            llm_child_ms = 0.0
            for child in span.children:
                if child.span_type in ("mesh_llm_call_streamed", "mesh_llm_call"):
                    llm_child_ms = child.duration_ms
                    break
            overhead = span.duration_ms - llm_child_ms
            if overhead > 0:
                total += overhead
        for child in span.children:
            walk(child)

    walk(root)
    return total


def _compute_provider_inference(root: Optional[Span]) -> float:
    """
    Sum LLM call durations, but only for calls that are NOT inside an agent_tool_calls span.
    This avoids double-counting with tool_execution when a tool internally calls the LLM.
    """
    if root is None:
        return 0.0
    total = 0.0

    def walk(span: Span, inside_tools: bool) -> None:
        nonlocal total
        if span.span_type == "agent_tool_calls":
            inside_tools = True
        if (
            not inside_tools
            and span.span_type in ("mesh_llm_call_streamed", "mesh_llm_call")
            and _is_non_empty_usage(span.usage_metadata)
        ):
            total += span.duration_ms
        for child in span.children:
            walk(child, inside_tools)

    walk(root, False)
    return total


def _compute_tool_execution(root: Optional[Span]) -> float:
    """Sum durations of top-level agent_tool_calls spans only.
    Spans nested inside a managed_tool_call are excluded to avoid double-counting
    when a tool internally invokes a sub-agent with its own tool calls."""
    if root is None:
        return 0.0
    total = 0.0

    def walk(span: Span, inside_managed_tool: bool) -> None:
        nonlocal total
        if span.span_type == "managed_tool_call":
            for child in span.children:
                walk(child, True)
        elif span.span_type == "agent_tool_calls":
            if not inside_managed_tool:
                total += span.duration_ms
            # don't recurse: duration already includes all nested spans
        else:
            for child in span.children:
                walk(child, inside_managed_tool)

    walk(root, False)
    return total


def compute_metrics(parsed: ParsedTrace, total_duration_ms: int) -> dict:
    """Compute all metrics from a ParsedTrace. Pure function — no DSS imports."""
    flat = parsed.flat_spans

    provider_inference_ms = _compute_provider_inference(parsed.root)
    tool_execution_ms = _compute_tool_execution(parsed.root)

    mesh_overhead_ms = _compute_mesh_overhead(parsed.root)

    tokens_in = 0
    tokens_out = 0
    estimated_cost = 0.0
    for s in flat:
        if s.span_type in ("mesh_llm_call_streamed", "mesh_llm_call") and _is_non_empty_usage(s.usage_metadata):
            tokens_in  += s.usage_metadata.get("inputTokens")  or s.usage_metadata.get("promptTokens")     or 0
            tokens_out += s.usage_metadata.get("outputTokens") or s.usage_metadata.get("completionTokens") or 0
            estimated_cost += float(s.usage_metadata.get("estimatedCost", 0) or 0)

    tool_breakdown = {}
    for tc in parsed.executed_tool_calls:
        name = tc["name"]
        if name not in tool_breakdown:
            tool_breakdown[name] = {"name": name, "call_count": 0, "total_duration_ms": 0.0, "calls": []}
        tool_breakdown[name]["call_count"] += 1
        tool_breakdown[name]["total_duration_ms"] += tc["duration_ms"]
        tool_breakdown[name]["calls"].append({
            "duration_ms": round(tc["duration_ms"]),
            "inputs": tc["inputs"],
            "outputs": tc["outputs"],
        })

    for entry in tool_breakdown.values():
        entry["total_duration_ms"] = round(entry["total_duration_ms"])

    iteration_count = sum(1 for s in flat if s.span_type == "agent_iteration")
    agent_call_count = sum(1 for s in flat if s.span_type == "agent_call")
    unique_tools_called = len({tc["name"] for tc in parsed.executed_tool_calls})

    root_ts = parsed.root.begin_ts if parsed.root else 0.0
    call_sequence = [
        {
            "type": entry["type"],
            "label": entry["label"],
            "offset_ms": round((entry["begin_ts"] - root_ts) * 1000) if root_ts and entry["begin_ts"] else 0,
            "duration_ms": round(entry["duration_ms"]),
            "inputs": entry["inputs"],
            "outputs": entry["outputs"],
        }
        for entry in parsed.call_sequence
    ]

    return {
        "total_duration_ms": total_duration_ms,
        "mesh_overhead_ms": round(mesh_overhead_ms),
        "provider_inference_ms": round(provider_inference_ms),
        "tool_execution_ms": round(tool_execution_ms),
        "unique_tools_called": unique_tools_called,
        "agents": parsed.agents,
        "call_sequence": call_sequence,
        "agent_call_count": agent_call_count,
        "iteration_count": iteration_count,
        "executed_tool_calls": parsed.executed_tool_calls,
        "tool_breakdown": list(tool_breakdown.values()),
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "estimated_cost": round(estimated_cost, 6),
    }
