/**
 * 看板 = 主区首页(IA v4.1,qingmo 设计细节原生重实现)。
 * 列:灵感库(Topic 卡)→ 在写 → 待审 → 待发布 → 已发布。卡 = 观点/idea(内容原子)。
 * 点卡 → 平台矩阵(全域:有稿进编辑器,无稿一键让总编辑生成,英文平台按裁决 F 显示未开通)。
 * 拖拽换列 = content:transition;每卡可删 → 回收站(软删除,可恢复)。
 * 顶部工作日志接引擎真实事件流(EngineStore)。
 */

const BOARD_COLUMNS = [
  { key: "idea", label: "灵感库", type: "topic", statuses: [] },
  { key: "writing", label: "在写", type: "content", statuses: ["topic_saved", "drafting", "draft_ready", "revision"] },
  { key: "review", label: "待审", type: "content", statuses: ["reviewing", "cover_pending"] },
  { key: "ready", label: "待发布", type: "content", statuses: ["approved", "publish_ready", "publishing"] },
  { key: "published", label: "已发布", type: "content", statuses: ["published"] },
];
const STATUS_COLUMN = {};
BOARD_COLUMNS.forEach((c, i) => c.statuses.forEach((s) => (STATUS_COLUMN[s] = i)));
/** 拖到某列 = 流转到该列代表状态(状态机校验,非法 toast 拒绝) */
const DROP_TARGET_STATUS = { writing: "draft_ready", review: "reviewing", ready: "publish_ready", published: "published" };

const VARIANT_STATUS = {
  topic_saved: "选题", drafting: "写中", draft_ready: "草稿", revision: "修订",
  reviewing: "待审", cover_pending: "待封面", approved: "已过审",
  publish_ready: "待发", publishing: "发布中", published: "已发", archived: "归档",
};
const BOARD_GLYPH = { scout: "侦", writer: "编", review: "审", analyst: "析", publisher: "发", system: "·" };

/** 全域平台矩阵(创始人定位:全域自媒体营销获客)。cn = 可生成;en = 席位未开通(PRD 裁决 F 排队) */
const MATRIX_CN = ["wechat_mp", "douyin", "xiaohongshu", "wechat_video", "bilibili"];
const MATRIX_EN = ["twitter", "instagram", "reddit"];

let boardAtoms = []; // [{ key, topic|null, members: Content[] }] 最近一次渲染的数据

/** 原子分组:topicId 优先(真脊椎),siblings 闭包兜底,孤稿自成原子 */
function groupBoardAtoms(topics, contents) {
  const atoms = [];
  const byTopic = new Map();
  const claimed = new Set();

  for (const c of contents) {
    if (c.topicId) {
      if (!byTopic.has(c.topicId)) byTopic.set(c.topicId, []);
      byTopic.get(c.topicId).push(c);
      claimed.add(c.id);
    }
  }
  const topicById = new Map(topics.map((t) => [t.id, t]));
  for (const [topicId, members] of byTopic) {
    atoms.push({ key: "t-" + topicId, topic: topicById.get(topicId) || null, members });
  }

  // siblings 闭包(无 topicId 的旧数据)
  const byId = new Map(contents.map((c) => [c.id, c]));
  for (const c of contents) {
    if (claimed.has(c.id)) continue;
    const members = [];
    const stack = [c.id];
    while (stack.length) {
      const id = stack.pop();
      if (claimed.has(id) || !byId.has(id)) continue;
      claimed.add(id);
      const m = byId.get(id);
      if (m.topicId) continue;
      members.push(m);
      for (const s of m.siblings || []) if (!claimed.has(s)) stack.push(s);
    }
    if (members.length) atoms.push({ key: "c-" + members[0].id, topic: null, members });
  }

  // 纯灵感:还没有任何稿的选题
  for (const t of topics) {
    if (!byTopic.has(t.id)) atoms.push({ key: "t-" + t.id, topic: t, members: [] });
  }
  return atoms;
}

