const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync("webapps/webapp/app.js", "utf8");
const elements = Object.fromEntries(["compare-agent-io", "sec-compare-drill", "compare-drill-name", "compare-drill-body"]
  .map(id => [id, { innerHTML: "", style: {}, scrollIntoView() {} }]));
const context = vm.createContext({
  document: { getElementById: id => elements[id], querySelectorAll: () => [] },
  escHtml: value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  toStr: value => value == null ? "" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value),
  fmsDuration: value => value + " ms", activeDrillTool: null
});
vm.runInContext(source.slice(source.indexOf("  function _toolHasIoDiff("),
                             source.indexOf("  function renderCompareFindings(")), context);
const traces = [
  { initial_input: "Same query", final_answer: "Answer <one>", metrics: { tool_breakdown: [
    { name: "search", calls: [{ inputs: { q: "first" }, outputs: "First output", duration_ms: 1 },
                             { inputs: {}, outputs: false, duration_ms: 2 }] }] } },
  { initial_input: "Same query", final_answer: "Answer two", trajectory: { steps: [
    { type: "TOOLCALL", tool_name: "search", input: { q: "second" }, output: "Second output", duration_ms: 3 }] } },
  { initial_input: "Same query", final_answer: null, metrics: {} }
];
context.renderCompareAgentIo(traces);
assert.equal((elements["compare-agent-io"].innerHTML.match(/<th scope="row">/g) || []).length, 3);
assert.match(elements["compare-agent-io"].innerHTML, /Answer &lt;one&gt;/);
context.toggleCompareDrill("search", traces, null);
const html = elements["compare-drill-body"].innerHTML;
assert.equal((html.match(/<th scope="row">/g) || []).length, 6);
for (const value of ["first", "second", "First output", "Second output", "Answer two", "Final answer not captured", "Not called", "false"]) {
  assert.ok(html.includes(value), value);
}
assert.ok(!html.includes("T1 vs"));
assert.equal(context._toolHasIoDiff("search", traces), true);
context.toggleCompareDrill("search", traces, null);
assert.equal(elements["sec-compare-drill"].style.display, "none");
console.log("Comparison UI checks passed (three traces, repeated/missing calls, trajectories, escaping, final answers).");
