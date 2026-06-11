/**
 * AutoCrew Desktop Renderer — 工作区面板（PRD §7.3：卡片的展开态）。
 * 对话驱动在 chat.js；本文件管 report/drafts/style/settings 四个面板。
 * window.autocrew 由 preload.ts 经 contextBridge 暴露。
 */

// ── Workspace panels ─────────────────────────────────────────────────────────

function switchPanel(name) {
  document.querySelectorAll(".panel").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".ws-tab").forEach(l => l.classList.remove("active"));
  document.getElementById("panel-" + name).classList.add("active");
  document.querySelector('[data-panel="' + name + '"]').classList.add("active");
  refreshActivePanel();
}

function refreshActivePanel() {
  const active = document.querySelector(".ws-tab.active");
  if (!active) return;
  const name = active.dataset.panel;
  if (name === "report") initReport();
  if (name === "drafts") initDrafts();
  if (name === "style") initStyle();
  if (name === "settings" && typeof initSettings === "function") initSettings();
}

document.querySelectorAll(".ws-tab").forEach(tab => {
  tab.addEventListener("click", () => switchPanel(tab.dataset.panel));
});

// ── Report screen ─────────────────────────────────────────────────────────────

async function initReport() {
  const el = document.getElementById("panel-report");
  el.innerHTML = "";
  el.appendChild(h("h2", {}, "数据分析师 · 回流报告"));

  const loading = h("p", { class: "muted" }, "加载中...");
  el.appendChild(loading);

  const res = await safeInvoke(window.autocrew.flywheelReport);
  el.removeChild(loading);

  if (!res.ok) {
    showToast(res.error || "加载报告失败");
    el.appendChild(h("p", { class: "empty-state" },
      "暂无回流数据。请先按 runbook「七、历史回灌」导入平台 CSV，再返回此屏。"));
    return;
  }

  const d = res.data;

  // Metric cards
  const grid = h("div", { class: "metric-grid" });

  // completionRate is already percent-scaled 0-100 (e.g. {"completionRate":41}) — no *100
  const completionRate = d.avgMetrics && d.avgMetrics.completionRate !== undefined
    ? d.avgMetrics.completionRate + "%"
    : "—";
  const avgViews = d.avgMetrics && d.avgMetrics.views !== undefined
    ? Math.round(d.avgMetrics.views).toLocaleString("zh-CN")
    : "—";
  // traitSampleSize is unbounded — show n/3, unlocked marker at >=3 (no percent artifact)
  const traitProgress = d.traitSampleSize !== undefined
    ? d.traitSampleSize + "/3" + (d.traitSampleSize >= 3 ? " ✓ 已解锁" : "")
    : "—";

  const cards = [
    ["作品数", d.works ? String(d.works.total) : "0"],
    ["平均播放", avgViews],
    ["平均完播率", completionRate],
    ["打标进度", traitProgress],
  ];

  for (const [label, value] of cards) {
    grid.appendChild(h("div", { class: "metric-card" },
      h("div", { class: "metric-value" }, value),
      h("div", { class: "metric-label" }, label),
    ));
  }
  el.appendChild(grid);

  // Works sub-stats
  if (d.works) {
    const sub = h("p", { class: "muted sub-stats" },
      "已匹配 " + d.works.matched + " 条 / 历史 " + d.works.historical + " 条");
    el.appendChild(sub);
  }

  // byPlatform bars
  if (d.byPlatform && Object.keys(d.byPlatform).length > 0) {
    el.appendChild(h("h3", {}, "平台分布"));
    const total = Object.values(d.byPlatform).reduce((a, b) => a + b, 0) || 1;
    const barSection = h("div", { class: "platform-bars" });
    for (const [platform, count] of Object.entries(d.byPlatform)) {
      const pct = Math.round((count / total) * 100);
      const row = h("div", { class: "bar-row" });
      row.appendChild(h("span", { class: "bar-label" }, platformLabel(platform)));
      const track = h("div", { class: "bar-track" });
      const fill = h("div", { class: "bar-fill", style: "width:" + pct + "%" });
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(h("span", { class: "bar-count" }, String(count)));
      barSection.appendChild(row);
    }
    el.appendChild(barSection);
  }

  // Insights
  if (d.baselineInsights && d.baselineInsights.length > 0) {
    el.appendChild(h("h3", {}, "洞察"));
    const list = h("ul", { class: "insight-list" });
    for (const ins of d.baselineInsights) {
      list.appendChild(h("li", {}, ins));
    }
    el.appendChild(list);
  }

  // Needs review
  if (d.needsReview && d.needsReview.length > 0) {
    el.appendChild(h("h3", {}, "待人工确认（" + d.needsReview.length + "）"));
    const note = h("p", { class: "muted" },
      "以下条目数据异常，请在创作者中心核实后用 autocrew_flywheel record 补录。");
    el.appendChild(note);
    const list = h("ul", { class: "review-list" });
    for (const item of d.needsReview) {
      const text = (item.contentId || item.platformTitle || item.id || "未知条目")
        + (item.platform ? "（" + platformLabel(item.platform) + "）" : "")
        + (item.metricDate ? " " + item.metricDate : "");
      list.appendChild(h("li", {}, text));
    }
    el.appendChild(list);
  }

  if (!d.works || d.works.total === 0) {
    el.appendChild(h("p", { class: "empty-state" },
      "暂无回流数据。请先按 runbook「七、历史回灌」导入平台 CSV，再返回此屏。"));
  }
}