function colRank(status) {
  return STATUS_COLUMN[status] === undefined ? -1 : STATUS_COLUMN[status];
}
function atomRep(atom) {
  return [...atom.members].sort((a, b) => colRank(b.status) - colRank(a.status))[0] || null;
}
function atomTitle(atom) {
  const rep = atomRep(atom);
  return (atom.topic && atom.topic.title) || (rep && rep.title) || "（无标题）";
}
function daysSince(iso) {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

// ── 卡片 ─────────────────────────────────────────────────────────────────────

function renderAtomCard(atom) {
  const rep = atomRep(atom);
  const card = h("div", { class: "atom-card" });

  const head = h("div", { class: "atom-head" });
  head.appendChild(h("div", { class: "atom-title" }, atomTitle(atom)));
  const del = h("button", { class: "atom-del", title: "移入回收站" }, "×");
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    await trashAtom(atom);
  });
  head.appendChild(del);
  card.appendChild(head);

  if (atom.topic && !rep) {
    if (atom.topic.source) card.appendChild(h("div", { class: "atom-sub" }, atom.topic.source));
  } else if (atom.members.length > 1) {
    card.appendChild(h("div", { class: "atom-sub" }, "1 母题 · " + atom.members.length + " 平台变体"));
  }

  if (rep) {
    const chips = h("div", { class: "atom-chips" });
    for (const m of atom.members) {
      const isPub = m.status === "published";
      const chip = h("button", { class: "atom-chip" + (isPub ? " atom-chip-pub" : "") },
        platformLabel(m.platform) + " " + (VARIANT_STATUS[m.status] || m.status));
      chip.addEventListener("click", (e) => { e.stopPropagation(); openInBoard(m.id, () => openMatrix(atom.key)); });
      chips.appendChild(chip);
    }
    card.appendChild(chips);
    // 防呆 P5:生成中断的稿必须在看板可见——占位卡 + 中断徽章,「写一半没了」到此为止
    const broken = atom.members.find((m) => m.lastError);
    if (broken) {
      card.appendChild(h("div", { class: "atom-error" }, "⚠ 生成中断,点开可重试"));
    }
    const stale = daysSince(rep.updatedAt || rep.createdAt);
    if (rep.status !== "published" && stale > 14) {
      card.appendChild(h("div", { class: "atom-stale" }, "停 " + stale + " 天"));
    }
    // 拖拽换状态(qingmo 设计细节)
    card.setAttribute("draggable", "true");
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/autocrew-content", rep.id);
      e.dataTransfer.effectAllowed = "move";
    });
  }

  card.addEventListener("click", () => openMatrix(atom.key));
  return card;
}

async function trashAtom(atom) {
  const rep = atomRep(atom);
  if (!rep && atom.topic) {
    const r = await safeInvoke(window.autocrew.topicDelete, { id: atom.topic.id });
    if (!r.ok) { showToast(r.error || "删除失败"); return; }
  } else {
    for (const m of atom.members) {
      const r = await safeInvoke(window.autocrew.contentDelete, { id: m.id });
      if (!r.ok) { showToast(r.error || "删除失败"); return; }
    }
  }
  showToast("已移入回收站（可从回收站恢复）");
  renderBoard();
}

// ── 看板 ─────────────────────────────────────────────────────────────────────

async function renderBoard() {
  const view = document.getElementById("view-board");
  if (!view) return;
  window.__wbOpenContent = null; // 回看板 = 离开单稿上下文（§C1）
  view.innerHTML = "";

  const worklog = h("div", { class: "board-worklog", id: "board-worklog" });
  view.appendChild(worklog);
  renderWorklogInto(worklog, (typeof EngineStore !== "undefined" && EngineStore.state.events) || []);
  refreshBoardWorklog();

  const boardMain = h("div", { class: "board-main", id: "board-main" });
  view.appendChild(boardMain);
  boardMain.appendChild(h("p", { class: "muted board-loading" }, "加载内容管线…"));

  const [tRes, cRes] = await Promise.all([
    safeInvoke(window.autocrew.topicsList),
    safeInvoke(window.autocrew.contentList),
  ]);
  boardMain.innerHTML = "";

  const topics = (tRes.ok && tRes.topics) || [];
  const contents = ((cRes.ok && cRes.contents) || []).filter((c) => c.status !== "archived");
  boardAtoms = groupBoardAtoms(topics, contents);

  const bar = h("div", { class: "board-bar" });
  bar.appendChild(h("span", { class: "card-kicker" }, "内容管线 · 卡片 = 一个想法"));
  const trashBtn = h("button", { class: "btn-mini" }, "回收站");
  trashBtn.addEventListener("click", renderTrash);
  bar.appendChild(trashBtn);
  boardMain.appendChild(bar);

  const cols = BOARD_COLUMNS.map(() => []);
  for (const atom of boardAtoms) {
    const rep = atomRep(atom);
    const ci = rep ? Math.max(1, colRank(rep.status)) : 0;
    cols[ci].push(atom);
  }

  const boardEl = h("div", { class: "kanban" });
  BOARD_COLUMNS.forEach((c, i) => {
    const col = h("div", { class: "kanban-col", "data-col": c.key });
    col.appendChild(h("div", { class: "kanban-col-head" }, c.label + " · " + cols[i].length));
    for (const atom of cols[i]) col.appendChild(renderAtomCard(atom));
    if (i === 0 && cols[0].length === 0) {
      col.appendChild(h("p", { class: "muted kanban-empty" }, "右边跟总编辑说一个想法，或让侦察员扫榜。"));
    }
    // 放置目标(内容卡拖入 → 流转)
    if (DROP_TARGET_STATUS[c.key]) {
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("kanban-col-over"); });
      col.addEventListener("dragleave", () => col.classList.remove("kanban-col-over"));
      col.addEventListener("drop", async (e) => {
        e.preventDefault();
        col.classList.remove("kanban-col-over");
        const contentId = e.dataTransfer.getData("text/autocrew-content");
        if (!contentId) return;
        const r = await safeInvoke(window.autocrew.contentTransition, { id: contentId, target_status: DROP_TARGET_STATUS[c.key] });
        if (!r.ok) { showToast(r.error || "流转失败（状态机拒绝了这一步）"); return; }
        renderBoard();
      });
    }
    boardEl.appendChild(col);
  });
  boardMain.appendChild(boardEl);
}

