from dataiku.customwebapp import *

# Access the parameters that end-users filled in using webapp config
# For example, for a parameter called "input_dataset"
# input_dataset = get_webapp_config()["input_dataset"]

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# v2 — trajectory timeline

import logging
from datetime import datetime

import dataiku
import pandas as pd
from flask import request, jsonify, send_from_directory

from agentobservability.trace_adapter import extract_trace
from agentobservability.trace_parser import parse_trace, comparison_io
from agentobservability.metrics import compute_metrics
from agentobservability.rules import apply_rules

logger = logging.getLogger(__name__)

_WEBAPP_DIR = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------

@app.route("/static/<filename>")
def serve_static(filename):
    return send_from_directory(_WEBAPP_DIR, filename)


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def _load_dataframe(dataset_name: str) -> pd.DataFrame:
    if not dataset_name:
        return pd.DataFrame()
    try:
        ds = dataiku.Dataset(dataset_name)
        chunks = list(ds.iter_dataframes(chunksize=500))
        if not chunks:
            return pd.DataFrame()
        return pd.concat(chunks, ignore_index=True)
    except Exception as e:
        logger.warning("Could not load dataset %r: %s", dataset_name, e)
        return pd.DataFrame()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Trajectory helpers
# ---------------------------------------------------------------------------

def _parse_iso_ms(s):
    """Return milliseconds since epoch for an ISO-8601 UTC timestamp string."""
    if not s:
        return None
    try:
        s_clean = s.replace("Z", "").replace("+00:00", "")
        fmt = "%Y-%m-%dT%H:%M:%S.%f" if "." in s_clean else "%Y-%m-%dT%H:%M:%S"
        dt = datetime.strptime(s_clean, fmt)
        return int((dt - datetime(1970, 1, 1)).total_seconds() * 1000)
    except Exception:
        return None


def _normalize_trajectory(traj):
    """Convert raw dku_llm_mesh_extracted_trajectory dict to a frontend-ready structure."""
    if not traj or not isinstance(traj, dict):
        return None
    agent_begin_ms = _parse_iso_ms(traj.get("begin"))
    steps = []
    for step in (traj.get("agentLoop") or []):
        step_begin_ms = _parse_iso_ms(step.get("begin"))
        offset_ms = None
        if agent_begin_ms is not None and step_begin_ms is not None:
            offset_ms = max(0, step_begin_ms - agent_begin_ms)
        steps.append({
            "type": step.get("type"),
            "tool_name": step.get("toolName"),
            "tool_type": step.get("toolType"),
            "tool_function_name": step.get("toolFunctionName"),
            "input": step.get("inputContent"),
            "output": step.get("outputContent"),
            "begin": step.get("begin"),
            "end": step.get("end"),
            "duration_ms": step.get("durationMs") or 0,
            "offset_ms": offset_ms,
        })
    return {
        "agent_id": traj.get("agentId"),
        "begin": traj.get("begin"),
        "end": traj.get("end"),
        "duration_ms": traj.get("durationMs") or 0,
        "input": traj.get("input"),
        "output": traj.get("output"),
        "steps": steps,
    }


def _analyze_raw_trace(raw):
    """Analyze a raw trace or trajectory dict into the frontend response shape."""
    if not isinstance(raw, dict):
        raise ValueError("Expected a JSON object")

    # Auto-detect: trajectory JSON contains "agentLoop"
    if "agentLoop" in raw:
        trajectory = _normalize_trajectory(raw)
        return {
            "message": None,
            "metrics": {},
            "findings": [],
            "trajectory": trajectory,
            "initial_input": trajectory["input"],
            "final_answer": trajectory["output"],
        }

    parsed = parse_trace(raw)
    total_ms = int(parsed.root.duration_ms) if parsed.root else 0
    metrics = compute_metrics(parsed, total_ms)
    findings = apply_rules(parsed, metrics)

    return {
        "message": None,
        "metrics": metrics,
        "findings": [
            {"severity": f.severity, "code": f.code, "message": f.message, "evidence": f.evidence}
            for f in findings
        ],
        "trajectory": None,
        **comparison_io(parsed),
    }


