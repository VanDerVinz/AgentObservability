import json
import logging

import pandas as pd

logger = logging.getLogger(__name__)


def _parse_json_field(val):
    if val is None:
        return None
    if isinstance(val, float) and pd.isna(val):
        return None
    if isinstance(val, (dict, list)):
        return val
    try:
        return json.loads(val)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


def _safe_str(val, default=""):
    if val is None:
        return default
    if isinstance(val, float) and pd.isna(val):
        return default
    return str(val)


def _safe_int(val, default=0):
    if val is None:
        return default
    if isinstance(val, float) and pd.isna(val):
        return default
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def extract_trace(row: pd.Series) -> dict:
    """
    Single schema adaptation point — only modify this function if the dataset schema changes.
    Returns a normalized dict with keys: conversation_id, message_id, user, agent_id,
    begin_time, end_time, duration_ms, status, trace (parsed JSON or None).
    """
    message_id = row.get("message_id")
    if message_id is None or (isinstance(message_id, float) and pd.isna(message_id)):
        message_id = str(row.name)

    return {
        "conversation_id": _safe_str(row.get("conversation_id")),
        "message_id": str(message_id),
        "user": _safe_str(row.get("user")),
        "agent_id": _safe_str(row.get("agent_id")),
        "agent_version": _safe_str(row.get("agent_version")),
        "begin_time": _safe_str(row.get("begin_time")),
        "end_time": _safe_str(row.get("end_time")),
        "duration_ms": _safe_int(row.get("duration_ms")),
        "status": _safe_str(row.get("status")),
        "trace": _parse_json_field(row.get("dku_trace")),
        "trajectory": _parse_json_field(row.get("dku_llm_mesh_extracted_trajectory")),
    }