// ── 平台矩阵(点 idea 卡进入):全域自媒体的操作面 ────────────────────────────

function openMatrix(atomKey) {
  const atom = boardAtoms.find((a) => a.key === atomKey);
  if (!atom) { renderBoard(); return; }
  const boardMain = document.getElementById("board-main");
  if (!boardMain) return;
  boardMain.innerHTML = "";

  const back = h("button", { class: "btn-mini board-back" }, "← 看板");
  back.addEventListener("click", renderBoard);
  boardMain.appendChild(back);

  const wrap = h("div", { class: "matrix-wrap" });
  wrap.appendChild(h("div", { class: "matrix-title" }, atomTitle(atom)));
  if (atom.topic && atom.topic.description) {
    wrap.appendChild(h("div", { class: "muted matrix-desc" }, atom.topic.description));
  }
  wrap.appendChild(h("div", { class: "card-kicker matrix-kicker" }, "平台矩阵 · 有稿点开,无稿生成"));

  const grid = h("div", { class: "matrix-grid" });
  const byPlatform = new Map(atom.members.map((m) => [m.platform, m]));

  for (const p of MATRIX_CN) {
    const cell = h("div", { class: "matrix-cell" });
    cell.appendChild(h("div", { class: "matrix-platform" }, platformLabel(p)));
    const m = byPlatform.get(p);
    if (m) {
      const st = h("button", { class: "atom-chip" + (m.status === "published" ? " atom-chip-pub" : "") },
        VARIANT_STATUS[m.status] || m.status);
      st.addEventListener("click", () => openInBoard(m.id, () => openMatrix(atomKey)));
      cell.appendChild(st);
      const del = h("button", { class: "btn-mini matrix-del" }, "删除");
      del.addEventListener("click", async () => {
        const r = await safeInvoke(window.autocrew.contentDelete, { id: m.id });
        if (!r.ok) { showToast(r.error || "删除失败"); return; }
        showToast("已移入回收站");
        renderBoard();
      });
      cell.appendChild(del);
      cell.classList.add("matrix-cell-filled");
      cell.addEventListener("click", (e) => { if (e.target === cell) openInBoard(m.id, () => openMatrix(atomKey)); });
    } else {
      const gen = h("button", { class: "btn-mini" }, "生成");
      gen.addEventListener("click", () => {
        if (typeof sendChat === "function") {
          // 派活接缝（IA v4.2 §4）：brief 携带 Topic 全量上下文,灵感库的增值信息不许在派活瞬间蒸发
          let brief = "用选题《" + atomTitle(atom) + "》写一篇" + platformLabel(p) + "原生版本";
          const t = atom.topic;
          if (t) {
            const ctx = [];
            if (t.reason) ctx.push("入库理由：" + t.reason);
            if (t.description && t.description !== atomTitle(atom)) ctx.push("背景：" + t.description);
            if (t.link) ctx.push("参考链接：" + t.link + "（先用 read_url 读原文再写，不要凭标题脑补）");
            if (ctx.length) brief += "。选题上下文——" + ctx.join("；");
          }
          sendChat(brief);
          showToast("已派给总编辑——看右边对话和顶部日志");
        }
      });
      cell.appendChild(gen);
    }
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);

  // 出海席位默认折叠（IA v4.2 §1）：裁决 F 的诚实呈现保留,但不日常占据视觉
  const enFold = h("details", { class: "matrix-en-fold" });
  enFold.appendChild(h("summary", { class: "muted" }, "出海席位（未开通，排队中）"));
  const enGrid = h("div", { class: "matrix-grid" });
  for (const p of MATRIX_EN) {
    const cell = h("div", { class: "matrix-cell matrix-cell-locked" });
    cell.appendChild(h("div", { class: "matrix-platform" }, platformLabel(p)));
    cell.appendChild(h("div", { class: "matrix-locked" }, "席位未开通"));
    enGrid.appendChild(cell);
  }
  enFold.appendChild(enGrid);
  wrap.appendChild(enFold);
  boardMain.appendChild(wrap);
}