// ── Drafts screen ─────────────────────────────────────────────────────────────

async function initDrafts() {
  const el = document.getElementById("panel-drafts");
  el.innerHTML = "";
  el.appendChild(h("h2", {}, "稿件"));

  const loading = h("p", { class: "muted" }, "加载中...");
  el.appendChild(loading);

  const res = await safeInvoke(window.autocrew.contentList);
  el.removeChild(loading);

  if (!res.ok) {
    showToast(res.error || "加载稿件失败");
    el.appendChild(h("p", { class: "empty-state" },
      "无法加载稿件。在左侧对话里说「帮我写……」创建内容。"));
    return;
  }

  // contentList returns { ok, contents } (not data.contents)
  const contents = res.contents || [];

  if (contents.length === 0) {
    el.appendChild(h("p", { class: "empty-state" },
      "暂无稿件。在左侧对话里说「帮我写……」创建第一篇内容。"));
    return;
  }

  // Sort time-desc
  const sorted = [...contents].sort((a, b) => {
    const ta = a.updatedAt || a.createdAt || "";
    const tb = b.updatedAt || b.createdAt || "";
    return tb.localeCompare(ta);
  });

  const listDiv = h("div", { class: "draft-list" });
  const detailDiv = h("div", { id: "draft-detail", class: "draft-detail hidden" });

  for (const c of sorted) {
    const row = h("div", { class: "draft-row" });
    row.appendChild(h("span", { class: "draft-title" }, c.title || "（无标题）"));
    row.appendChild(h("span", { class: "draft-meta" },
      platformLabel(c.platform) + " · " + statusLabel(c.status) + " · " + fmtDate(c.updatedAt || c.createdAt)));
    row.addEventListener("click", () => renderDraftDetail(c.id, detailDiv, el));
    listDiv.appendChild(row);
  }

  el.appendChild(listDiv);
  el.appendChild(detailDiv);
}

