/**
 * Card renderers — PRD §7.3 呈现层：6 类卡片。
 * 卡片操作与说话等价（双通道走同一 IPC）。依赖 dom.js 的 h()/safeInvoke 等。
 */

function renderCard(card) {
  switch (card.type) {
    case "draft": return renderDraftCard(card.data);
    case "report": return renderReportCard(card.data);
    case "drafts_list": return renderDraftsListCard(card.data);
    case "style": return renderStyleCard(card.data);
    case "publish": return renderPublishCard(card.data);
    case "published": return renderPublishedCard(card.data);
    case "topic": return renderTopicCard(card.data);
    case "topic_saved": return renderTopicSavedCard(card.data);
    case "assets": return renderAssetsCard(card.data);
    default: {
      const pre = h("pre", { class: "card-body" });
      pre.textContent = JSON.stringify(card.data, null, 2);
      return h("div", { class: "chat-card" }, pre);
    }
  }
}

// 角色 → 徽字 / 名称映射（常量，XSS 安全）
const CREW_META = {
  scout:   { badge: "侦", name: "选题侦察员" },
  writer:  { badge: "编", name: "编剧" },
  review:  { badge: "审", name: "合规审核员" },
  analyst: { badge: "析", name: "数据分析师" },
};

/**
 * cardShell(kicker, title, role?)
 * role: "scout" | "writer" | "review" | "analyst" | undefined
 * 有 role 时：加左缘条 class + 渲染署名行（徽 + 角色名 + kicker 右移）
 * 无 role 时：退回旧行为（card-kicker 行 + 可选 card-title 行）
 */
function cardShell(kicker, title, role) {
  const cls = role
    ? "chat-card card-crew card-crew-" + role
    : "chat-card";
  const el = h("div", { class: cls });

  if (role && CREW_META[role]) {
    const meta = CREW_META[role];
    const byline = h("div", { class: "card-byline" });
    byline.appendChild(h("span", { class: "byline-badge byline-badge-" + role }, meta.badge));
    byline.appendChild(h("span", { class: "byline-role byline-role-" + role }, meta.name));
    if (kicker) byline.appendChild(h("span", { class: "byline-kicker" }, kicker));
    el.appendChild(byline);
  } else {
    el.appendChild(h("div", { class: "card-kicker" }, kicker));
  }

  if (title) el.appendChild(h("div", { class: "card-title" }, title));
  return el;
}

function renderDraftCard(d) {
  const id = d.contentId || d.id; // get_draft 推原始 Content（主键 id），其余统一 contentId
  const el = cardShell("稿件" + (d.platform ? " · " + platformLabel(d.platform) : ""), d.title || "（无标题）", "writer");
  if (d.violations && d.violations.length > 0) {
    const warn = h("div", { class: "card-warn" });
    warn.appendChild(h("strong", {}, "风格违规警告"));
    const ul = h("ul", {});
    for (const v of d.violations) ul.appendChild(h("li", {}, v));
    warn.appendChild(ul);
    el.appendChild(warn);
  }
  const body = h("pre", { class: "card-body" });
  body.textContent = d.body || "";
  el.appendChild(body);
  if (d.hashtags && d.hashtags.length > 0) {
    const wrap = h("div", { class: "tag-wrap" });
    for (const t of d.hashtags) wrap.appendChild(h("span", { class: "tag" }, t));
    el.appendChild(wrap);
  }
  const actions = h("div", { class: "card-actions" });
  const openBtn = h("button", { class: "btn-mini" }, "在工作区打开");
  openBtn.addEventListener("click", () => switchView("drafts"));
  actions.appendChild(openBtn);
  const publishBtn = h("button", { class: "btn-mini" }, "排版发布文案");
  publishBtn.addEventListener("click", () => {
    if (id) sendChat("把稿件 " + id + " 排版成发布文案");
  });
  actions.appendChild(publishBtn);
  el.appendChild(actions);
  return el;
}

