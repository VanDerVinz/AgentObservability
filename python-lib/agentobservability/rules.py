import hashlib
import json
from dataclasses import dataclass
from typing import List

from agentobservability.trace_parser import ParsedTrace

TOOL_DOMINANT_THRESHOLD  = 0.60    # fraction of total time
THROTTLE_MS_PER_TOKEN    = 300.0   # ms per output token; above this suggests provider queuing
HIGH_TTFT_MS             = 3000.0  # ms from LLM call start to first chunk; above this suggests provider queuing


@dataclass
class Finding:
    severity: str   # "WARNING" | "INFO"
    code: str
    message: str
    evidence: dict


def get_thresholds_from_config(config: dict) -> dict:
    return {
        "tool_dominant_threshold": float(
            config.get("tool_dominant_threshold", TOOL_DOMINANT_THRESHOLD)
        ),
    }


def _rule_tool_dominant(
    parsed: ParsedTrace, metrics: dict, thresholds: dict
) -> List[Finding]:
    findings = []
    total_ms = metrics.get("total_duration_ms", 0)
    threshold = thresholds.get("tool_dominant_threshold", TOOL_DOMINANT_THRESHOLD)

    if total_ms <= 0 or not parsed.executed_tool_calls:
        return findings

    tool_totals: dict = {}
    for tc in parsed.executed_tool_calls:
        name = tc["name"]
        tool_totals[name] = tool_totals.get(name, 0.0) + tc["duration_ms"]

    for name, duration_ms in tool_totals.items():
        pct = duration_ms / total_ms
        if pct > threshold:
            findings.append(Finding(
                severity="WARNING",
                code="TOOL_DOMINANT",
                message=(
                    f"Tool '{name}' représente {round(pct * 100, 1)}% "
                    f"du temps total ({round(duration_ms)}ms)"
                ),
                evidence={
                    "tool_name": name,
                    "duration_ms": round(duration_ms),
                    "pct": round(pct * 100, 1),
                    "threshold_pct": round(threshold * 100, 1),
                },
            ))
    return findings


def _hash_input(inputs) -> str:
    try:
        if isinstance(inputs, dict):
            return hashlib.md5(
                json.dumps(inputs, sort_keys=True, ensure_ascii=False).encode()
            ).hexdigest()
        return hashlib.md5(str(inputs).encode()).hexdigest()
    except Exception:
        return ""


def _rule_tool_redundancy(
    parsed: ParsedTrace, metrics: dict, thresholds: dict
) -> List[Finding]:
    findings = []
    if not parsed.executed_tool_calls:
        return findings

    groups: dict = {}
    for tc in parsed.executed_tool_calls:
        key = (tc["name"], _hash_input(tc["inputs"]))
        groups.setdefault(key, []).append(tc)

    for (name, _), calls in groups.items():
        if len(calls) > 1:
            try:
                preview = json.dumps(calls[0]["inputs"], ensure_ascii=False)[:200]
            except Exception:
                preview = str(calls[0]["inputs"])[:200]
            findings.append(Finding(
                severity="INFO",
                code="TOOL_REDUNDANCY",
                message=f"Tool '{name}' appelé {len(calls)}x avec les mêmes arguments",
                evidence={
                    "tool_name": name,
                    "count": len(calls),
                    "input_preview": preview,
                },
            ))
    return findings


def _rule_throttle_suspected(
    parsed: ParsedTrace, metrics: dict, thresholds: dict
) -> List[Finding]:
    """
    Fires when duration_ms / output_tokens exceeds the threshold on a LLM call span.
    A high ms-per-token ratio means the provider spent most of the time queuing, not
    generating — characteristic of rate-limit throttling or cold-start delays.
    Requires at least 10 output tokens to produce a reliable estimate.
    """
    findings = []
    threshold = thresholds.get("throttle_ms_per_token", THROTTLE_MS_PER_TOKEN)

    for span in parsed.flat_spans:
        if span.span_type not in ("mesh_llm_call_streamed", "mesh_llm_call"):
            continue
        if not span.usage_metadata:
            continue
        output_tokens = int(span.usage_metadata.get("outputTokens") or span.usage_metadata.get("completionTokens") or 0)
        if output_tokens < 10:
            continue
        ratio = span.duration_ms / output_tokens
        if ratio > threshold:
            findings.append(Finding(
                severity="WARNING",
                code="THROTTLE_SUSPECTED",
                message=(
                    f"{round(ratio)}ms per output token "
                    f"({round(span.duration_ms)}ms for {output_tokens} tokens)"
                    f" — provider throttling suspected"
                ),
                evidence={
                    "duration_ms": round(span.duration_ms),
                    "output_tokens": output_tokens,
                    "ms_per_token": round(ratio, 1),
                    "threshold_ms_per_token": threshold,
                },
            ))
    return findings


def _rule_high_ttft(
    parsed: ParsedTrace, metrics: dict, thresholds: dict
) -> List[Finding]:
    """
    Fires when the time from a streaming LLM call start to its first chunk event
    exceeds the threshold.  A high TTFT with a normal total duration suggests the
    provider queued the request before starting inference (rate-limit hold or
    cold-start), rather than the model being slow throughout.
    """
    findings = []
    threshold = thresholds.get("high_ttft_ms", HIGH_TTFT_MS)

    first_chunk_events = [
        e for e in parsed.events
        if "FIRST_CHUNK" in e.name and e.timestamp_ts > 0
    ]
    if not first_chunk_events:
        return findings

    for span in parsed.flat_spans:
        if span.span_type != "mesh_llm_call_streamed":
            continue
        if span.begin_ts <= 0 or span.end_ts <= span.begin_ts:
            continue

        # Match the earliest FIRST_CHUNK event that falls inside this span's window
        matching = [
            e for e in first_chunk_events
            if span.begin_ts <= e.timestamp_ts <= span.end_ts
        ]
        if not matching:
            continue

        ttft_ms = (min(e.timestamp_ts for e in matching) - span.begin_ts) * 1000
        if ttft_ms > threshold:
            findings.append(Finding(
                severity="WARNING",
                code="HIGH_TTFT",
                message=(
                    f"Time to first token: {round(ttft_ms)}ms "
                    f"(threshold: {round(threshold)}ms)"
                    f" — provider may be queuing requests"
                ),
                evidence={
                    "ttft_ms": round(ttft_ms),
                    "threshold_ms": threshold,
                    "llm_call_duration_ms": round(span.duration_ms),
                },
            ))
    return findings


def apply_rules(
    parsed: ParsedTrace, metrics: dict, thresholds: dict = None
) -> List[Finding]:
    """Run all Level-A deterministic rules. Returns findings sorted WARNING first."""
    if thresholds is None:
        thresholds = {}

    findings: List[Finding] = []
    findings.extend(_rule_tool_dominant(parsed, metrics, thresholds))
    findings.extend(_rule_tool_redundancy(parsed, metrics, thresholds))
    findings.extend(_rule_throttle_suspected(parsed, metrics, thresholds))
    findings.extend(_rule_high_ttft(parsed, metrics, thresholds))

    severity_order = {"WARNING": 0, "INFO": 1}
    findings.sort(key=lambda f: severity_order.get(f.severity, 99))
    return findings