@app.route("/api/analyze-trace", methods=["POST"])
def api_analyze_trace():
    """Analyze a raw trace or trajectory JSON pasted directly by the user (no dataset needed)."""
    try:
        body = request.get_json(force=True, silent=True)
        if not body:
            return jsonify({"error": "Invalid or empty JSON body"}), 400

        # Accept {"trace": {...}} or the raw object directly
        raw = body.get("trace") if isinstance(body, dict) and "trace" in body else body

        if not isinstance(raw, dict):
            return jsonify({"error": "Expected a JSON object"}), 400

        return jsonify(_analyze_raw_trace(raw))
    except Exception as e:
        logger.exception("Error in /api/analyze-trace")
        return jsonify({"error": str(e)}), 500


@app.route("/api/datasets")
def api_datasets():
    """List all datasets in the current DSS project."""
    try:
        client = dataiku.api_client()
        project = client.get_default_project()
        names = sorted([ds["name"] for ds in project.list_datasets()])
        return jsonify({"datasets": names})
    except Exception as e:
        logger.exception("Error in /api/datasets")
        return jsonify({"error": str(e)}), 500


@app.route("/api/llms")
def api_llms():
    """List LLMs available in the current DSS project via LLM Mesh."""
    try:
        client = dataiku.api_client()
        project = client.get_default_project()
        llms = []
        for item in project.list_llms():
            item_type = getattr(item, "type", "") or ""
            if "EMBEDDING" in item_type.upper() or "embed" in item.id.lower():
                continue
            llms.append({"id": item.id, "description": getattr(item, "description", None) or item.id})
        return jsonify({"llms": llms})
    except Exception as e:
        logger.exception("Error in /api/llms")
        return jsonify({"error": str(e)}), 500


def _build_explain_prompt(metrics: dict, findings: list, message_info: dict) -> str:
    total_ms = metrics.get("total_duration_ms", 0)
    total_s = round(total_ms / 1000, 2)
    provider_ms = metrics.get("provider_inference_ms", 0)
    tool_ms = metrics.get("tool_execution_ms", 0)
    overhead_ms = metrics.get("mesh_overhead_ms", 0)

    lines = ["Here is an AI agent execution trace to explain to a business user:"]
    lines.append("")

    if message_info:
        lines.append(f"- Agent: {message_info.get('agent_id', 'Unknown')}")
        lines.append(f"- Status: {message_info.get('status', 'Unknown')}")
    lines.append(f"- Total duration: {total_s}s")

    if total_ms > 0:
        lines.append(f"- Time at LLM provider (inference): {round(provider_ms/1000, 2)}s ({round(provider_ms/total_ms*100, 1)}%)")
        lines.append(f"- Time executing tools: {round(tool_ms/1000, 2)}s ({round(tool_ms/total_ms*100, 1)}%)")
        lines.append(f"- Infrastructure overhead: {round(overhead_ms/1000, 2)}s ({round(overhead_ms/total_ms*100, 1)}%)")

    iters = metrics.get("iteration_count", 0)
    unique_tools = metrics.get("unique_tools_called", 0)
    tokens_in = metrics.get("tokens_in", 0)
    tokens_out = metrics.get("tokens_out", 0)
    cost = metrics.get("estimated_cost", 0)

    lines.append(f"- Reasoning iterations: {iters}")
    lines.append(f"- Unique tools called: {unique_tools}")
    if tokens_in or tokens_out:
        lines.append(f"- Tokens: {tokens_in} input / {tokens_out} output")
    if cost:
        lines.append(f"- Estimated cost: ${cost:.4f}")

    tool_breakdown = metrics.get("tool_breakdown", [])
    if tool_breakdown:
        lines.append("")
        lines.append("Tool calls:")
        for tool in tool_breakdown:
            pct = round(tool["total_duration_ms"] / total_ms * 100, 1) if total_ms > 0 else 0
            lines.append(f"  - {tool['name']}: {tool['call_count']} call(s), "
                         f"{round(tool['total_duration_ms']/1000, 2)}s ({pct}% of total time)")

    if findings:
        lines.append("")
        lines.append("Detected issues:")
        for f in findings:
            lines.append(f"  - [{f['severity']}] {f['code']}: {f['message']}")
    else:
        lines.append("")
        lines.append("No performance anomalies detected.")

    lines.append("")
    lines.append(
        "Write a concise business-friendly explanation in 3-4 short paragraphs. "
        "Cover: (1) what the agent did and whether it succeeded, "
        "(2) where the time was spent and whether that is expected, "
        "(3) any issues detected and what they mean practically for the end user. "
        "Use plain language — avoid technical jargon. Interpret the numbers, don't just repeat them."
    )
    return "\n".join(lines)