function renderReportCard(d) {
  const el = cardShell("回流报告", null, "analyst");
  const row = h("div", { class: "card-metric-row" });
  const completionRate = d.avgMetrics && d.avgMetrics.completionRate !== undefined
    ? d.avgMetrics.completionRate + "%" : "—";
  const avgViews = d.avgMetrics && d.avgMetrics.views !== undefined
    ? Math.round(d.avgMetrics.views).toLocaleString("zh-CN") : "—";
  const metrics = [
    ["作品数", d.works ? String(d.works.total) : "0"],
    ["平均播放", avgViews],
    ["平均完播率", completionRate],
  ];
  for (const [label, value] of metrics) {
    row.appendChild(h("div", { class: "card-metric" },
      h("div", { class: "metric-value" }, value),
      h("div", { class: "metric-label" }, label),
    ));
  }
  el.appendChild(row);
  if (d.baselineInsights && d.baselineInsights.length > 0) {
    const ul = h("ul", { class: "insight-list" });
    for (const ins of d.baselineInsights.slice(0, 3)) ul.appendChild(h("li", {}, ins));
    el.appendChild(ul);
  }
  const actions = h("div", { class: "card-actions" });
  const openBtn = h("button", { class: "btn-mini" }, "查看完整报告");
  openBtn.addEventListener("click", () => switchView("report"));
  actions.appendChild(openBtn);
  el.appendChild(actions);
  return el;
}

function renderDraftsListCard(d) {
  const contents = d.contents || [];
  const el = cardShell("稿件列表", contents.length + " 篇", "writer");
  const ul = h("ul", { class: "insight-list" });
  for (const c of contents.slice(0, 8)) {
    ul.appendChild(h("li", {},
      (c.title || "（无标题）") + " · " + platformLabel(c.platform) + " · " + statusLabel(c.status)));
  }
  el.appendChild(ul);
  const actions = h("div", { class: "card-actions" });
  const openBtn = h("button", { class: "btn-mini" }, "在工作区打开");
  openBtn.addEventListener("click", () => switchView("drafts"));
  actions.appendChild(openBtn);
  el.appendChild(actions);
  return el;
}

function renderStyleCard(d) {
  const el = cardShell("风格", null, "writer");
  if (d.rule) {
    el.appendChild(h("p", {}, "已记住偏好：" + d.rule));
  } else {
    el.appendChild(h("p", {}, d.summary || d.message || "风格档案已更新"));
  }
  const actions = h("div", { class: "card-actions" });
  const openBtn = h("button", { class: "btn-mini" }, "管理风格规则");
  openBtn.addEventListener("click", () => switchView("style"));
  actions.appendChild(openBtn);
  el.appendChild(actions);
  return el;
}

/** 发布确认门 — 内嵌对话流的人类确认（PRD §7.3：不弹模态） */
function renderPublishCard(d) {
  const el = cardShell("发布", "文案已排版，复制后到平台粘贴", "review");
  const body = h("pre", { class: "card-body" });
  body.textContent = d.copyText || "";
  el.appendChild(body);

  const actions = h("div", { class: "card-actions" });
  const copyBtn = h("button", { class: "btn-mini" }, "复制");
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(d.copyText || "");
      showToast("已复制到剪贴板");
    } catch {
      showToast("剪贴板写入失败，请手动复制");
    }
  });
  actions.appendChild(copyBtn);
  el.appendChild(actions);

  const urlInput = h("input", { type: "text", placeholder: "发布链接（可选）", class: "input-full" });
  el.appendChild(urlInput);
  const confirmBtn = h("button", { class: "btn-secondary" }, "我已发布，确认");
  confirmBtn.dataset.label = "我已发布，确认";
  confirmBtn.addEventListener("click", async () => {
    setLoading(confirmBtn, true, "确认中...");
    const payload = { content_id: d.contentId };
    const url = urlInput.value.trim();
    if (url) payload.publish_url = url;
    const r = await safeInvoke(window.autocrew.publishConfirm, payload);
    setLoading(confirmBtn, false);
    if (!r.ok) {
      showToast(r.error || "确认发布失败");
      return;
    }
    confirmBtn.replaceWith(h("p", { class: "success-msg" }, "已标记为已发布"));
    urlInput.remove();
  });
  el.appendChild(confirmBtn);
  return el;
}

function renderPublishedCard(d) {
  const el = cardShell("发布", null, "review");
  el.appendChild(h("p", { class: "success-msg" }, "稿件 " + (d.contentId || "") + " 已标记为已发布"));
  return el;
}