async function renderDraftDetail(contentId, detailDiv, screenEl) {
  detailDiv.innerHTML = "";
  detailDiv.classList.remove("hidden");

  const res = await safeInvoke(window.autocrew.contentGet, { id: contentId });
  if (!res.ok) {
    showToast(res.error || "加载稿件失败");
    return;
  }

  const c = res.content;

  detailDiv.appendChild(h("h3", {}, c.title || "（无标题）"));

  const metaLine = h("p", { class: "muted" },
    platformLabel(c.platform) + " · " + statusLabel(c.status));
  detailDiv.appendChild(metaLine);

  // Body
  const bodyPre = h("pre", { class: "detail-body" });
  bodyPre.textContent = c.body || "";
  detailDiv.appendChild(bodyPre);

  // Hashtags
  if (c.hashtags && c.hashtags.length > 0) {
    const tagWrap = h("div", { class: "tag-wrap" });
    for (const tag of c.hashtags) {
      tagWrap.appendChild(h("span", { class: "tag" }, tag));
    }
    detailDiv.appendChild(tagWrap);
  }

  detailDiv.appendChild(h("hr", {}));

  // Actions row
  const actions = h("div", { class: "action-row" });

  // Copy to clipboard
  const copyBtn = h("button", { class: "btn-primary" }, "复制发布文案");
  copyBtn.dataset.label = "复制发布文案";
  actions.appendChild(copyBtn);

  const copyStatus = h("span", { class: "action-status" });
  actions.appendChild(copyStatus);

  copyBtn.addEventListener("click", async () => {
    setLoading(copyBtn, true, "复制中...");
    const r = await safeInvoke(window.autocrew.publishClipboard, { content_id: contentId });
    setLoading(copyBtn, false);
    if (!r.ok) {
      showToast(r.error || "复制失败");
      return;
    }
    const copyText = r.data && r.data.copyText ? r.data.copyText : "";
    try {
      await navigator.clipboard.writeText(copyText);
      copyStatus.textContent = "已复制到剪贴板";
      setTimeout(() => { copyStatus.textContent = ""; }, 3000);
    } catch {
      showToast("剪贴板写入失败，请手动复制");
    }
  });

  detailDiv.appendChild(actions);

  // Confirm published
  const confirmSection = h("div", { class: "confirm-section" });
  const urlInput = h("input", {
    type: "text", placeholder: "发布链接（可选）", class: "input-full",
  });
  const confirmBtn = h("button", { class: "btn-secondary" }, "确认已发布");
  confirmBtn.dataset.label = "确认已发布";
  confirmSection.appendChild(urlInput);
  confirmSection.appendChild(confirmBtn);
  detailDiv.appendChild(confirmSection);

  confirmBtn.addEventListener("click", async () => {
    setLoading(confirmBtn, true, "确认中...");
    const payload = { content_id: contentId };
    const url = urlInput.value.trim();
    if (url) payload.publish_url = url;
    const r = await safeInvoke(window.autocrew.publishConfirm, payload);
    setLoading(confirmBtn, false);
    if (!r.ok) {
      showToast(r.error || "确认发布失败");
      return;
    }
    metaLine.textContent = platformLabel(c.platform) + " · 已发布";
    confirmSection.remove();
    const doneMsg = h("p", { class: "success-msg" }, "已标记为已发布");
    detailDiv.appendChild(doneMsg);
  });
}

// ── Style screen ──────────────────────────────────────────────────────────────

let styleInitialized = false;

function initStyle() {
  const rulesSection = document.getElementById("style-rules-section");
  if (styleInitialized && rulesSection) {
    loadStyleRules(rulesSection);
    return;
  }
  styleInitialized = true;

  const el = document.getElementById("panel-style");
  el.innerHTML = "";
  el.appendChild(h("h2", {}, "编剧 · 风格档案"));

  // Rules section (loaded async)
  const rulesSectionEl = h("div", { id: "style-rules-section" });
  el.appendChild(rulesSectionEl);
  loadStyleRules(rulesSectionEl);

  el.appendChild(h("hr", {}));

  // Distill section
  el.appendChild(h("h3", {}, "从编辑中学习"));
  const distillBtn = h("button", { class: "btn-secondary" }, "从编辑中学习");
  distillBtn.dataset.label = "从编辑中学习";
  el.appendChild(distillBtn);
  const distillResult = h("div", { id: "distill-result" });
  el.appendChild(distillResult);

  distillBtn.addEventListener("click", async () => {
    setLoading(distillBtn, true, "提炼中...");
    distillResult.innerHTML = "";
    const res = await safeInvoke(window.autocrew.styleDistill);
    setLoading(distillBtn, false);
    if (!res.ok) {
      showToast(res.error || "风格提炼失败");
      return;
    }
    const data = res.data || res;
    const summary = data.summary || data.message || JSON.stringify(data);
    distillResult.appendChild(h("div", { class: "result-card" },
      h("div", { class: "result-label" }, "提炼摘要"),
      h("p", {}, summary),
    ));
    // Reload rules after distill
    loadStyleRules(rulesSectionEl);
  });

  el.appendChild(h("hr", {}));

  // Absorb section
  el.appendChild(h("h3", {}, "爆款吸收"));
  el.appendChild(h("p", { class: "muted" }, "每行一条爆款文案（1-5 条），提取风格特征。"));
  const absorbArea = h("textarea", {
    class: "input-full textarea-absorb",
    placeholder: "第一条爆款文案\n第二条爆款文案\n...",
  });
  el.appendChild(absorbArea);

  const absorbBtn = h("button", { class: "btn-primary" }, "吸收爆款风格");
  absorbBtn.dataset.label = "吸收爆款风格";
  el.appendChild(absorbBtn);

  const absorbResult = h("div", { id: "absorb-result" });
  el.appendChild(absorbResult);

  absorbBtn.addEventListener("click", async () => {
    const lines = absorbArea.value.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) {
      showToast("请输入至少一条爆款文案");
      return;
    }
    if (lines.length > 5) {
      showToast("最多输入 5 条");
      return;
    }

    setLoading(absorbBtn, true, "吸收中...");
    absorbResult.innerHTML = "";
    const res = await safeInvoke(window.autocrew.styleAbsorb, { samples: lines });
    setLoading(absorbBtn, false);

    if (!res.ok) {
      showToast(res.error || "风格吸收失败");
      return;
    }
    const data = res.data || res;
    const msg = data.summary || data.message || "已更新风格规则";
    absorbResult.appendChild(h("p", { class: "success-msg" }, msg));
    // Reload rules
    loadStyleRules(rulesSectionEl);
  });
}