@app.route("/api/explain", methods=["POST"])
def api_explain():
    """Generate a business-friendly LLM explanation of a trace."""
    try:
        body = request.get_json(force=True, silent=True) or {}
        llm_id = (body.get("llm_id") or "").strip()
        if not llm_id:
            return jsonify({"error": "llm_id is required"}), 400

        metrics = body.get("metrics") or {}
        findings = body.get("findings") or []
        message_info = body.get("message") or {}

        client = dataiku.api_client()
        project = client.get_default_project()
        llm = project.get_llm(llm_id)

        query = llm.new_completion()
        query.with_message(
            "You are an expert at explaining AI agent behavior to business users. "
            "Given execution metrics and performance data, produce a clear, concise explanation. "
            "Be factual and constructive — flag issues plainly and explain what they mean for the end user.",
            role="system"
        )
        query.with_message(_build_explain_prompt(metrics, findings, message_info), role="user")

        response = query.execute()
        explanation_text = getattr(response, "text", None)
        is_ok = getattr(response, "success", None)
        if is_ok is None:
            is_ok = getattr(response, "ok", None)

        logger.info("LLM explain response: success=%s, ok=%s, text_len=%s",
                    getattr(response, "success", "N/A"),
                    getattr(response, "ok", "N/A"),
                    len(explanation_text) if explanation_text else 0)

        if not explanation_text:
            err_detail = getattr(response, "errorMessage", None) or getattr(response, "error", None) or f"success={is_ok}"
            logger.error("LLM explain call returned no text: %s", err_detail)
            return jsonify({"error": f"LLM returned no text ({err_detail})"}), 500

        return jsonify({"explanation": explanation_text})
    except Exception as e:
        logger.exception("Error in /api/explain")
        return jsonify({"error": str(e)}), 500


@app.route("/api/filters")
def api_filters():
    try:
        dataset_name = request.args.get("dataset", "").strip()
        df = _load_dataframe(dataset_name)
        if df.empty:
            return jsonify({"users": [], "agents": [], "conversations": []})

        def unique(col):
            if col not in df.columns:
                return []
            return sorted(df[col].dropna().astype(str).unique().tolist())

        return jsonify({
            "users": unique("user"),
            "agents": unique("agent_id"),
            "conversations": unique("conversation_id"),
        })
    except Exception as e:
        logger.exception("Error in /api/filters")
        return jsonify({"error": str(e)}), 500


@app.route("/api/messages")
def api_messages():
    try:
        dataset_name = request.args.get("dataset", "").strip()
        df = _load_dataframe(dataset_name)
        if df.empty:
            return jsonify([])

        user_f = request.args.get("user", "").strip()
        agent_f = request.args.get("agent", "").strip()
        conv_f = request.args.get("conversation_id", "").strip()

        if user_f and "user" in df.columns:
            df = df[df["user"].astype(str) == user_f]
        if agent_f and "agent_id" in df.columns:
            df = df[df["agent_id"].astype(str) == agent_f]
        if conv_f and "conversation_id" in df.columns:
            df = df[df["conversation_id"].astype(str) == conv_f]

        messages = []
        for idx, row in df.iterrows():
            try:
                row.name = idx
                norm = extract_trace(row)
                messages.append({
                    "message_id": norm["message_id"],
                    "conversation_id": norm["conversation_id"],
                    "user": norm["user"],
                    "agent_id": norm["agent_id"],
                    "begin_time": norm["begin_time"],
                    "duration_ms": norm["duration_ms"],
                    "status": norm["status"],
                })
            except Exception as e:
                logger.warning("Skipping row %s: %s", idx, e)

        return jsonify(messages)
    except Exception as e:
        logger.exception("Error in /api/messages")
        return jsonify({"error": str(e)}), 500


