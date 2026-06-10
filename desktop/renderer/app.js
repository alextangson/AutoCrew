/**
 * AutoCrew Desktop Renderer — four screens, zero frameworks.
 * window.autocrew is exposed by preload.ts via contextBridge.
 * No innerHTML with user data — all user content via textContent or h().
 */

// ── DOM helper ────────────────────────────────────────────────────────────────

/**
 * h(tag, attrs?, ...children) — minimal DOM builder.
 * attrs: plain object of attribute key→value (class, id, type, etc.)
 * children: strings (→ text nodes) or Element nodes.
 */
function h(tag, attrsOrChild, ...rest) {
  const el = document.createElement(tag);
  let children = rest;

  if (attrsOrChild !== null && attrsOrChild !== undefined) {
    if (typeof attrsOrChild === "string" || attrsOrChild instanceof Node) {
      children = [attrsOrChild, ...rest];
    } else if (typeof attrsOrChild === "object" && !Array.isArray(attrsOrChild)) {
      for (const [k, v] of Object.entries(attrsOrChild)) {
        if (k === "class") el.className = v;
        else if (k === "style") el.style.cssText = v;
        else el.setAttribute(k, v);
      }
    }
  }

  for (const child of children) {
    if (child === null || child === undefined) continue;
    if (typeof child === "string" || typeof child === "number") {
      el.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      el.appendChild(child);
    }
  }
  return el;
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let toastTimer = null;

function showToast(msg) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 5000);
}

// ── Nav / screen switching ────────────────────────────────────────────────────

function switchScreen(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-link").forEach(l => l.classList.remove("active"));
  document.getElementById("screen-" + name).classList.add("active");
  document.querySelector('[data-screen="' + name + '"]').classList.add("active");

  if (name === "report") initReport();
  if (name === "generate") initGenerate();
  if (name === "drafts") initDrafts();
  if (name === "style") initStyle();
}