// ── 回收站(qingmo 设计细节:已删选题 + 已删稿件,逐项恢复)────────────────────

async function renderTrash() {
  const boardMain = document.getElementById("board-main");
  if (!boardMain) return;
  boardMain.innerHTML = "";
  const back = h("button", { class: "btn-mini board-back" }, "← 看板");
  back.addEventListener("click", renderBoard);
  boardMain.appendChild(back);
  boardMain.appendChild(h("div", { class: "matrix-title" }, "回收站"));

  const res = await safeInvoke(window.autocrew.trashList);
  if (!res.ok) { boardMain.appendChild(h("p", { class: "muted" }, res.error || "加载失败")); return; }
  const topics = res.topics || [];
  const contents = res.contents || [];
  if (topics.length === 0 && contents.length === 0) {
    boardMain.appendChild(h("p", { class: "empty-state" }, "回收站是空的。"));
    return;
  }
  const list = h("div", { class: "trash-list" });
  for (const t of topics) {
    const row = h("div", { class: "trash-row" });
    row.appendChild(h("span", { class: "trash-kind" }, "选题"));
    row.appendChild(h("span", { class: "trash-title" }, t.title));
    const btn = h("button", { class: "btn-mini" }, "恢复");
    btn.addEventListener("click", async () => {
      const r = await safeInvoke(window.autocrew.topicRestore, { id: t.id });
      if (!r.ok) { showToast(r.error || "恢复失败"); return; }
      renderTrash();
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
  for (const c of contents) {
    const row = h("div", { class: "trash-row" });
    row.appendChild(h("span", { class: "trash-kind" }, platformLabel(c.platform)));
    row.appendChild(h("span", { class: "trash-title" }, c.title || "（无标题）"));
    const btn = h("button", { class: "btn-mini" }, "恢复");
    btn.addEventListener("click", async () => {
      const r = await safeInvoke(window.autocrew.contentRestore, { id: c.id });
      if (!r.ok) { showToast(r.error || "恢复失败"); return; }
      renderTrash();
    });
    row.appendChild(btn);
    list.appendChild(row);
  }
  boardMain.appendChild(list);
}

/** 主区就地展开工作台;backFn 决定「返回」去向(矩阵或看板) */
async function openInBoard(contentId, backFn) {
  const boardMain = document.getElementById("board-main");
  if (!boardMain) return;
  boardMain.innerHTML = "";
  const back = h("button", { class: "btn-mini board-back" }, backFn ? "← 平台矩阵" : "← 看板");
  back.addEventListener("click", backFn || renderBoard);
  boardMain.appendChild(back);
  const wb = h("div", { class: "board-workbench" });
  boardMain.appendChild(wb);
  await renderWorkbench(contentId, wb);
}

// ── 工作日志(引擎真实事件流) ─────────────────────────────────────────────────

function renderWorklogInto(el, events) {
  if (!el) return;
  el.innerHTML = "";
  const recent = events.slice(-6);
  if (recent.length === 0) {
    el.appendChild(h("div", { class: "worklog-line worklog-idle" }, "> 编辑部就绪，等待第一个任务"));
    return;
  }
  for (const e of recent) {
    const t = new Date(e.ts);
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    const line = h("div", { class: "worklog-line" });
    line.appendChild(h("span", { class: "worklog-time" }, hh + ":" + mm));
    line.appendChild(h("span", { class: "worklog-glyph" }, BOARD_GLYPH[e.role] || "·"));
    line.appendChild(h("span", { class: "worklog-label" }, e.label));
    el.appendChild(line);
  }
  el.scrollTop = el.scrollHeight;
}

async function refreshBoardWorklog() {
  if (typeof EngineStore === "undefined" || !window.autocrew.eventsRecent) return;
  const res = await safeInvoke(window.autocrew.eventsRecent, { limit: 30 });
  if (res.ok) EngineStore.hydrateEvents(res.events || []);
}

if (typeof EngineStore !== "undefined") {
  EngineStore.subscribe((state) => {
    const el = document.getElementById("board-worklog");
    if (el) renderWorklogInto(el, state.events);
  });
}