function renderTopicCard(d) {
  const el = cardShell(d.industry ? "选题雷达 · " + d.industry : "选题雷达", "今日候选选题", "scout");
  const list = h("ol", { class: "md-list topic-list" });
  const candidates = d.candidates || [];
  const sourceTag = d.industry && d.industry.indexOf("海外") === 0 ? "overseas:" : "radar:";
  for (const c of candidates.slice(0, 10)) {
    const li = h("li", { class: "topic-item" });
    li.appendChild(h("span", {}, c.title + "（" + (c.source || "?") + "）"));
    // 落库是确定性动作,直走 topic:create,零 token（IA v4.2 §A2）
    const saveCandidate = () => safeInvoke(window.autocrew.topicCreate, {
      title: c.title,
      reason: "从候选看中 · " + (c.source || "雷达"),
      source: sourceTag + (c.source || "unknown"),
      link: c.link || undefined,
    });
    const saveBtn = h("button", { class: "btn-mini" }, "存灵感库");
    saveBtn.addEventListener("click", async () => {
      const r = await saveCandidate();
      if (!r.ok) { showToast(r.error || "入库失败"); return; }
      showToast("已存入灵感库");
      if (typeof refreshActiveView === "function") refreshActiveView();
    });
    li.appendChild(saveBtn);
    const writeBtn = h("button", { class: "btn-mini" }, "就这个写");
    writeBtn.addEventListener("click", async () => {
      // 单一入口池:开写的选题同时入库,不许绕过灵感库（IA v4.2 §4）
      await saveCandidate();
      sendChat("用选题《" + c.title + "》给我写一条口播" + (c.link ? "。参考链接：" + c.link + "（先用 read_url 读原文再写）" : ""));
    });
    li.appendChild(writeBtn);
    list.appendChild(li);
  }
  el.appendChild(list);
  return el;
}

/** save_topic 工具的回执卡（IA v4.2 §A2）——对话里的想法落库确认 */
function renderTopicSavedCard(d) {
  const el = cardShell("灵感库", "已入库", "scout");
  el.appendChild(h("p", { class: "topic-saved-title" }, "💡 " + (d.title || "")));
  if (d.reason) el.appendChild(h("p", { class: "muted" }, d.reason));
  const actions = h("div", { class: "card-actions" });
  const openBtn = h("button", { class: "btn-mini" }, "去看板");
  openBtn.addEventListener("click", () => {
    switchView("board");
    if (typeof refreshActiveView === "function") refreshActiveView();
  });
  actions.appendChild(openBtn);
  el.appendChild(actions);
  return el;
}

function renderAssetsCard(d) {
  const assets = d.assets || [];
  const el = cardShell("素材库" + (d.query ? " · 「" + d.query + "」" : ""), assets.length + " 条素材", "writer");
  const ul = h("ul", { class: "insight-list" });
  for (const a of assets.slice(0, 8)) {
    ul.appendChild(h("li", {},
      (LIB_TYPE_ICON[a.type] || "📄") + " " + a.name +
      ((a.tags || []).length ? " · " + a.tags.join("/") : "") +
      (a.missing ? "（文件丢失）" : "")));
  }
  el.appendChild(ul);
  const actions = h("div", { class: "card-actions" });
  const openBtn = h("button", { class: "btn-mini" }, "打开素材库");
  openBtn.addEventListener("click", () => switchView("library"));
  actions.appendChild(openBtn);
  el.appendChild(actions);
  return el;
}

/** 审核员工作档案卡（S2.6）——合规是 always-on，不造假配置，卡片只做说明 */
function appendReviewerCard() {
  const el = cardShell("工作档案", "合规审核员", "review");
  el.appendChild(h("p", {}, "每篇稿件发布前自动过 6 项检查，全程无需配置："));
  const ul = h("ul", { class: "md-list" });
  for (const item of [
    "违禁词 / 极限词过滤（全程 always-on）",
    "内容完整审核",
    "封面要求（小红书/抖音必查）",
    "话题标签 ≥ 1",
    "标题符合平台字数规范",
    "正文字数达标",
  ]) {
    ul.appendChild(h("li", {}, item));
  }
  el.appendChild(ul);
  el.appendChild(h("p", { class: "muted" },
    "口径声明：过滤目标是「符合平台规则」，不是绕过审核或 AI 标识（合规红线）。"));
  appendCardToStream(el);
}