document.querySelectorAll(".nav-link").forEach(link => {
  link.addEventListener("click", e => {
    e.preventDefault();
    switchScreen(link.dataset.screen);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function setLoading(btn, loading, label) {
  btn.disabled = loading;
  btn.textContent = loading ? (label || "处理中...") : btn.dataset.label;
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function platformLabel(p) {
  const m = {
    douyin: "抖音", xiaohongshu: "小红书", wechat_mp: "微信公众号",
    wechat_video: "视频号", bilibili: "B站",
  };
  return m[p] || p || "—";
}

function statusLabel(s) {
  const m = {
    draft_ready: "草稿就绪", drafting: "草稿中", reviewing: "审核中",
    approved: "已审批", publish_ready: "待发布", published: "已发布",
    archived: "已归档", topic_saved: "选题已存", cover_pending: "等待封面",
    publishing: "发布中", revision: "修改中",
  };
  return m[s] || s || "—";
}

// ── Report screen ─────────────────────────────────────────────────────────────

async function initReport() {
  const el = document.getElementById("screen-report");
  el.innerHTML = "";
  el.appendChild(h("h2", {}, "回流报告"));

  const loading = h("p", { class: "muted" }, "加载中...");
  el.appendChild(loading);

  const res = await window.autocrew.flywheelReport();
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

  const completionRate = d.avgMetrics && d.avgMetrics.completionRate !== undefined
    ? (d.avgMetrics.completionRate * 100).toFixed(1) + "%"
    : "—";
  const avgViews = d.avgMetrics && d.avgMetrics.views !== undefined
    ? Math.round(d.avgMetrics.views).toLocaleString("zh-CN")
    : "—";
  const traitPct = d.traitSampleSize !== undefined
    ? Math.round((d.traitSampleSize / 3) * 100) + "%"
    : "—";

  const cards = [
    ["作品数", d.works ? String(d.works.total) : "0"],
    ["平均播放", avgViews],
    ["平均完播率", completionRate],
    ["打标进度", traitPct],
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

// ── Generate screen ───────────────────────────────────────────────────────────

let generateInitialized = false;

function initGenerate() {
  if (generateInitialized) return;
  generateInitialized = true;

  const el = document.getElementById("screen-generate");
  el.innerHTML = "";
  el.appendChild(h("h2", {}, "生成脚本"));

  const form = h("div", { class: "form-section" });

  // Topic
  const topicLabel = h("label", {}, "主题");
  const topicInput = h("input", { type: "text", placeholder: "例：职场新人如何快速上手 Excel", class: "input-full" });
  form.appendChild(topicLabel);
  form.appendChild(topicInput);

  // Platform
  const platformLabel2 = h("label", {}, "平台");
  const platformSelect = h("select", { class: "input-full" });
  const platforms = [
    ["douyin", "抖音"], ["xiaohongshu", "小红书"],
    ["wechat_video", "视频号"], ["wechat_mp", "微信公众号"], ["bilibili", "B站"],
  ];
  for (const [val, label] of platforms) {
    const opt = h("option", { value: val }, label);
    platformSelect.appendChild(opt);
  }
  form.appendChild(platformLabel2);
  form.appendChild(platformSelect);

  // Research
  const researchLabel = h("label", {}, "参考素材（可选）");
  const researchArea = h("textarea", {
    placeholder: "粘贴相关资料、数据或竞品文案……",
    class: "input-full textarea-research",
  });
  form.appendChild(researchLabel);
  form.appendChild(researchArea);

  // Button
  const genBtn = h("button", { class: "btn-primary" }, "生成");
  genBtn.dataset.label = "生成";
  form.appendChild(genBtn);

  el.appendChild(form);

  // Result area
  const resultArea = h("div", { id: "generate-result" });
  el.appendChild(resultArea);

  genBtn.addEventListener("click", async () => {
    const topic = topicInput.value.trim();
    const platform = platformSelect.value;
    const research = researchArea.value.trim();

    if (!topic) {
      showToast("请填写主题");
      return;
    }

    setLoading(genBtn, true, "生成中...");
    resultArea.innerHTML = "";

    const payload = { topic, platform };
    if (research) payload.research = research;

    const res = await window.autocrew.generateScript(payload);
    setLoading(genBtn, false);

    if (!res.ok) {
      showToast("生成失败");
      const errBox = h("div", { class: "error-box" });
      errBox.appendChild(h("strong", {}, "生成失败"));
      errBox.appendChild(h("pre", { class: "error-pre" }, res.error || "未知错误"));
      resultArea.appendChild(errBox);
      return;
    }

    const d = res.data;

    // Violations warning
    if (d.violations && d.violations.length > 0) {
      const warn = h("div", { class: "violations-box" });
      warn.appendChild(h("strong", {}, "风格违规警告"));
      const vList = h("ul", {});
      for (const v of d.violations) {
        vList.appendChild(h("li", {}, v));
      }
      warn.appendChild(vList);
      resultArea.appendChild(warn);
    }

    // Title
    resultArea.appendChild(h("div", { class: "result-card" },
      h("div", { class: "result-label" }, "标题"),
      h("div", { class: "result-title" }, d.title || ""),
    ));

    // Body
    const bodyCard = h("div", { class: "result-card" });
    bodyCard.appendChild(h("div", { class: "result-label" }, "正文"));
    const bodyPre = h("pre", { class: "result-body" });
    bodyPre.textContent = d.body || "";
    bodyCard.appendChild(bodyPre);
    resultArea.appendChild(bodyCard);

    // Hashtags
    if (d.hashtags && d.hashtags.length > 0) {
      const tagRow = h("div", { class: "result-card" });
      tagRow.appendChild(h("div", { class: "result-label" }, "话题标签"));
      const tagWrap = h("div", { class: "tag-wrap" });
      for (const tag of d.hashtags) {
        tagWrap.appendChild(h("span", { class: "tag" }, tag));
      }
      tagRow.appendChild(tagWrap);
      resultArea.appendChild(tagRow);
    }

    // Tokens
    resultArea.appendChild(h("p", { class: "muted" }, "消耗 tokens：" + (d.tokensUsed || 0)));

    // Nav link to drafts
    const navLink = h("a", { href: "#", class: "link-btn" }, "去稿件屏查看 →");
    navLink.addEventListener("click", e => {
      e.preventDefault();
      switchScreen("drafts");
    });
    resultArea.appendChild(navLink);
  });
}

// ── Drafts screen ─────────────────────────────────────────────────────────────

async function initDrafts() {
  const el = document.getElementById("screen-drafts");
  el.innerHTML = "";
  el.appendChild(h("h2", {}, "稿件"));

  const loading = h("p", { class: "muted" }, "加载中...");
  el.appendChild(loading);

  const res = await window.autocrew.contentList();
  el.removeChild(loading);

  if (!res.ok) {
    showToast(res.error || "加载稿件失败");
    el.appendChild(h("p", { class: "empty-state" },
      "无法加载稿件。请先在「生成」屏创建内容。"));
    return;
  }

  // contentList returns { ok, contents } (not data.contents)
  const contents = res.contents || [];

  if (contents.length === 0) {
    el.appendChild(h("p", { class: "empty-state" },
      "暂无稿件。前往「生成」屏创建第一篇内容。"));
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

  const res = await window.autocrew.contentGet({ id: contentId });
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
    const r = await window.autocrew.publishClipboard({ content_id: contentId });
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
    const r = await window.autocrew.publishConfirm(payload);
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
  if (styleInitialized) return;
  styleInitialized = true;

  const el = document.getElementById("screen-style");
  el.innerHTML = "";
  el.appendChild(h("h2", {}, "风格"));

  // Rules section (loaded async)
  const rulesSection = h("div", { id: "style-rules-section" });
  el.appendChild(rulesSection);
  loadStyleRules(rulesSection);

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
    const res = await window.autocrew.styleDistill();
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
    loadStyleRules(rulesSection);
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
    const res = await window.autocrew.styleAbsorb({ samples: lines });
    setLoading(absorbBtn, false);

    if (!res.ok) {
      showToast(res.error || "风格吸收失败");
      return;
    }
    const data = res.data || res;
    const msg = data.summary || data.message || "已更新风格规则";
    absorbResult.appendChild(h("p", { class: "success-msg" }, msg));
    // Reload rules
    loadStyleRules(rulesSection);
  });
}

async function loadStyleRules(container) {
  container.innerHTML = "";
  container.appendChild(h("h3", {}, "写作规则"));

  const loading = h("p", { class: "muted" }, "加载中...");
  container.appendChild(loading);

  const res = await window.autocrew.styleRules();
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
    for (const rule of rules) {
      list.appendChild(h("li", {}, typeof rule === "string" ? rule : JSON.stringify(rule)));
    }
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

initReport();
