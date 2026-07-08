/**
 * AutoCrew Desktop Renderer — 目的页面板渲染（S3.0）。
 * 中央视图切换在 views.js；左侧边栏在 sidebar.js；对话驱动在 chat.js。
 * 本文件负责 report / drafts / style 三个面板的内容渲染（initReport / initDrafts / initStyle）。
 * window.autocrew 由 preload.ts 经 contextBridge 暴露。
 */

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

  // 按状态分组（11 态 pipeline 揭幕）
  const GROUPS = [
    ["draft",     ["topic_saved", "drafting", "draft_ready", "revision"]],
    ["review",    ["reviewing", "cover_pending"]],
    ["ready",     ["approved", "publish_ready", "publishing"]],
    ["published", ["published"]],
    ["other",     ["archived"]],
  ];
  const GROUP_LABELS = {
    draft: "草稿", review: "审核中", ready: "待发布", published: "已发布", other: "归档",
  };

  for (const [g, statuses] of GROUPS) {
    const items = sorted.filter(c => statuses.includes(c.status));
    if (items.length === 0) continue;
    listDiv.appendChild(h("h4", { class: "wb-group" },
      GROUP_LABELS[g] + "（" + items.length + "）"));
    for (const c of items) {
      const row = h("div", { class: "draft-row" });
      row.appendChild(h("span", { class: "draft-title" }, c.title || "（无标题）"));
      row.appendChild(h("span", { class: "draft-meta" },
        platformLabel(c.platform) + " · " + statusLabel(c.status) + " · " + fmtDate(c.updatedAt || c.createdAt)));
      row.addEventListener("click", () => renderDraftDetail(c.id, detailDiv));
      listDiv.appendChild(row);
    }
  }

  el.appendChild(listDiv);
  el.appendChild(detailDiv);

  // 今日待审队列直达（P1 一期）：带着稿件 id 进来就直接开工作台
  if (window.__openDraftId) {
    const pending = window.__openDraftId;
    window.__openDraftId = null;
    detailDiv.classList.remove("hidden");
    renderDraftDetail(pending, detailDiv);
  }
}

async function renderDraftDetail(contentId, detailDiv) {
  await renderWorkbench(contentId, detailDiv);
}

function renderPublishActions(c, detailDiv) {
  const contentId = c.id;

  detailDiv.appendChild(h("hr", {}));

  // 公众号 A 级发布（P0 阶段 2）：推草稿箱，审核员发布门在后端同步阻断
  if (c.platform === "wechat_mp") {
    const wxRow = h("div", { class: "action-row" });
    const wxBtn = h("button", { class: "btn-primary" }, "推送公众号草稿箱");
    wxBtn.dataset.label = "推送公众号草稿箱";
    wxRow.appendChild(wxBtn);
    detailDiv.appendChild(wxRow);
    const wxReceipt = h("div", { class: "wx-receipt" });
    detailDiv.appendChild(wxReceipt);
    const doWxPush = async () => {
      wxReceipt.innerHTML = "";
      setLoading(wxBtn, true, "配图生成 + 推送中（可能需要几分钟）...");
      const r = await safeInvoke(window.autocrew.publishWechatDraft, { content_id: contentId });
      setLoading(wxBtn, false);
      if (!r.ok) {
        const errText = r.violations && r.violations.length > 0
          ? "审核员阻断：命中违禁词「" + r.violations.join("、") + "」，修改后重试"
          : (r.error || "未知错误");
        // 原地续跑（IA v4.2 §C3）:缺什么→去哪补→回来重试同一稿
        wxReceipt.appendChild(buildWechatRetryBlock(contentId, errText, doWxPush));
        return;
      }
      wxReceipt.textContent = "✅ 已推草稿箱 · 配图 " + (r.imageCount || 0) + " 张 · " + (r.nextStep || "");
      showToast("公众号草稿已推送");
    };
    wxBtn.addEventListener("click", () => void doWxPush());
  }

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
  el.appendChild(h("h2", {}, "校准中心 · 声音内核"));

  // 定位档案（B4）:定位是灵感过滤器的灵魂,可看可改
  const posRow = h("div", { class: "style-pos-row" });
  const posLabel = h("span", { class: "muted" }, "定位：");
  const posInput = h("input", { type: "text", class: "style-pos-input", placeholder: "如：AI 效率工具" });
  const posBtn = h("button", { class: "btn-mini" }, "保存");
  posBtn.addEventListener("click", async () => {
    const industry = posInput.value.trim();
    if (!industry) { showToast("定位不能为空"); return; }
    const r = await safeInvoke(window.autocrew.profileUpdate, { industry });
    showToast(r.ok ? "定位已更新——雷达入库过滤即刻生效" : (r.error || "保存失败"));
  });
  posRow.appendChild(posLabel);
  posRow.appendChild(posInput);
  posRow.appendChild(posBtn);
  el.appendChild(posRow);
  safeInvoke(window.autocrew.dashboardSummary, {}).then((r) => {
    if (r.ok && r.data && r.data.calibration && r.data.calibration.industry) posInput.value = r.data.calibration.industry;
  });

  // 平台席位（IA v4.2）:写稿/派活/发布只围绕这些平台。和定位放一起——都是「你是谁」
  const seatRow = h("div", { class: "style-seat-row" });
  seatRow.appendChild(h("span", { class: "muted" }, "席位："));
  const seatWrap = h("div", { class: "style-seat-wrap" });
  const paintSeats = (seats) => {
    seatWrap.innerHTML = "";
    for (const c of PLATFORM_CATALOG) {
      const on = seats.includes(c.id);
      const chip = h("button", {
        class: "seat-chip seat-chip-sm" + (on ? " seat-chip-on" : "") + (c.group === "en" ? " seat-chip-en" : ""),
      }, (on ? "✓ " : "") + c.label);
      chip.addEventListener("click", async () => {
        const next = on ? seats.filter((x) => x !== c.id) : [...seats, c.id];
        if (next.length === 0) { showToast("至少保留一个平台席位"); return; }
        const r = await safeInvoke(window.autocrew.profileUpdate, { platforms: next });
        if (!r.ok) { showToast(r.error || "保存失败"); return; }
        if (typeof refreshSeats === "function") await refreshSeats();
        showToast("席位已更新——写稿矩阵即刻生效");
        paintSeats(next);
      });
      seatWrap.appendChild(chip);
    }
  };
  paintSeats(userSeats());
  seatRow.appendChild(seatWrap);
  el.appendChild(seatRow);

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
initViews();
window.__reviewQueue = null;
// 后台任务收尾自动刷新（生成后台化）:占位稿转正/中断,看板与首页即时可见,不用手刷
(() => {
  let lastSettled = 0;
  EngineStore.subscribe((state) => {
    const settled = state.events.filter((e) => e.kind === "run_done" || e.kind === "run_failed").length;
    if (settled > lastSettled) {
      lastSettled = settled;
      if (typeof refreshActiveView === "function") refreshActiveView();
    }
  });
})();
initSidebar();

/** 席位水合（IA v4.2）:首屏渲染前拉一次 profile.platforms 进 window.__seats,
 *  矩阵/派活/校准都读它。profile 更新后调 refreshSeats() 重取。 */
async function refreshSeats() {
  const s = await safeInvoke(window.autocrew.onboardingStatus, {});
  window.__seats = (s.ok && s.data && Array.isArray(s.data.platforms)) ? s.data.platforms : [];
}

(async () => {
  await refreshSeats();
  bootOnboarding();
  switchView("dashboard"); // IA v4.2：经营层首页,看板降一级视图
})();
