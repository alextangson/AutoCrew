/**
 * 看板 = 主区首页（PRD-v4 §7.3 IA v3）。每张卡 = 一个内容原子(sibling 闭包)，
 * 平台变体挂在卡身上；列 = 管线阶段。点卡/变体 → 主区就地展开工作台。
 * 顶部工作日志接引擎真实事件流(EngineStore)。
 */

const BOARD_COLUMNS = [
  { key: "writing", label: "在写", statuses: ["topic_saved", "drafting", "draft_ready", "revision"] },
  { key: "review", label: "待审", statuses: ["reviewing", "cover_pending"] },
  { key: "ready", label: "待发布", statuses: ["approved", "publish_ready", "publishing"] },
  { key: "published", label: "已发布", statuses: ["published"] },
];
const STATUS_COLUMN = {};
BOARD_COLUMNS.forEach((c, i) => c.statuses.forEach((s) => (STATUS_COLUMN[s] = i)));
const VARIANT_STATUS = {
  topic_saved: "选题", drafting: "写中", draft_ready: "草稿", revision: "修订",
  reviewing: "待审", cover_pending: "待封面", approved: "已过审",
  publish_ready: "待发", publishing: "发布中", published: "已发", archived: "归档",
};
const BOARD_GLYPH = { scout: "侦", writer: "编", review: "审", analyst: "析", publisher: "发", system: "·" };

/** sibling 闭包分组：每个 group = 一个内容原子的所有平台成员 */
function groupAtoms(contents) {
  const byId = new Map(contents.map((c) => [c.id, c]));
  const seen = new Set();
  const atoms = [];
  for (const c of contents) {
    if (seen.has(c.id)) continue;
    const members = [];
    const stack = [c.id];
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id) || !byId.has(id)) continue;
      seen.add(id);
      const m = byId.get(id);
      members.push(m);
      for (const s of m.siblings || []) if (!seen.has(s)) stack.push(s);
    }
    atoms.push(members);
  }
  return atoms;
}

function colRank(status) {
  return STATUS_COLUMN[status] === undefined ? -1 : STATUS_COLUMN[status];
}

function daysSince(iso) {
  if (!iso) return 0;
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  return Math.floor(d);
}

function renderAtomCard(members) {
  // 代表 = 阶段最靠后的成员，决定卡片落哪列与标题
  const rep = [...members].sort((a, b) => colRank(b.status) - colRank(a.status))[0];
  const card = h("div", { class: "atom-card" });
  card.appendChild(h("div", { class: "atom-title" }, rep.title || "（无标题）"));
  if (members.length > 1) {
    card.appendChild(h("div", { class: "atom-sub" }, "1 母题 · " + members.length + " 平台变体"));
  }
  const chips = h("div", { class: "atom-chips" });
  for (const m of members) {
    const isPub = m.status === "published";
    const chip = h("button", { class: "atom-chip" + (isPub ? " atom-chip-pub" : "") },
      platformLabel(m.platform) + " " + (VARIANT_STATUS[m.status] || m.status));
    chip.addEventListener("click", (e) => { e.stopPropagation(); openInBoard(m.id); });
    chips.appendChild(chip);
  }
  card.appendChild(chips);
  // 停滞告警：非已发布且代表 >14 天没动
  const stale = daysSince(rep.updatedAt || rep.createdAt);
  if (rep.status !== "published" && stale > 14) {
    card.appendChild(h("div", { class: "atom-stale" }, "停 " + stale + " 天"));
  }
  card.addEventListener("click", () => openInBoard(rep.id));
  return card;
}

async function renderBoard() {
  const view = document.getElementById("view-board");
  if (!view) return;
  view.innerHTML = "";

  const worklog = h("div", { class: "board-worklog", id: "board-worklog" });
  view.appendChild(worklog);

  const boardMain = h("div", { class: "board-main", id: "board-main" });
  view.appendChild(boardMain);

  renderWorklogInto(worklog, (typeof EngineStore !== "undefined" && EngineStore.state.events) || []);
  refreshBoardWorklog();

  boardMain.appendChild(h("p", { class: "muted board-loading" }, "加载内容管线…"));
  const res = await safeInvoke(window.autocrew.contentList);
  boardMain.innerHTML = "";
  const contents = (res.ok && res.contents) || [];
  const active = contents.filter((c) => c.status !== "archived");
  if (active.length === 0) {
    boardMain.appendChild(h("p", { class: "empty-state" },
      "还没有内容。右边跟总编辑说一句「帮我写一篇关于…」，稿子会出现在这条管线上。"));
    return;
  }

  const atoms = groupAtoms(active);
  const cols = BOARD_COLUMNS.map(() => []);
  for (const members of atoms) {
    const rep = [...members].sort((a, b) => colRank(b.status) - colRank(a.status))[0];
    const ci = Math.max(0, colRank(rep.status));
    cols[ci].push(members);
  }

  const boardEl = h("div", { class: "kanban" });
  BOARD_COLUMNS.forEach((c, i) => {
    const col = h("div", { class: "kanban-col" });
    col.appendChild(h("div", { class: "kanban-col-head" }, c.label + " · " + cols[i].length));
    for (const members of cols[i]) col.appendChild(renderAtomCard(members));
    boardEl.appendChild(col);
  });
  boardMain.appendChild(boardEl);
}

/** 主区就地展开工作台：看板 → 稿件编辑(带返回) */
async function openInBoard(contentId) {
  const boardMain = document.getElementById("board-main");
  if (!boardMain) return;
  boardMain.innerHTML = "";
  const back = h("button", { class: "btn-mini board-back" }, "← 看板");
  back.addEventListener("click", renderBoard);
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

// 订阅一次：事件流增量 → 刷新看板顶部日志(看板未挂载则安静跳过)
if (typeof EngineStore !== "undefined") {
  EngineStore.subscribe((state) => {
    const el = document.getElementById("board-worklog");
    if (el) renderWorklogInto(el, state.events);
  });
}
