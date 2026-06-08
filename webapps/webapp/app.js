(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────────────────────
  let currentTraceJson   = null;
  let currentTrajectory  = null;
  let currentDetailStepIdx = null;
  let selectedIds   = new Set();
  let compareData   = null;
  let activeDrillTool = null;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const viewList   = document.getElementById("view-list");
  const viewDetail = document.getElementById("view-detail");

  const inpDataset   = document.getElementById("inp-dataset");

  const selUser  = document.getElementById("sel-user");
  const selAgent = document.getElementById("sel-agent");
  const selConv  = document.getElementById("sel-conv");

  const btnApply = document.getElementById("btn-apply");
  const btnReset = document.getElementById("btn-reset");
  const btnBack  = document.getElementById("btn-back");
  const btnCopy  = document.getElementById("btn-copy-trace");

  const modalPaste      = document.getElementById("modal-paste");
  const btnPasteTrace   = document.getElementById("btn-paste-trace");
  const btnModalClose   = document.getElementById("btn-modal-close");
  const btnModalCancel  = document.getElementById("btn-modal-cancel");
  const btnModalAnalyze = document.getElementById("btn-modal-analyze");
  const traceInputs     = document.getElementById("trace-inputs");
  const btnAddTrace     = document.getElementById("btn-add-trace");
  const pasteError      = document.getElementById("paste-error");

  const chkExplain  = document.getElementById("chk-explain");
  const llmPicker   = document.getElementById("llm-picker");
  const selLlm      = document.getElementById("sel-llm");
  const secExplain  = document.getElementById("sec-explain");
  const explainLoad = document.getElementById("explain-loading");
  const explainErr  = document.getElementById("explain-error");
  const explainBody = document.getElementById("explain-body");
  const btnRegen    = document.getElementById("btn-regen");

  const listStatus   = document.getElementById("list-status");
  const listError    = document.getElementById("list-error");
  const messagesBody = document.getElementById("messages-body");

  const detailBreadcrumb = document.getElementById("detail-breadcrumb");
  const detailError   = document.getElementById("detail-error");
  const detailLoading = document.getElementById("detail-loading");
  const detailContent = document.getElementById("detail-content");

  const viewCompare       = document.getElementById("view-compare");
  const btnCompare        = document.getElementById("btn-compare");
  const btnCompareBack    = document.getElementById("btn-compare-back");
  const compareLoading    = document.getElementById("compare-loading");
  const compareError      = document.getElementById("compare-error");
  const compareContent    = document.getElementById("compare-content");
  const compareBreadcrumb = document.getElementById("compare-breadcrumb");

  // ── Routing ────────────────────────────────────────────────────────────────
  function showView(name) {
    viewList.style.display    = name === "list"    ? "" : "none";
    viewDetail.style.display  = name === "detail"  ? "" : "none";
    viewCompare.style.display = name === "compare" ? "" : "none";
  }

  // ── Utils ──────────────────────────────────────────────────────────────────
  function api(endpoint) {
    return getWebAppBackendUrl(endpoint);
  }

  function currentDataset() {
    return inpDataset.value.trim();
  }

  function fmsDuration(ms) {
    if (ms == null || ms === 0) return "0 ms";
    if (ms < 1000) return ms + " ms";
    return (ms / 1000).toFixed(2) + " s";
  }

  function fmTime(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  function truncate(str, n) {
    if (!str) return "";
    return str.length > n ? str.slice(0, n) + "…" : str;
  }

  function statusBadge(status) {
    const cls = status === "OK" || status === "SUCCESS" ? "badge-success"
              : status === "ERROR" || status === "FAILED" ? "badge-error"
              : "badge-neutral";
    return `<span class="badge ${cls}">${status || "—"}</span>`;
  }

  function setListError(msg) {
    if (msg) {
      listError.textContent = msg;
      listError.style.display = "";
    } else {
      listError.style.display = "none";
    }
  }

  function setDetailError(msg) {
    if (msg) {
      detailError.textContent = msg;
      detailError.style.display = "";
    } else {
      detailError.style.display = "none";
    }
  }

  function populateSelect(sel, values) {
    const prev = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    values.forEach(function (v) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    });
    if (prev) sel.value = prev;
  }

  function createTraceEntry(value, idx) {
    const wrap = document.createElement("div");
    wrap.className = "trace-entry";

    const head = document.createElement("div");
    head.className = "trace-entry-head";

    const title = document.createElement("span");
    title.className = "trace-entry-title";
    title.textContent = "Trace " + idx;
    head.appendChild(title);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn-sm-ghost";
    remove.textContent = "Remove";
    remove.addEventListener("click", function () {
      if (!traceInputs) return;
      if (traceInputs.children.length <= 1) {
        const ta = wrap.querySelector(".trace-textarea");
        if (ta) ta.value = "";
        return;
      }
      wrap.remove();
      refreshTraceEntryLabels();
      refreshPasteActionLabel();
    });
    head.appendChild(remove);

    const ta = document.createElement("textarea");
    ta.className = "trace-textarea";
    ta.placeholder = "Paste dku_trace or dku_llm_mesh_extracted_trajectory JSON here…";
    ta.spellcheck = false;
    ta.value = value || "";

    wrap.appendChild(head);
    wrap.appendChild(ta);
    return wrap;
  }

  function refreshTraceEntryLabels() {
    if (!traceInputs) return;
    Array.from(traceInputs.children).forEach(function (entry, idx) {
      const title = entry.querySelector(".trace-entry-title");
      if (title) title.textContent = "Trace " + (idx + 1);
    });
  }

  function refreshPasteActionLabel() {
    if (!btnModalAnalyze || !traceInputs) return;
    const count = Array.from(traceInputs.querySelectorAll(".trace-textarea"))
      .filter(function (ta) { return ta.value.trim().length > 0; })
      .length;
    btnModalAnalyze.textContent = count > 1 ? "Compare" : "Analyze";
  }

  function resetTraceInputs(count) {
    if (!traceInputs) return;
    traceInputs.innerHTML = "";
    const initialCount = Math.max(1, count || 1);
    for (let i = 0; i < initialCount; i++) {
      traceInputs.appendChild(createTraceEntry("", i + 1));
    }
    refreshPasteActionLabel();
  }

  function getTracePayloads() {
    if (!traceInputs) return [];
    return Array.from(traceInputs.querySelectorAll(".trace-textarea"))
      .map(function (ta) { return ta.value.trim(); })
      .filter(function (value) { return value.length > 0; })
      .map(function (raw, idx) {
        try {
          return { value: JSON.parse(raw), idx: idx + 1 };
        } catch (e) {
          return { error: "Trace " + (idx + 1) + ": invalid JSON: " + e.message };
        }
      });
  }

  // ── Paste trace modal ─────────────────────────────────────────────────────
  function openPasteModal() {
    pasteError.style.display = "none";
    modalPaste.style.display = "";
    if (traceInputs && !traceInputs.children.length) {
      resetTraceInputs(1);
    } else {
      refreshPasteActionLabel();
    }
    const first = traceInputs && traceInputs.querySelector(".trace-textarea");
    if (first) first.focus();
  }

  function closePasteModal() {
    modalPaste.style.display = "none";
  }

  async function analyzePaste() {
    pasteError.style.display = "none";
    const payloads = getTracePayloads();
    if (!payloads.length) {
      pasteError.textContent = "Please paste at least one trace JSON first.";
      pasteError.style.display = "";
      return;
    }
    const firstError = payloads.find(function (item) { return item.error; });
    if (firstError) {
      pasteError.textContent = firstError.error;
      pasteError.style.display = "";
      return;
    }

    const traces = payloads.map(function (item) { return item.value; });
    const isCompare = traces.length > 1;

    btnModalAnalyze.disabled = true;
    btnModalAnalyze.textContent = isCompare ? "Comparing…" : "Analyzing…";

    try {
      const endpoint = isCompare ? "api/compare-pasted" : "api/analyze-trace";
      const body = isCompare ? { traces: traces } : { trace: traces[0] };
      const resp = await fetch(api(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || "HTTP " + resp.status);
      closePasteModal();
      resetTraceInputs(1);
      if (isCompare) {
        loadPastedCompare(data.traces || []);
      } else {
        currentTraceJson = data;
        showView("detail");
        setDetailError(null);
        detailLoading.style.display = "none";
        detailContent.style.display = "none";
        renderDetail(data);
      }
    } catch (e) {
      pasteError.textContent = "Analysis failed: " + e.message;
      pasteError.style.display = "";
    } finally {
      btnModalAnalyze.disabled = false;
      refreshPasteActionLabel();
    }
  }

  // ── Load LLMs ─────────────────────────────────────────────────
  async function loadLLMs() {
    if (!selLlm) return;
    try {
      const resp = await fetch(api("api/llms"));
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      selLlm.innerHTML = '<option value="">— select a model —</option>';
      (data.llms || []).forEach(function (llm) {
        const opt = document.createElement("option");
        opt.value = llm.id;
        opt.textContent = llm.description || llm.id;
        selLlm.appendChild(opt);
      });
      if (data.llms && data.llms.length === 1) selLlm.value = data.llms[0].id;
    } catch (e) {
      if (selLlm) selLlm.innerHTML = '<option value="">Could not load models</option>';
    }
  }

  // ── AI Explanation ─────────────────────────────────────────────
  function safeMarkdown(text) {
    const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .split(/\n\n+/)
      .map(function (p) { return "<p>" + p.replace(/\n/g, "<br>") + "</p>"; })
      .join("");
  }

  async function generateExplanation() {
    if (!secExplain || !explainLoad || !explainErr || !explainBody) return;
    if (!chkExplain || !chkExplain.checked) return;
    if (!selLlm || !selLlm.value) {
      explainErr.textContent = "Please select a model in the toolbar.";
      explainErr.style.display = "";
      explainBody.innerHTML = "";
      secExplain.style.display = "";
      return;
    }
    if (!currentTraceJson) return;

    explainErr.style.display = "none";
    explainBody.innerHTML = "";
    explainLoad.style.display = "";
    secExplain.style.display = "";

    try {
      const resp = await fetch(api("api/explain"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          llm_id: selLlm.value,
          metrics: currentTraceJson.metrics,
          findings: currentTraceJson.findings,
          message: currentTraceJson.message || null,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || data.error) throw new Error(data.error || "HTTP " + resp.status);
      explainBody.innerHTML = safeMarkdown(data.explanation || "");
    } catch (e) {
      explainErr.textContent = "Explanation failed: " + e.message;
      explainErr.style.display = "";
    } finally {
      explainLoad.style.display = "none";
    }
  }

  // ── Load datasets ──────────────────────────────────────────────────────────
  async function loadDatasets() {
    try {
      const resp = await fetch(api("api/datasets"));
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      inpDataset.innerHTML = '<option value="">— select a dataset —</option>';
      (data.datasets || []).forEach(function (name) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        inpDataset.appendChild(opt);
      });
      // Auto-select when there is exactly one dataset
      if (data.datasets && data.datasets.length === 1) {
        inpDataset.value = data.datasets[0];
        loadFilters().then(loadMessages);
      }
    } catch (e) {
      setListError("Could not load dataset list: " + e.message);
    }
  }

  // ── Load filters ───────────────────────────────────────────────────────────
  async function loadFilters() {
    const ds = currentDataset();
    if (!ds) return;
    try {
      const params = new URLSearchParams({ dataset: ds });
      const resp = await fetch(api("api/filters") + "?" + params);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      populateSelect(selUser,  data.users  || []);
      populateSelect(selAgent, data.agents || []);
      populateSelect(selConv,  data.conversations || []);
    } catch (e) {
      setListError("Could not load filters: " + e.message);
    }
  }

  // ── Load messages ──────────────────────────────────────────────────────────
  async function loadMessages() {
    const ds = currentDataset();
    if (!ds) {
      messagesBody.innerHTML = `<tr><td colspan="7" class="table-placeholder">Select a dataset above to load messages.</td></tr>`;
      listStatus.textContent = "";
      return;
    }

    setListError(null);
    listStatus.textContent = "";
    messagesBody.innerHTML = `<tr id="row-loading"><td colspan="8" class="table-placeholder">
      <div class="spinner-inline"></div> Loading messages…</td></tr>`;

    const params = new URLSearchParams({ dataset: ds });
    if (selUser.value)  params.set("user", selUser.value);
    if (selAgent.value) params.set("agent", selAgent.value);
    if (selConv.value)  params.set("conversation_id", selConv.value);

    try {
      const resp = await fetch(api("api/messages") + "?" + params);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      renderMessages(data);
    } catch (e) {
      messagesBody.innerHTML = "";
      setListError("Could not load messages: " + e.message);
    }
  }

  function updateCompareBtn() {
    if (!btnCompare) return;
    const n = selectedIds.size;
    btnCompare.disabled = n < 2;
    btnCompare.textContent = n >= 2 ? "Compare (" + n + ")" : "Compare";
  }

  function renderMessages(messages) {
    messagesBody.innerHTML = "";

    // Remove stale selections no longer in results
    const newIds = new Set(messages.map(function(m) { return m.message_id; }));
    selectedIds.forEach(function(id) { if (!newIds.has(id)) selectedIds.delete(id); });
    updateCompareBtn();

    if (!messages.length) {
      messagesBody.innerHTML = '<tr><td colspan="8" class="table-placeholder">No messages match the selected filters.</td></tr>';
      listStatus.textContent = "";
      return;
    }

    listStatus.textContent = messages.length + " message" + (messages.length > 1 ? "s" : "");

    messages.forEach(function(msg) {
      const tr = document.createElement("tr");
      tr.className = "clickable-row";
      tr.dataset.id = msg.message_id;
      if (selectedIds.has(msg.message_id)) tr.classList.add("row-selected");

      // Checkbox cell — must be created via DOM to preserve event listeners
      const chkTd = document.createElement("td");
      chkTd.className = "chk-cell";
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.className = "row-checkbox";
      chk.checked = selectedIds.has(msg.message_id);
      chk.addEventListener("change", function(e) {
        if (e.target.checked) {
          selectedIds.add(msg.message_id);
          tr.classList.add("row-selected");
        } else {
          selectedIds.delete(msg.message_id);
          tr.classList.remove("row-selected");
        }
        updateCompareBtn();
      });
      chk.addEventListener("click", function(e) { e.stopPropagation(); });
      chkTd.appendChild(chk);
      tr.appendChild(chkTd);

      // Data cells appended without overwriting the checkbox
      tr.insertAdjacentHTML("beforeend", `
        <td class="mono">${truncate(msg.message_id, 28)}</td>
        <td class="mono">${truncate(msg.conversation_id, 28)}</td>
        <td>${msg.user || "—"}</td>
        <td class="mono small">${truncate(msg.agent_id, 32)}</td>
        <td class="small">${fmTime(msg.begin_time)}</td>
        <td class="dur-cell">${fmsDuration(msg.duration_ms)}</td>
        <td>${statusBadge(msg.status)}</td>
      `);
      tr.addEventListener("click", function() { loadTrace(msg.message_id); });
      messagesBody.appendChild(tr);
    });
  }

  // ── Load trace detail ──────────────────────────────────────────────────────
  async function loadTrace(messageId) {
    showView("detail");
    setDetailError(null);
    detailLoading.style.display = "";
    detailContent.style.display = "none";
    detailBreadcrumb.textContent = messageId;
    currentTraceJson = null;

    const params = new URLSearchParams({ dataset: currentDataset() });

    try {
      const resp = await fetch(
        api("api/trace/" + encodeURIComponent(messageId)) + "?" + params
      );
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || "HTTP " + resp.status);
      }
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      currentTraceJson = data;
      renderDetail(data);
    } catch (e) {
      setDetailError("Could not load trace: " + e.message);
    } finally {
      detailLoading.style.display = "none";
    }
  }

  function renderDetail(data) {
    const msg = data.message || null;
    const m   = data.metrics  || {};
    const findings = data.findings || [];

    // Breadcrumb
    if (msg) {
      detailBreadcrumb.textContent = msg.agent_id
        ? msg.agent_id + " · " + (msg.message_id || "")
        : (msg.message_id || "");
    } else {
      detailBreadcrumb.textContent = "Pasted trace";
    }

    // Meta — hidden for pasted traces
    const secMeta = document.getElementById("sec-meta");
    if (msg) {
      secMeta.style.display = "";
      const metaGrid = document.getElementById("meta-grid");
      metaGrid.innerHTML = metaItem("Agent", `<span class="mono small">${msg.agent_id || "—"}</span>`)
        + metaItem("User", msg.user || "—")
        + metaItem("Conversation", `<span class="mono small">${truncate(msg.conversation_id, 36)}</span>`)
        + metaItem("Begin", fmTime(msg.begin_time))
        + metaItem("End", fmTime(msg.end_time))
        + metaItem("Status", statusBadge(msg.status));
    } else {
      secMeta.style.display = "none";
    }

    // Time metrics
    const totalMs = m.total_duration_ms || 0;
    const timeMetrics = document.getElementById("metrics-time");
    timeMetrics.innerHTML =
      metricCard("Total duration",      fmsDuration(totalMs), "primary")
      + metricCard("LLM Mesh overhead", fmsDuration(m.mesh_overhead_ms || 0), "neutral")
      + metricCard("Provider inference", fmsDuration(m.provider_inference_ms || 0), "info")
      + metricCard("Tool execution",    fmsDuration(m.tool_execution_ms || 0), "warning");

    // Count metrics
    const countMetrics = document.getElementById("metrics-counts");
    countMetrics.innerHTML =
      metricCard("Tools called",    m.unique_tools_called   || 0, "neutral")
      + metricCard("Agent calls",   m.agent_call_count      || 0, "neutral")
      + metricCard("Iterations",    m.iteration_count       || 0, "neutral")
      + metricCard("Tokens in/out", (m.tokens_in || 0) + " / " + (m.tokens_out || 0), "neutral")
      + (m.estimated_cost ? metricCard("Est. cost", "$" + (m.estimated_cost).toFixed(4), "neutral") : "");

    // Tool breakdown — one row per individual call with input/output
    const secTools = document.getElementById("sec-tools");
    const toolsBody = document.getElementById("tools-body");
    if (m.tool_breakdown && m.tool_breakdown.length) {
      toolsBody.innerHTML = "";
      m.tool_breakdown.forEach(function (tool) {
        (tool.calls || []).forEach(function (call) {
          const pct = totalMs > 0 ? ((call.duration_ms / totalMs) * 100).toFixed(1) : "—";
          const inputVal  = call.inputs  == null ? "" : (typeof call.inputs  === "object" ? JSON.stringify(call.inputs)  : String(call.inputs));
          const outputVal = call.outputs == null ? "" : (typeof call.outputs === "object" ? JSON.stringify(call.outputs) : String(call.outputs));

          const tr = document.createElement("tr");

          const nameTd = document.createElement("td");
          nameTd.className = "mono small";
          nameTd.textContent = tool.name;

          const durTd = document.createElement("td");
          durTd.textContent = fmsDuration(call.duration_ms);

          const pctTd = document.createElement("td");
          pctTd.innerHTML = `<div class="pct-bar-wrap"><div class="pct-bar" style="width:${Math.min(100, parseFloat(pct) || 0)}%"></div><span>${pct}%</span></div>`;

          const inTd = document.createElement("td");
          inTd.className = "tool-io-cell";
          inTd.textContent = inputVal.length > 80 ? inputVal.slice(0, 80) + "…" : inputVal;
          if (inputVal) inTd.title = inputVal;

          const outTd = document.createElement("td");
          outTd.className = "tool-io-cell";
          outTd.textContent = outputVal.length > 80 ? outputVal.slice(0, 80) + "…" : outputVal;
          if (outputVal) outTd.title = outputVal;

          tr.appendChild(nameTd);
          tr.appendChild(durTd);
          tr.appendChild(pctTd);
          tr.appendChild(inTd);
          tr.appendChild(outTd);
          toolsBody.appendChild(tr);
        });
      });
      secTools.style.display = "";
    } else {
      secTools.style.display = "none";
    }

    // Agents
    const secAgents = document.getElementById("sec-agents");
    const agentsList = document.getElementById("agents-list");
    if (m.agents && m.agents.length) {
      agentsList.innerHTML = m.agents.map(function(a, idx) {
        const msgs = (a.inputs && a.inputs.messages) || [];
        const lastUser = [...msgs].reverse().find(msg => msg.role === "user");
        const inputText = lastUser ? escHtml(lastUser.text || "") : "—";
        const outputText = escHtml((a.outputs && a.outputs.text) || "—");
        const allMsgs = msgs.map(msg =>
          `<div class="agent-msg agent-msg-${escHtml(msg.role)}"><span class="agent-msg-role">${escHtml(msg.role)}</span><span class="agent-msg-text">${escHtml(msg.text || "")}</span></div>`
        ).join("");
        return `
          <details class="agent-call-card">
            <summary class="agent-call-summary">
              <span class="tag">${escHtml(a.llmId)}</span>
              <span class="agent-call-preview">${inputText.slice(0, 80)}${inputText.length > 80 ? "…" : ""}</span>
            </summary>
            <div class="agent-call-body">
              <div class="agent-io-section">
                <div class="agent-io-label">Input conversation</div>
                <div class="agent-msgs">${allMsgs || '<span class="mono small">—</span>'}</div>
              </div>
              <div class="agent-io-section">
                <div class="agent-io-label">Output</div>
                <div class="agent-io-text">${outputText}</div>
              </div>
            </div>
          </details>`;
      }).join("");
      secAgents.style.display = "";
    } else {
      secAgents.style.display = "none";
    }

    // Findings
    const secFindings = document.getElementById("sec-findings");
    const findingsList = document.getElementById("findings-list");
    if (findings.length) {
      findingsList.innerHTML = findings.map(function (f) {
        const badgeCls = f.severity === "WARNING" ? "badge-warning" : "badge-info";
        const evidenceJson = JSON.stringify(f.evidence, null, 2);
        return `
          <div class="finding finding-${f.severity.toLowerCase()}">
            <div class="finding-head">
              <span class="badge ${badgeCls}">${f.severity}</span>
              <span class="finding-code">${f.code}</span>
              <span class="finding-msg">${f.message}</span>
            </div>
            <details class="finding-evidence">
              <summary>Evidence</summary>
              <pre>${evidenceJson}</pre>
            </details>
          </div>`;
      }).join("");
      secFindings.style.display = "";
    } else {
      secFindings.style.display = "none";
    }

    // Raw trace
    const rawEl = document.getElementById("raw-trace");
    if (data.message) {
      rawEl.textContent = JSON.stringify(data, null, 2);
    }

    // AI Explanation — hide/reset, then auto-generate if enabled
    if (secExplain) {
      secExplain.style.display = "none";
      if (explainBody) explainBody.innerHTML = "";
      if (explainErr)  explainErr.style.display = "none";
    }

    detailContent.style.display = "";

    // Reset timeline detail panel when switching traces
    hideTimelineDetail();
    renderTimeline(data.trajectory || null);
    renderCallSequence(m, !!data.trajectory);

    generateExplanation();
  }

  // ── Compare view ───────────────────────────────────────────────────────────

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function toStr(val) {
    if (val == null) return "";
    return typeof val === "object" ? JSON.stringify(val, null, 2) : String(val);
  }

  async function loadCompare(ids) {
    showView("compare");
    compareLoading.style.display = "";
    compareContent.style.display = "none";
    compareError.style.display = "none";
    compareBreadcrumb.textContent = "Comparing " + ids.length + " traces";
    compareData = null;
    activeDrillTool = null;

    const params = new URLSearchParams({ dataset: currentDataset(), ids: ids.join(",") });
    try {
      const resp = await fetch(api("api/compare") + "?" + params);
      if (!resp.ok) {
        const err = await resp.json().catch(function() { return {}; });
        throw new Error(err.error || "HTTP " + resp.status);
      }
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      compareData = data;
      renderCompare(data);
    } catch (e) {
      compareError.textContent = "Could not load comparison: " + e.message;
      compareError.style.display = "";
    } finally {
      compareLoading.style.display = "none";
    }
  }

  function loadPastedCompare(traces) {
    showView("compare");
    compareLoading.style.display = "none";
    compareError.style.display = "none";
    compareBreadcrumb.textContent = "Comparing " + traces.length + " pasted trace" + (traces.length > 1 ? "s" : "");
    compareData = { traces: traces };
    activeDrillTool = null;
    renderCompare(compareData);
  }

  function renderCompare(data) {
    const traces = data.traces || [];
    renderCompareHeaders(traces);
    renderCompareMetrics(traces);
    renderCompareTools(traces);
    renderCompareFindings(traces);
    const secDrill = document.getElementById("sec-compare-drill");
    if (secDrill) secDrill.style.display = "none";
    activeDrillTool = null;
    compareContent.style.display = "";
  }

  function renderCompareHeaders(traces) {
    const container = document.getElementById("compare-header-cards");
    if (!container) return;
    container.innerHTML = "";
    traces.forEach(function(t, i) {
      const msg = t.message || {};
      const m   = t.metrics  || {};
      const traj = t.trajectory || {};
      const status = msg.status || "—";
      const label = msg.message_id || ("Pasted trace " + (i + 1));
      const duration = msg.duration_ms != null && msg.duration_ms !== 0
        ? msg.duration_ms
        : (m.total_duration_ms || traj.duration_ms || 0);
      const agentLabel = msg.agent_id || traj.agent_id || "—";
      const sCls = status === "OK" || status === "SUCCESS" ? "badge-success"
                 : status === "ERROR" || status === "FAILED" ? "badge-error"
                 : "badge-neutral";
      const card = document.createElement("div");
      card.className = "compare-trace-card";
      card.innerHTML =
        '<div class="ctc-index">Trace ' + (i + 1) + '</div>' +
        '<div class="ctc-id mono">' + escHtml(truncate(label, 36)) + '</div>' +
        '<div class="ctc-rows">' +
          '<div class="ctc-row"><span class="ctc-lbl">Agent</span><span class="mono small">' + escHtml(truncate(agentLabel, 28)) + '</span></div>' +
          '<div class="ctc-row"><span class="ctc-lbl">Status</span><span class="badge ' + sCls + '">' + escHtml(status) + '</span></div>' +
          '<div class="ctc-row"><span class="ctc-lbl">Duration</span><strong>' + fmsDuration(duration) + '</strong></div>' +
          '<div class="ctc-row"><span class="ctc-lbl">Iterations</span>' + (m.iteration_count || 0) + '</div>' +
          '<div class="ctc-row"><span class="ctc-lbl">Tokens</span>' + (m.tokens_in || 0) + ' / ' + (m.tokens_out || 0) + '</div>' +
        '</div>' +
        (t.error ? '<div class="error-banner" style="margin:10px 0 0">' + escHtml(t.error) + '</div>' : '');
      container.appendChild(card);
    });
  }

  function renderCompareMetrics(traces) {
    const container = document.getElementById("compare-metrics");
    if (!container) return;
    const defs = [
      { key: "total_duration_ms",     label: "Total duration",     fmt: fmsDuration,                        bad: true  },
      { key: "provider_inference_ms", label: "Provider inference",  fmt: fmsDuration,                        bad: true  },
      { key: "tool_execution_ms",     label: "Tool execution",      fmt: fmsDuration,                        bad: true  },
      { key: "mesh_overhead_ms",      label: "Mesh overhead",       fmt: fmsDuration,                        bad: true  },
      { key: "iteration_count",       label: "Iterations",          fmt: function(v) { return v; },          bad: true  },
      { key: "tokens_in",             label: "Tokens in",           fmt: function(v) { return v; },          bad: false },
      { key: "tokens_out",            label: "Tokens out",          fmt: function(v) { return v; },          bad: false },
      { key: "estimated_cost",        label: "Est. cost",           fmt: function(v) { return v > 0 ? "$" + v.toFixed(4) : "—"; }, bad: true },
    ];

    let html = '<table class="cmp-table"><thead><tr><th>Metric</th>';
    traces.forEach(function(t, i) {
      const mid = (t.message || {}).message_id || ("T" + (i + 1));
      html += '<th>T' + (i + 1) + ' <span class="cmp-th-id mono">' + escHtml(truncate(mid, 16)) + '</span></th>';
    });
    html += '</tr></thead><tbody>';

    defs.forEach(function(def) {
      const vals = traces.map(function(t) { return (t.metrics || {})[def.key] || 0; });
      const minV = Math.min.apply(null, vals);
      const maxV = Math.max.apply(null, vals);
      const same = vals.every(function(v) { return v === vals[0]; });
      html += '<tr><td class="cmp-metric-label">' + def.label + '</td>';
      vals.forEach(function(v) {
        let cls = "cmp-val";
        if (!same && def.bad) {
          if (v === minV) cls += " cmp-best";
          else if (v === maxV) cls += " cmp-worst";
        }
        html += '<td class="' + cls + '">' + escHtml(String(def.fmt(v))) + '</td>';
      });
      html += '</tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function _toolHasIoDiff(toolName, traces) {
    const callSets = traces.map(function(t) {
      const entry = (t.metrics.tool_breakdown || []).find(function(tb) { return tb.name === toolName; });
      return entry ? entry.calls : [];
    });
    const counts = callSets.map(function(cs) { return cs.length; });
    if (new Set(counts).size > 1) return true;
    const max = Math.max.apply(null, counts);
    for (let i = 0; i < max; i++) {
      const inputs  = callSets.map(function(cs) { return cs[i] ? JSON.stringify(cs[i].inputs)  : null; });
      const outputs = callSets.map(function(cs) { return cs[i] ? JSON.stringify(cs[i].outputs) : null; });
      if (new Set(inputs.filter(function(v) { return v !== null; })).size > 1)  return true;
      if (new Set(outputs.filter(function(v) { return v !== null; })).size > 1) return true;
    }
    return false;
  }

  function renderCompareTools(traces) {
    const sec   = document.getElementById("sec-compare-tools");
    const thead = document.getElementById("compare-tools-head");
    const tbody = document.getElementById("compare-tools-body");
    if (!sec || !thead || !tbody) return;

    const allTools = new Set();
    traces.forEach(function(t) {
      (t.metrics.tool_breakdown || []).forEach(function(tb) { allTools.add(tb.name); });
    });
    if (!allTools.size) { sec.style.display = "none"; return; }
    sec.style.display = "";

    const toolIndex = traces.map(function(t) {
      const idx = {};
      (t.metrics.tool_breakdown || []).forEach(function(tb) { idx[tb.name] = tb; });
      return idx;
    });

    thead.innerHTML = "<th>Tool</th>";
    traces.forEach(function(t, i) {
      const mid = (t.message || {}).message_id || ("T" + (i + 1));
      thead.innerHTML += '<th>T' + (i + 1) + ' <span class="cmp-th-id mono">' + escHtml(truncate(mid, 14)) + '</span></th>';
    });
    thead.innerHTML += "<th>Diff?</th>";

    tbody.innerHTML = "";
    [...allTools].sort().forEach(function(toolName) {
      const tr = document.createElement("tr");
      tr.className = "cmp-tool-row";
      tr.dataset.tool = toolName;

      const nameTd = document.createElement("td");
      nameTd.className = "mono small";
      nameTd.textContent = toolName;
      tr.appendChild(nameTd);

      traces.forEach(function(t, i) {
        const td    = document.createElement("td");
        const entry = toolIndex[i][toolName];
        if (entry) {
          td.className = "cmp-val";
          td.innerHTML = fmsDuration(entry.total_duration_ms) +
            ' <span class="cmp-call-count">×' + entry.call_count + '</span>';
        } else {
          td.className = "cmp-absent";
          td.textContent = "—";
        }
        tr.appendChild(td);
      });

      const diffTd = document.createElement("td");
      diffTd.innerHTML = _toolHasIoDiff(toolName, traces)
        ? '<span class="cmp-diff-badge">diff</span>'
        : '<span class="cmp-same-badge">same</span>';
      tr.appendChild(diffTd);

      tr.addEventListener("click", function() { toggleCompareDrill(toolName, traces, tr); });
      tbody.appendChild(tr);
    });
  }

  function renderLineDiff(strA, strB) {
    if (strA === strB) {
      return '<pre class="diff-pre diff-pre-same"><span class="diff-equal">' + escHtml(strA || "—") + '</span></pre>';
    }
    if (!window.Diff || !window.Diff.diffLines) {
      return '<pre class="diff-pre"><span class="diff-equal">' + escHtml(strB || "—") + '</span></pre>';
    }
    const changes = Diff.diffLines(strA, strB);
    let out = '<pre class="diff-pre">';
    changes.forEach(function(part) {
      const cls = part.added ? "diff-add" : part.removed ? "diff-remove" : "diff-equal";
      out += '<span class="' + cls + '">' + escHtml(part.value) + '</span>';
    });
    out += '</pre>';
    return out;
  }

  function renderDiffBlock(values, traces) {
    const strs = values.map(toStr);
    if (traces.length === 1) {
      return '<pre class="diff-pre diff-pre-same"><span class="diff-equal">' + escHtml(strs[0] || "—") + '</span></pre>';
    }
    if (traces.length === 2) {
      return renderLineDiff(strs[0], strs[1]);
    }
    let html = "";
    for (let i = 1; i < traces.length; i++) {
      html += '<div class="diff-pair-header">T1 vs T' + (i + 1) + '</div>';
      html += renderLineDiff(strs[0], strs[i]);
    }
    return html;
  }

  function toggleCompareDrill(toolName, traces, rowEl) {
    const sec    = document.getElementById("sec-compare-drill");
    const nameEl = document.getElementById("compare-drill-name");
    const body   = document.getElementById("compare-drill-body");
    if (!sec || !body) return;

    // Deactivate all tool rows
    const allRows = document.querySelectorAll(".cmp-tool-row");
    allRows.forEach(function(r) { r.classList.remove("drill-active"); });

    if (activeDrillTool === toolName) {
      sec.style.display = "none";
      activeDrillTool = null;
      return;
    }

    activeDrillTool = toolName;
    if (rowEl) rowEl.classList.add("drill-active");
    if (nameEl) nameEl.textContent = toolName;

    const callSets = traces.map(function(t) {
      const entry = (t.metrics.tool_breakdown || []).find(function(tb) { return tb.name === toolName; });
      return entry ? entry.calls : [];
    });
    const maxCalls = Math.max.apply(null, callSets.map(function(cs) { return cs.length; }));

    let html = "";
    for (let ci = 0; ci < maxCalls; ci++) {
      const calls = callSets.map(function(cs) { return cs[ci] || null; });

      html += '<div class="drill-call">';
      html += '<div class="drill-call-header">Call #' + (ci + 1) + '</div>';

      // Duration per trace
      html += '<div class="drill-dur-row">';
      traces.forEach(function(t, ti) {
        const call = calls[ti];
        html += '<div class="drill-dur-item">';
        html += '<span class="drill-trace-lbl">T' + (ti + 1) + '</span>';
        html += call ? fmsDuration(call.duration_ms) : '<span class="cmp-absent">not called</span>';
        html += '</div>';
      });
      html += '</div>';

      // Input diff
      html += '<div class="drill-diff-section">';
      html += '<div class="drill-diff-label">Input</div>';
      html += renderDiffBlock(calls.map(function(c) { return c ? c.inputs : null; }), traces);
      html += '</div>';

      // Output diff
      html += '<div class="drill-diff-section">';
      html += '<div class="drill-diff-label">Output</div>';
      html += renderDiffBlock(calls.map(function(c) { return c ? c.outputs : null; }), traces);
      html += '</div>';

      html += '</div>';
    }

    body.innerHTML = html;
    sec.style.display = "";
    sec.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function renderCompareFindings(traces) {
    const sec  = document.getElementById("sec-compare-findings");
    const body = document.getElementById("compare-findings-body");
    if (!sec || !body) return;

    const hasAny = traces.some(function(t) { return (t.findings || []).length > 0; });
    if (!hasAny) { sec.style.display = "none"; return; }
    sec.style.display = "";

    let html = "";
    traces.forEach(function(t, i) {
      const mid = (t.message || {}).message_id || ("Trace " + (i + 1));
      html += '<div class="compare-findings-col">';
      html += '<div class="cff-header">T' + (i + 1) + ' — ' + escHtml(truncate(mid, 20)) + '</div>';
      if (!(t.findings || []).length) {
        html += '<div class="cff-empty">No findings</div>';
      } else {
        t.findings.forEach(function(f) {
          const bCls = f.severity === "WARNING" ? "badge-warning" : "badge-info";
          const inAll = traces.every(function(ot) {
            return (ot.findings || []).some(function(of) { return of.code === f.code; });
          });
          html += '<div class="cff-finding' + (inAll ? "" : " cff-unique") + '">';
          html += '<span class="badge ' + bCls + '">' + escHtml(f.severity) + '</span>';
          html += '<span class="finding-code">' + escHtml(f.code) + '</span>';
          html += '<span class="finding-msg">' + escHtml(f.message) + '</span>';
          html += '</div>';
        });
      }
      html += '</div>';
    });
    body.innerHTML = html;
  }

  // ── Timeline ───────────────────────────────────────────────────────────────

  function escSvg(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toolTypeColor(toolType) {
    const t = (toolType || "").toLowerCase();
    if (t.includes("vectorstore") || t.includes("knowledge"))
      return { fill: "#7c3aed", stroke: "#6d28d9", text: "#fff" };
    if (t.includes("semantic") || t.includes("sql"))
      return { fill: "#0891b2", stroke: "#0e7490", text: "#fff" };
    if (t.includes("agent") || t.includes("agentic"))
      return { fill: "#059669", stroke: "#047857", text: "#fff" };
    if (t.includes("http") || t.includes("api") || t.includes("rest"))
      return { fill: "#d97706", stroke: "#b45309", text: "#fff" };
    return { fill: "#1a73e8", stroke: "#1557b0", text: "#fff" };
  }

  function renderCallSequence(m, hasTrajectory) {
    const sec  = document.getElementById("sec-call-sequence");
    const list = document.getElementById("call-sequence-list");
    if (!sec || !list) return;

    const seq = (m && m.call_sequence) || [];
    // Show only when there is no trajectory and there are calls to display
    if (hasTrajectory || !seq.length) {
      sec.style.display = "none";
      return;
    }

    list.innerHTML = seq.map(function(entry, i) {
      const isAgent  = entry.type === "agent";
      const typeLabel = isAgent ? "agent" : "tool";
      const typeCls   = isAgent ? "cs-badge-agent" : "cs-badge-tool";
      const label     = escHtml(entry.label);
      const offset    = fmsDuration(entry.offset_ms);
      const dur       = fmsDuration(entry.duration_ms);

      // inputs summary
      let inputSummary = "—";
      if (isAgent) {
        const msgs = (entry.inputs && entry.inputs.messages) || [];
        const lastUser = [...msgs].reverse().find(function(msg) { return msg.role === "user"; });
        if (lastUser) inputSummary = escHtml((lastUser.text || "").slice(0, 120));
      } else if (entry.inputs && typeof entry.inputs === "object") {
        const raw = JSON.stringify(entry.inputs);
        inputSummary = escHtml(raw.slice(0, 120) + (raw.length > 120 ? "…" : ""));
      }

      // expanded inputs html
      let inputsHtml = "";
      if (isAgent) {
        const msgs = (entry.inputs && entry.inputs.messages) || [];
        inputsHtml = msgs.map(function(msg) {
          return '<div class="agent-msg agent-msg-' + escHtml(msg.role) + '">' +
            '<span class="agent-msg-role">' + escHtml(msg.role) + '</span>' +
            '<span class="agent-msg-text">' + escHtml(msg.text || "") + '</span></div>';
        }).join("") || "—";
      } else {
        inputsHtml = '<pre class="cs-pre">' + escHtml(JSON.stringify(entry.inputs, null, 2)) + '</pre>';
      }

      const outputText = isAgent
        ? escHtml((entry.outputs && entry.outputs.text) || "—")
        : escHtml(typeof entry.outputs === "string"
            ? entry.outputs
            : JSON.stringify(entry.outputs, null, 2));

      return `
        <details class="cs-row">
          <summary class="cs-summary">
            <span class="cs-index">${i + 1}</span>
            <span class="cs-badge ${typeCls}">${typeLabel}</span>
            <span class="cs-label">${label}</span>
            <span class="cs-offset">+${offset}</span>
            <span class="cs-dur">${dur}</span>
          </summary>
          <div class="cs-body">
            <div class="agent-io-section">
              <div class="agent-io-label">Input${isAgent ? " conversation" : ""}</div>
              <div class="${isAgent ? "agent-msgs" : ""}">${inputsHtml}</div>
            </div>
            <div class="agent-io-section">
              <div class="agent-io-label">Output</div>
              <div class="agent-io-text">${outputText}</div>
            </div>
          </div>
        </details>`;
    }).join("");

    sec.style.display = "";
  }

  function renderTimeline(traj) {
    const secTimeline = document.getElementById("sec-timeline");
    const wrap        = document.getElementById("timeline-canvas-wrap");
    if (!secTimeline || !wrap) return;

    if (!traj || !traj.duration_ms) {
      secTimeline.style.display = "none";
      return;
    }

    const steps = (traj.steps || [])
      .filter(function (s) { return s.type === "TOOLCALL" && s.offset_ms != null; })
      .sort(function (a, b) { return (a.offset_ms || 0) - (b.offset_ms || 0); });

    if (!steps.length) {
      secTimeline.style.display = "none";
      return;
    }

    secTimeline.style.display = "";
    currentTrajectory = traj;

    // Layout constants
    const LABEL_W   = 172;
    const PAD_L     = 10;
    const PAD_R     = 24;
    const ROW_H     = 50;
    const BAR_H     = 28;
    const BAR_R     = 5;
    const AXIS_H    = 36;
    const agentDur  = traj.duration_ms;

    const containerW = wrap.clientWidth || 900;
    const CHART_START = LABEL_W + PAD_L;
    const CHART_END   = containerW - PAD_R;
    const CHART_W     = Math.max(100, CHART_END - CHART_START);

    const totalRows = 1 + steps.length;
    const svgH      = totalRows * ROW_H + AXIS_H + 16;

    function xOf(ms)  { return CHART_START + (ms / agentDur) * CHART_W; }
    function wOf(ms)  { return Math.max(3, (ms / agentDur) * CHART_W); }
    function barY(ri) { return ri * ROW_H + (ROW_H - BAR_H) / 2; }

    // LLM thinking intervals (gaps between tool calls)
    const thinkIntervals = [];
    let prevEnd = 0;
    steps.forEach(function (s) {
      const off = s.offset_ms || 0;
      const dur = s.duration_ms || 0;
      if (off > prevEnd) thinkIntervals.push({ start: prevEnd, end: off });
      prevEnd = off + dur;
    });
    if (prevEnd < agentDur) thinkIntervals.push({ start: prevEnd, end: agentDur });

    // Dynamic legend
    const legendSeen = {};
    const legendItems = [];
    steps.forEach(function (s) {
      const t = (s.tool_type || "").toLowerCase();
      let key, label;
      if (t.includes("vectorstore") || t.includes("knowledge")) { key = "kb";    label = "Knowledge Base"; }
      else if (t.includes("semantic") || t.includes("sql"))      { key = "sem";   label = "Semantic Model"; }
      else if (t.includes("agent") || t.includes("agentic"))     { key = "agent"; label = "Sub-Agent";      }
      else if (t.includes("http") || t.includes("api"))          { key = "http";  label = "HTTP/API";       }
      else                                                        { key = "tool";  label = "Tool";           }
      if (!legendSeen[key]) {
        legendSeen[key] = true;
        const col = toolTypeColor(s.tool_type);
        legendItems.push(
          '<span class="tl-legend-item">' +
          '<span class="tl-legend-dot" style="background:' + col.fill + '"></span>' +
          label + '</span>'
        );
      }
    });
    // LLM legend entry always present
    legendItems.unshift(
      '<span class="tl-legend-item">' +
      '<span class="tl-legend-dot" style="background:#1b2a47"></span>' +
      'Agent / LLM</span>'
    );
    const legendEl = document.getElementById("tl-legend");
    if (legendEl) legendEl.innerHTML = legendItems.join("");

    // Tick positions
    const numTicks = Math.min(8, Math.ceil(agentDur / 1000) + 1);
    const tickMs   = agentDur / Math.max(numTicks - 1, 1);

    // ── Build SVG ────────────────────────────────────────────────────────────
    const p = [];
    p.push('<svg id="timeline-svg" width="' + containerW + '" height="' + svgH +
      '" xmlns="http://www.w3.org/2000/svg" style="display:block;font-family:Inter,Segoe UI,system-ui,sans-serif">');

    p.push('<defs>');
    p.push('<linearGradient id="tl-grad-agent" x1="0" y1="0" x2="1" y2="0">');
    p.push('<stop offset="0%" stop-color="#1b2a47"/><stop offset="100%" stop-color="#2e4d82"/>');
    p.push('</linearGradient>');
    p.push('</defs>');

    // Row backgrounds (alternating)
    for (let ri = 0; ri < totalRows; ri++) {
      p.push('<rect x="0" y="' + (ri * ROW_H) + '" width="' + containerW + '" height="' + ROW_H +
        '" fill="' + (ri % 2 === 0 ? "#ffffff" : "#f8fafc") + '"/>');
    }

    // Vertical grid lines (time ticks)
    for (let ti = 0; ti < numTicks; ti++) {
      const tx = xOf(ti * tickMs);
      p.push('<line x1="' + tx + '" y1="0" x2="' + tx + '" y2="' + (totalRows * ROW_H) +
        '" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="3,4"/>');
    }

    // Label / chart separator
    p.push('<line x1="' + LABEL_W + '" y1="0" x2="' + LABEL_W + '" y2="' + (totalRows * ROW_H + AXIS_H) +
      '" stroke="#e2e8f0" stroke-width="1.5"/>');

    // ── Row 0: Agent bar ──────────────────────────────────────────────────────
    const agBY = barY(0);

    p.push('<rect x="' + xOf(0) + '" y="' + agBY + '" width="' + wOf(agentDur) + '" height="' + BAR_H +
      '" rx="' + BAR_R + '" fill="url(#tl-grad-agent)"/>');

    // LLM intervals overlaid
    thinkIntervals.forEach(function (iv) {
      const tX = xOf(iv.start);
      const tW = wOf(iv.end - iv.start);
      p.push('<rect x="' + tX + '" y="' + (agBY + 4) + '" width="' + tW + '" height="' + (BAR_H - 8) +
        '" rx="3" fill="rgba(219,234,254,0.28)"/>');
      const dur = iv.end - iv.start;
      if (tW > 50) {
        p.push('<text x="' + (tX + tW / 2) + '" y="' + (agBY + BAR_H / 2 + 4) +
          '" text-anchor="middle" font-size="10" fill="rgba(255,255,255,0.6)" font-weight="500">LLM ' +
          escSvg(fmsDuration(dur)) + '</text>');
      }
    });

    // Tool markers on agent bar
    steps.forEach(function (s) {
      const col = toolTypeColor(s.tool_type);
      const mX  = xOf(s.offset_ms || 0);
      const mW  = Math.max(wOf(s.duration_ms || 0), 5);
      const r   = Math.min(BAR_R, mW / 2);
      p.push('<rect x="' + mX + '" y="' + agBY + '" width="' + mW + '" height="' + BAR_H +
        '" rx="' + r + '" fill="' + col.fill + '" opacity="0.92"/>');
    });

    // Agent label
    const agLabel = escSvg(truncate(traj.agent_id || "Agent", 22));
    p.push('<text x="' + (LABEL_W - 10) + '" y="' + (ROW_H / 2 + 5) +
      '" text-anchor="end" font-size="12" font-weight="700" fill="#1e293b">' + agLabel + '</text>');

    // Total duration label after bar
    p.push('<text x="' + (xOf(agentDur) + 6) + '" y="' + (agBY + BAR_H / 2 + 4) +
      '" font-size="11" fill="#64748b" font-weight="600">' + escSvg(fmsDuration(agentDur)) + '</text>');

    // ── Rows 1..N: Tool call bars ─────────────────────────────────────────────
    steps.forEach(function (s, si) {
      const ri    = si + 1;
      const rTop  = ri * ROW_H;
      const bY    = barY(ri);
      const offMs = s.offset_ms || 0;
      const durMs = s.duration_ms || 0;
      const col   = toolTypeColor(s.tool_type);
      const bX    = xOf(offMs);
      const bW    = Math.max(wOf(durMs), 5);
      const cx    = bX + bW / 2;

      // Connector line from agent bar to this bar
      p.push('<line x1="' + cx + '" y1="' + (agBY + BAR_H) + '" x2="' + cx + '" y2="' + bY +
        '" stroke="' + col.fill + '" stroke-width="1.5" stroke-dasharray="3,3" opacity="0.3"/>');

      // Clickable bar group
      p.push('<g class="tl-bar" data-step-idx="' + si + '" style="cursor:pointer">');
      p.push('<rect x="' + bX + '" y="' + bY + '" width="' + bW + '" height="' + BAR_H +
        '" rx="' + BAR_R + '" fill="' + col.fill + '" class="tl-bar-rect"/>');

      // Duration label
      const durLabel = fmsDuration(durMs);
      if (bW > 55) {
        p.push('<text x="' + (bX + bW / 2) + '" y="' + (bY + BAR_H / 2 + 4) +
          '" text-anchor="middle" font-size="10" fill="#fff" font-weight="600" pointer-events="none">' +
          escSvg(durLabel) + '</text>');
      } else {
        p.push('<text x="' + (bX + bW + 5) + '" y="' + (bY + BAR_H / 2 + 4) +
          '" font-size="10" fill="#64748b" pointer-events="none">' + escSvg(durLabel) + '</text>');
      }
      p.push('</g>');

      // Row label (right-aligned)
      const label = escSvg(truncate(s.tool_name || s.tool_function_name || "Tool", 22));
      p.push('<text x="' + (LABEL_W - 18) + '" y="' + (rTop + ROW_H / 2 + 5) +
        '" text-anchor="end" font-size="12" fill="#1e293b">' + label + '</text>');

      // Color dot beside label
      p.push('<circle cx="' + (LABEL_W - 9) + '" cy="' + (rTop + ROW_H / 2) +
        '" r="4" fill="' + col.fill + '"/>');
    });

    // ── Time axis ─────────────────────────────────────────────────────────────
    const axY = totalRows * ROW_H + 6;
    p.push('<line x1="' + xOf(0) + '" y1="' + axY + '" x2="' + xOf(agentDur) + '" y2="' + axY +
      '" stroke="#cbd5e1" stroke-width="1.5"/>');
    for (let ti = 0; ti < numTicks; ti++) {
      const tms = ti * tickMs;
      const tx  = xOf(tms);
      p.push('<line x1="' + tx + '" y1="' + axY + '" x2="' + tx + '" y2="' + (axY + 5) +
        '" stroke="#94a3b8" stroke-width="1.5"/>');
      p.push('<text x="' + tx + '" y="' + (axY + 20) +
        '" text-anchor="middle" font-size="10" fill="#94a3b8">' + escSvg(fmsDuration(Math.round(tms))) + '</text>');
    }

    p.push('</svg>');
    wrap.innerHTML = p.join("");

    // Hover + click handlers on bar groups
    wrap.querySelectorAll(".tl-bar").forEach(function (g) {
      const rect = g.querySelector(".tl-bar-rect");
      g.addEventListener("mouseenter", function () { if (rect) rect.style.opacity = "0.75"; });
      g.addEventListener("mouseleave", function () { if (rect) rect.style.opacity = ""; });
      g.addEventListener("click", function () {
        const idx = parseInt(this.getAttribute("data-step-idx"), 10);
        if (currentDetailStepIdx === idx) {
          hideTimelineDetail();
        } else {
          showTimelineDetail(steps[idx], idx);
        }
      });
    });
  }

  function showTimelineDetail(step, idx) {
    const panel = document.getElementById("timeline-detail-panel");
    if (!panel) return;
    currentDetailStepIdx = idx;

    const col = toolTypeColor(step.tool_type);

    const dotEl = document.getElementById("tdp-type-dot");
    if (dotEl) dotEl.style.background = col.fill;

    const titleEl = document.getElementById("tdp-title");
    if (titleEl) titleEl.textContent = step.tool_name || step.tool_function_name || "Tool Call";

    const typeEl = document.getElementById("tdp-tool-type");
    if (typeEl) {
      typeEl.textContent = step.tool_type || "";
      typeEl.style.background = col.fill + "22";
      typeEl.style.color = col.fill;
      typeEl.style.borderColor = col.fill + "55";
    }

    const durEl = document.getElementById("tdp-duration");
    if (durEl) {
      const offLabel = step.offset_ms != null ? " · offset " + fmsDuration(step.offset_ms) : "";
      durEl.textContent = fmsDuration(step.duration_ms || 0) + offLabel;
    }

    const inputEl  = document.getElementById("tdp-input");
    const outputEl = document.getElementById("tdp-output");
    if (inputEl)  inputEl.textContent  = step.input  ? JSON.stringify(step.input,  null, 2) : "—";
    if (outputEl) outputEl.textContent = step.output ? JSON.stringify(step.output, null, 2) : "—";

    panel.style.display = "";
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function hideTimelineDetail() {
    const panel = document.getElementById("timeline-detail-panel");
    if (panel) panel.style.display = "none";
    currentDetailStepIdx = null;
  }

  // ── Render helpers ─────────────────────────────────────────────────────────
  function metaItem(label, value) {
    return `<div class="meta-item"><span class="meta-label">${label}</span><span class="meta-value">${value}</span></div>`;
  }

  function metricCard(label, value, variant) {
    return `<div class="metric-card metric-${variant}"><div class="metric-value">${value}</div><div class="metric-label">${label}</div></div>`;
  }

  // ── Event listeners ────────────────────────────────────────────────────────
  if (btnPasteTrace)   btnPasteTrace.addEventListener("click", openPasteModal);
  if (btnModalClose)   btnModalClose.addEventListener("click", closePasteModal);
  if (btnModalCancel)  btnModalCancel.addEventListener("click", closePasteModal);
  if (btnModalAnalyze) btnModalAnalyze.addEventListener("click", analyzePaste);
  if (btnAddTrace) {
    btnAddTrace.addEventListener("click", function () {
      if (!traceInputs) return;
      const nextIdx = traceInputs.children.length + 1;
      traceInputs.appendChild(createTraceEntry("", nextIdx));
      refreshTraceEntryLabels();
      refreshPasteActionLabel();
      const last = traceInputs.lastElementChild && traceInputs.lastElementChild.querySelector(".trace-textarea");
      if (last) last.focus();
    });
  }
  if (modalPaste) {
    modalPaste.addEventListener("click", function (e) {
      if (e.target === modalPaste) closePasteModal();
    });
  }
  if (traceInputs) {
    traceInputs.addEventListener("keydown", function (e) {
      const target = e.target;
      if (target && target.classList && target.classList.contains("trace-textarea")) {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) analyzePaste();
      }
    });
    traceInputs.addEventListener("input", refreshPasteActionLabel);
  }

  if (chkExplain) {
    chkExplain.addEventListener("change", function () {
      if (llmPicker) llmPicker.style.display = chkExplain.checked ? "" : "none";
      if (!chkExplain.checked && secExplain) secExplain.style.display = "none";
    });
  }
  if (btnRegen) btnRegen.addEventListener("click", generateExplanation);

  const btnTdpClose = document.getElementById("tdp-close");
  if (btnTdpClose) btnTdpClose.addEventListener("click", hideTimelineDetail);

  inpDataset.addEventListener("change", function () {
    selUser.value = "";
    selAgent.value = "";
    selConv.value = "";
    loadFilters().then(loadMessages);
  });

  btnApply.addEventListener("click", loadMessages);
  btnReset.addEventListener("click", function () {
    selUser.value = "";
    selAgent.value = "";
    selConv.value = "";
    loadMessages();
  });
  btnBack.addEventListener("click", function () {
    showView("list");
  });
  btnCopy.addEventListener("click", function () {
    if (!currentTraceJson) return;
    navigator.clipboard.writeText(JSON.stringify(currentTraceJson, null, 2))
      .then(function () {
        btnCopy.textContent = "Copied!";
        setTimeout(function () { btnCopy.textContent = "Copy JSON"; }, 2000);
      })
      .catch(function () {
        btnCopy.textContent = "Copy failed";
        setTimeout(function () { btnCopy.textContent = "Copy JSON"; }, 2000);
      });
  });

  if (btnCompare) {
    btnCompare.addEventListener("click", function() {
      if (selectedIds.size < 2) return;
      loadCompare([...selectedIds]);
    });
  }
  if (btnCompareBack) {
    btnCompareBack.addEventListener("click", function() { showView("list"); });
  }
  const btnDrillClose = document.getElementById("btn-compare-drill-close");
  if (btnDrillClose) {
    btnDrillClose.addEventListener("click", function() {
      const sec = document.getElementById("sec-compare-drill");
      if (sec) sec.style.display = "none";
      activeDrillTool = null;
      document.querySelectorAll(".cmp-tool-row").forEach(function(r) {
        r.classList.remove("drill-active");
      });
    });
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  showView("list");
  loadDatasets();
  loadLLMs();

})();
