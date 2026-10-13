import ast
import json
from pathlib import Path
import sys
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python-lib"))
from agentobservability.trace_parser import parse_trace, comparison_io


def node(name, inputs=None, outputs=None, children=None, attributes=None):
    return dict(name=name, inputs=inputs or {}, outputs=outputs or {},
                children=children or [], attributes=attributes or {})


class ComparisonTests(unittest.TestCase):
    def test_outer_response_wins_over_tools_and_subagents(self):
        raw = node("DKU_AGENT_HUB_QUERY", {"messages": [
            {"role": "user", "text": "Earlier query"},
            {"role": "assistant", "text": "Earlier answer"},
            {"role": "user", "text": "Same query"},
        ]}, {"text": "Final answer"}, [
            node("DKU_MANAGED_TOOL_CALL", outputs={"text": "Tool result"}, children=[
                node("DKU_LLM_MESH_LLM_CALL", outputs={"text": "Subagent answer"},
                     attributes={"llmProvider": "SAVED_MODEL_AGENT"})])])
        self.assertEqual(comparison_io(parse_trace(raw)),
                         {"initial_input": "Same query", "final_answer": "Final answer"})

    def test_missing_final_answer_does_not_use_internal_inference(self):
        raw = node("root", children=[node("DKU_AGENT_ITERATION", children=[
            node("DKU_LLM_MESH_LLM_CALL", outputs={"text": "Thinking"})]),
            node("DKU_MANAGED_TOOL_CALL", outputs={"text": "Tool result"})])
        self.assertIsNone(comparison_io(parse_trace(raw))["final_answer"])

    def test_outer_saved_agent_fallback_and_empty_answer(self):
        raw = node("root", children=[node("DKU_LLM_MESH_LLM_CALL_STREAMED",
                   {"messages": [{"role": "user", "content": "Question"}]},
                   {"text": ""}, attributes={"llmProvider": "SAVED_MODEL_AGENT"})])
        self.assertEqual(comparison_io(parse_trace(raw)),
                         {"initial_input": "Question", "final_answer": ""})

    def test_real_trace(self):
        sample = ROOT / "trace.json"
        if not sample.exists():
            self.skipTest("Local sample unavailable")
        raw = json.loads(sample.read_text())
        self.assertEqual(comparison_io(parse_trace(raw))["final_answer"], raw["outputs"]["text"])

    def test_backend_contract_for_pasted_and_dataset_traces(self):
        # Load pure route/helper definitions without needing the DSS runtime.
        tree = ast.parse((ROOT / "webapps/webapp/backend.py").read_text())
        names = {"_parse_iso_ms", "_normalize_trajectory", "_analyze_raw_trace", "api_compare"}
        functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
        for n in functions:
            n.decorator_list = []
        from datetime import datetime
        env = dict(datetime=datetime, parse_trace=parse_trace, comparison_io=comparison_io,
                   compute_metrics=lambda *args: {}, apply_rules=lambda *args: [],
                   jsonify=lambda obj: obj)
        exec(compile(ast.Module(body=functions, type_ignores=[]), "backend_helpers", "exec"), env)
        raw = node("root", {"messages": [{"role": "user", "text": "Query"}]}, {"text": "Answer"})
        pasted = env["_analyze_raw_trace"](raw)
        self.assertEqual(pasted["final_answer"], "Answer")
        trajectory = dict(agentLoop=[], input="Query", output="Trajectory answer")
        self.assertEqual(env["_analyze_raw_trace"](trajectory)["final_answer"], "Trajectory answer")
        norms = [dict(message_id="a", trace=raw, trajectory=None),
                 dict(message_id="b", trace=raw, trajectory=trajectory)]
        for norm in norms:
            norm.update(duration_ms=0, conversation_id="", user="", agent_id="",
                        begin_time="", end_time="", status="OK")
        rows = [types.SimpleNamespace(data=n) for n in norms]
        env.update(request=types.SimpleNamespace(args={"dataset": "sample", "ids": "b,a"}),
                   _load_dataframe=lambda _: types.SimpleNamespace(empty=False,
                       iterrows=lambda: enumerate(rows)), extract_trace=lambda row: row.data)
        result = env["api_compare"]()["traces"]
        self.assertEqual([t["message"]["message_id"] for t in result], ["b", "a"])
        self.assertEqual([t["final_answer"] for t in result], ["Trajectory answer", "Answer"])


if __name__ == "__main__":
    unittest.main()