async function loadStyleRules(container) {
  container.innerHTML = "";
  container.appendChild(h("h3", {}, "写作规则"));

  const loading = h("p", { class: "muted" }, "加载中...");
  container.appendChild(loading);

  const res = await safeInvoke(window.autocrew.styleRules);
  container.removeChild(loading);

  if (!res.ok) {
    showToast(res.error || "加载风格规则失败");
    container.appendChild(h("p", { class: "empty-state" },
      "暂无风格规则。使用下方「从编辑中学习」或「爆款吸收」来建立风格档案。"));
    return;
  }

  const data = res.data || {};
  const rules = data.rules || [];
  const boundaries = data.boundaries || { never: [], always: [] };

  if (rules.length === 0 && (!boundaries.never || boundaries.never.length === 0) &&
      (!boundaries.always || boundaries.always.length === 0)) {
    container.appendChild(h("p", { class: "empty-state" },
      "暂无风格规则。使用下方「从编辑中学习」或「爆款吸收」来建立风格档案。"));
    return;
  }

  if (rules.length > 0) {
    const list = h("ul", { class: "rules-list" });
    rules.forEach((rule, i) => {
      const isObj = rule && typeof rule === "object";
      const ruleText = isObj ? (rule.rule || "") : String(rule);
      const sourceSuffix = isObj && rule.source === "auto_distilled" ? "（自动提炼）"
        : isObj && rule.source === "user_explicit" ? "（手动）" : "";
      const disabled = isObj && rule.disabled === true;

      const row = h("li", { class: disabled ? "rule-row rule-disabled" : "rule-row" });
      const textSpan = h("span", { class: "rule-text" }, ruleText + sourceSuffix);
      row.appendChild(textSpan);

      const toggleBtn = h("button", { class: "btn-mini" }, disabled ? "启用" : "停用");
      toggleBtn.addEventListener("click", async () => {
        const r = await safeInvoke(window.autocrew.styleUpdateRule, { index: i, disabled: !disabled });
        if (!r.ok) { showToast(r.error || "更新失败"); return; }
        loadStyleRules(container);
      });
      row.appendChild(toggleBtn);

      const editBtn = h("button", { class: "btn-mini" }, "编辑");
      editBtn.addEventListener("click", () => {
        const input = h("input", { type: "text", class: "input-full" });
        input.value = ruleText;
        const saveBtn = h("button", { class: "btn-mini" }, "保存");
        saveBtn.addEventListener("click", async () => {
          const r = await safeInvoke(window.autocrew.styleUpdateRule, { index: i, rule: input.value });
          if (!r.ok) { showToast(r.error || "保存失败"); loadStyleRules(container); return; }
          loadStyleRules(container);
        });
        row.innerHTML = "";
        row.appendChild(input);
        row.appendChild(saveBtn);
        input.focus();
      });
      row.appendChild(editBtn);

      list.appendChild(row);
    });
    container.appendChild(list);
  }

  const never = boundaries.never || [];
  const always = boundaries.always || [];

  if (never.length > 0) {
    container.appendChild(h("h4", {}, "禁止（Never）"));
    const nList = h("ul", { class: "rules-list rules-never" });
    for (const item of never) {
      nList.appendChild(h("li", {}, typeof item === "string" ? item : JSON.stringify(item)));
    }
    container.appendChild(nList);
  }

  if (always.length > 0) {
    container.appendChild(h("h4", {}, "必须（Always）"));
    const aList = h("ul", { class: "rules-list rules-always" });
    for (const item of always) {
      aList.appendChild(h("li", {}, typeof item === "string" ? item : JSON.stringify(item)));
    }
    container.appendChild(aList);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

initChat();
initReport();
bootOnboarding();