@app.route("/api/compare")
def api_compare():
    """Compare multiple traces from the same dataset side by side."""
    try:
        dataset_name = request.args.get("dataset", "").strip()
        ids_raw = request.args.get("ids", "").strip()
        if not ids_raw:
            return jsonify({"error": "ids parameter is required"}), 400
        message_ids = [i.strip() for i in ids_raw.split(",") if i.strip()]
        if len(message_ids) < 2:
            return jsonify({"error": "At least 2 message IDs are required"}), 400

        df = _load_dataframe(dataset_name)
        if df.empty:
            return jsonify({"error": "Dataset not found or empty"}), 404

        id_to_norm = {}
        for idx, row in df.iterrows():
            try:
                row.name = idx
                norm = extract_trace(row)
                mid = norm["message_id"]
                if mid in message_ids and mid not in id_to_norm:
                    id_to_norm[mid] = norm
            except Exception:
                pass

        results = []
        for mid in message_ids:
            norm = id_to_norm.get(mid)
            if norm is None:
                results.append({"message": {"message_id": mid}, "error": f"Message '{mid}' not found"})
                continue
            metrics = {}
            findings = []
            io = {"initial_input": None, "final_answer": None}
            trajectory = _normalize_trajectory(norm["trajectory"])
            if norm["trace"] is not None:
                parsed = parse_trace(norm["trace"])
                total_ms = norm["duration_ms"] or (int(parsed.root.duration_ms) if parsed.root else 0)
                metrics = compute_metrics(parsed, total_ms)
                findings = apply_rules(parsed, metrics)
                io = comparison_io(parsed)
            if trajectory:
                if trajectory["input"] is not None:
                    io["initial_input"] = trajectory["input"]
                if trajectory["output"] is not None:
                    io["final_answer"] = trajectory["output"]
            results.append({
                **io,
                "trajectory": trajectory,
                "message": {
                    "message_id": norm["message_id"],
                    "conversation_id": norm["conversation_id"],
                    "user": norm["user"],
                    "agent_id": norm["agent_id"],
                    "begin_time": norm["begin_time"],
                    "end_time": norm["end_time"],
                    "duration_ms": norm["duration_ms"],
                    "status": norm["status"],
                },
                "metrics": metrics,
                "findings": [
                    {"severity": f.severity, "code": f.code, "message": f.message, "evidence": f.evidence}
                    for f in findings
                ],
            })

        return jsonify({"traces": results})
    except Exception as e:
        logger.exception("Error in /api/compare")
        return jsonify({"error": str(e)}), 500


@app.route("/api/compare-pasted", methods=["POST"])
def api_compare_pasted():
    """Compare multiple pasted traces side by side."""
    try:
        body = request.get_json(force=True, silent=True)
        if not body:
            return jsonify({"error": "Invalid or empty JSON body"}), 400

        raw_traces = body.get("traces") if isinstance(body, dict) and "traces" in body else body
        if not isinstance(raw_traces, list):
            return jsonify({"error": "Expected an array of traces"}), 400
        if len(raw_traces) < 2:
            return jsonify({"error": "At least 2 traces are required"}), 400

        traces = []
        for idx, raw in enumerate(raw_traces):
            try:
                traces.append(_analyze_raw_trace(raw))
            except Exception as e:
                traces.append({
                    "message": None,
                    "metrics": {},
                    "findings": [],
                    "trajectory": None,
                    "error": f"Trace {idx + 1}: {e}",
                })

        return jsonify({"traces": traces})
    except Exception as e:
        logger.exception("Error in /api/compare-pasted")
        return jsonify({"error": str(e)}), 500


@app.route("/api/trace/<message_id>")
def api_trace(message_id):
    try:
        dataset_name = request.args.get("dataset", "").strip()
        df = _load_dataframe(dataset_name)
        if df.empty:
            return jsonify({"error": "No data available"}), 404

        norm = None
        for idx, row in df.iterrows():
            try:
                row.name = idx
                candidate = extract_trace(row)
                if candidate["message_id"] == message_id:
                    norm = candidate
                    break
            except Exception:
                pass

        if norm is None:
            return jsonify({"error": f"Message '{message_id}' not found"}), 404

        trajectory = _normalize_trajectory(norm.get("trajectory"))

        if norm["trace"] is None and trajectory is None:
            return jsonify({"error": "No trace or trajectory data for this message"}), 404

        metrics = {}
        findings = []
        if norm["trace"] is not None:
            parsed = parse_trace(norm["trace"])
            metrics = compute_metrics(parsed, norm["duration_ms"])
            findings = apply_rules(parsed, metrics)

        return jsonify({
            "message": {
                "message_id": norm["message_id"],
                "conversation_id": norm["conversation_id"],
                "user": norm["user"],
                "agent_id": norm["agent_id"],
                "begin_time": norm["begin_time"],
                "end_time": norm["end_time"],
                "duration_ms": norm["duration_ms"],
                "status": norm["status"],
            },
            "metrics": metrics,
            "findings": [
                {
                    "severity": f.severity,
                    "code": f.code,
                    "message": f.message,
                    "evidence": f.evidence,
                }
                for f in findings
            ],
            "trajectory": trajectory,
        })
    except Exception as e:
        logger.exception("Error in /api/trace/%s", message_id)
        return jsonify({"error": str(e)}), 500
