/**
 * 今日工作台首屏（S3.0）——创作者母语 home：存在感条 + 选题雷达 + 进行中 +
 * 数据回流 + 最近任务 + 命令栏。数据源 today:summary（一次聚合）。依赖 dom.js / views.js / chat.js。
 */

const TODAY_CREW = [
  { role: "scout", badge: "侦", name: "选题侦察员", view: "scout" },
  { role: "writer", badge: "编", name: "编剧", view: "style" },
  { role: "review", badge: "审", name: "合规审核员", view: null },
  { role: "analyst", badge: "析", name: "数据分析师", view: "report" },
];

const TODAY_ROLE_GLYPH = { scout: "侦", writer: "编", review: "审", analyst: "析", publisher: "发", system: "·" };
const QUEUE_STATUSES = { draft_ready: "草稿就绪", reviewing: "待审", revision: "修订中" };

function todayFmtViews(n) {
  if (typeof n !== "number") return "—";
  if (n >= 10000) return (n / 10000).toFixed(1) + " 万";
  return n.toLocaleString("zh-CN");
}

/** 构建今日首屏静态骨架，返回 await 后仍需写入的卡片引用。 */
function buildTodayShell(el) {
  el.innerHTML = "";
  const wrap = h("div", { class: "today-wrap" });
  el.appendChild(wrap);

  const header = h("div", { class: "today-header" });
  const hLeft = h("div", {});
  hLeft.appendChild(h("div", { class: "today-greeting" }, "今天想做点什么？"));
  const sub = h("div", { class: "today-sub muted" }, "加载中…");
  hLeft.appendChild(sub);
  header.appendChild(hLeft);
  const presence = h("div", { class: "today-presence" });
  for (const c of TODAY_CREW) {
    const av = h("span", {
      class: "presence-av byline-badge byline-badge-" + c.role,
      "data-role": c.role, "data-name": c.name, title: c.name,
    }, c.badge);
    av.addEventListener("click", () => {
      if (c.view) switchView(c.view);
      else { switchView("conversation"); if (typeof appendReviewerCard === "function") appendReviewerCard(); }
    });
    presence.appendChild(av);
  }
  header.appendChild(presence);
  wrap.appendChild(header);

  // 工作日志条（P1 一期）：引擎真实事件流的读模型——只显示真实发生过的事
  const worklog = h("div", { class: "today-worklog", id: "today-worklog" });
  wrap.appendChild(worklog);

  const radarCard = h("div", { class: "today-card", id: "today-radar" }, h("p", { class: "muted" }, "侦察员扫榜中…"));
  wrap.appendChild(radarCard);

  // 待审队列（P1 一期）：日常操作的核心组件，审稿不离开今日
  const queueCard = h("div", { class: "today-card", id: "today-queue" });
  wrap.appendChild(queueCard);

  const row = h("div", { class: "today-row" });
  const pipeCard = h("div", { class: "today-card today-card-half", id: "today-pipe" });
  const dataCard = h("div", { class: "today-card today-card-half", id: "today-data" });
  row.appendChild(pipeCard);
  row.appendChild(dataCard);
  wrap.appendChild(row);

  const recent = h("div", { class: "today-recent", id: "today-recent" });
  wrap.appendChild(recent);

  const bar = h("div", { class: "today-cmd" });
  const input = h("textarea", { class: "today-cmd-input", rows: "1", placeholder: "直接说需求，比如：帮我写一条关于 Excel 快捷键的抖音口播…" });
  const sendBtn = h("button", { class: "btn-primary" }, "发送");
  const submit = () => {
    if (chatBusy) { showToast("正在干活，稍等片刻"); return; }
    const v = input.value.trim();
    if (!v) return;
    input.value = "";
    sendChat(v);
  };
  sendBtn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  bar.appendChild(input);
  bar.appendChild(sendBtn);
  wrap.appendChild(bar);

  return { sub, radarCard, pipeCard, dataCard };
}

// 重入守卫：renderToday 同步清空 #view-today 后才 await today:summary，
// 重叠调用（连点导航 / 扫榜后再切）会互相抹掉对方 DOM。串行化——后到者在前一次释放前直接放弃。
let todayRendering = false;

async function renderToday() {
  if (todayRendering) return;
  todayRendering = true;
  try {
    const { sub, radarCard, pipeCard, dataCard } = buildTodayShell(document.getElementById("view-today"));
    refreshRecentTasks();
    refreshWorklog();
    refreshQueue();
    const res = await safeInvoke(window.autocrew.todaySummary);
    if (!res.ok) { sub.textContent = "数据加载失败"; return; }
    const d = res.data || {};
    sub.textContent = (d.industry || "未设置赛道") + " · " + new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
    renderRadarCard(radarCard, d.radar || { topics: [] });
    renderPipeCard(pipeCard, d.pipeline || {});
    renderDataCard(dataCard, d.lastOutcome);
  } finally {
    todayRendering = false;
  }
}

function renderRadarCard(card, radar) {
  card.innerHTML = "";
  const topics = radar.topics || [];
  card.appendChild(h("div", { class: "card-kicker" }, "选题雷达 · 侦察员挑了 " + Math.min(topics.length, 3) + " 条"));
  if (topics.length === 0) {
    card.appendChild(h("p", { class: "muted" }, "雷达暂无候选。"));
    const btn = h("button", { class: "btn-mini" }, "立即扫榜");
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = "扫榜中…";
      const r = await safeInvoke(window.autocrew.radarRefresh);
      if (!r.ok) { showToast(r.error || "扫榜失败"); btn.disabled = false; btn.textContent = "立即扫榜"; return; }
      renderToday();
    });
    card.appendChild(btn);
    return;
  }
  const list = h("div", { class: "today-topics" });
  for (const t of topics.slice(0, 3)) {
    const r = h("div", { class: "today-topic" });
    r.appendChild(h("div", { class: "today-topic-main" }, t.title));
    r.appendChild(h("div", { class: "muted today-topic-src" }, t.source || ""));
    const btn = h("button", { class: "btn-mini" }, "就这个写");
    btn.addEventListener("click", () => sendChat("用选题《" + t.title + "》给我写一条口播"));
    r.appendChild(btn);
    list.appendChild(r);
  }
  card.appendChild(list);
}

function renderPipeCard(card, p) {
  card.innerHTML = "";
  card.appendChild(h("div", { class: "card-kicker" }, "进行中"));
  const counts = h("div", { class: "pipe-counts" });
  for (const [label, n] of [["草稿", p.draft || 0], ["待审", p.review || 0], ["待发", p.ready || 0]]) {
    const c = h("div", { class: "pipe-count" });
    c.appendChild(h("div", { class: "pipe-num" }, String(n)));
    c.appendChild(h("div", { class: "muted" }, label));
    counts.appendChild(c);
  }
  card.appendChild(counts);
  if (p.stale) {
    card.appendChild(h("div", { class: "pipe-stale" }, "⚠ 《" + p.stale.title + "》草稿停 " + p.stale.days + " 天了"));
  }
  card.style.cursor = "pointer";
  card.onclick = () => switchView("drafts");
}

function renderDataCard(card, o) {
  card.innerHTML = "";
  card.appendChild(h("div", { class: "card-kicker" }, "上条数据回流"));
  if (!o) {
    card.appendChild(h("p", { class: "muted" }, "发布第一条后，这里出现你的数据。"));
    return;
  }
  card.appendChild(h("div", { class: "muted data-title" }, "《" + o.title + "》" + (o.platform ? " · " + platformLabel(o.platform) : "")));
  const cr = typeof o.completionRate === "number" ? o.completionRate + "%" : "—";
  card.appendChild(h("div", { class: "data-big" }, "完播 " + cr));
  if (typeof o.completionRate === "number" && typeof o.baselineCompletionRate === "number") {
    const up = o.completionRate >= o.baselineCompletionRate;
    card.appendChild(h("div", { class: up ? "data-delta data-up" : "data-delta data-down" },
      (up ? "↑ 高于" : "↓ 低于") + "基线 " + o.baselineCompletionRate + "%"));
  }
  card.appendChild(h("div", { class: "muted" }, "播放 " + todayFmtViews(o.views)));
  card.style.cursor = "pointer";
  card.onclick = () => switchView("report");
}

/** 工作日志回放：启动/切回今日时读事件尾部，之后由 engine:event 推送增量 */
async function refreshWorklog() {
  if (typeof EngineStore === "undefined" || !window.autocrew.eventsRecent) return;
  const res = await safeInvoke(window.autocrew.eventsRecent, { limit: 30 });
  if (res.ok) EngineStore.hydrateEvents(res.events || []);
}

function updateWorklogDom(state) {
  const el = document.getElementById("today-worklog");
  if (!el) return;
  el.innerHTML = "";
  const events = state.events.slice(-8);
  if (events.length === 0) {
    el.appendChild(h("div", { class: "worklog-line worklog-idle" }, "> 编辑部就绪，等待第一个任务"));
    return;
  }
  for (const e of events) {
    const line = h("div", { class: "worklog-line" });
    const t = new Date(e.ts);
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    line.appendChild(h("span", { class: "worklog-time" }, hh + ":" + mm));
    line.appendChild(h("span", { class: "worklog-glyph" }, TODAY_ROLE_GLYPH[e.role] || "·"));
    line.appendChild(h("span", { class: "worklog-label" }, e.label));
    el.appendChild(line);
  }
  el.scrollTop = el.scrollHeight;
}

/** presence 忙闲由真实工具执行事件驱动（chat:progress phase start/end），不做假活性 */
function updatePresenceDom(state) {
  for (const av of document.querySelectorAll(".presence-av")) {
    const role = av.getAttribute("data-role");
    const busy = role && state.busy[role];
    av.classList.toggle("presence-busy", Boolean(busy));
    av.title = busy ? busy.label : av.getAttribute("data-name") || "";
  }
}

/** 待审队列：draft_ready / reviewing / revision 的稿子在首屏等你审 */
async function refreshQueue() {
  const card = document.getElementById("today-queue");
  if (!card) return;
  card.innerHTML = "";
  card.appendChild(h("div", { class: "card-kicker" }, "待审队列"));
  const res = await safeInvoke(window.autocrew.contentList);
  const contents = (res.ok && res.contents) || [];
  const queue = contents.filter((c) => QUEUE_STATUSES[c.status]);
  if (queue.length === 0) {
    card.appendChild(h("p", { class: "muted" }, "队列空——让编剧写一篇，成稿会在这里等你审。"));
    return;
  }
  const list = h("div", { class: "queue-list" });
  for (const c of queue.slice(0, 5)) {
    const row = h("div", { class: "queue-row" });
    row.appendChild(h("span", { class: "queue-title" }, c.title || "（无标题）"));
    row.appendChild(h("span", { class: "queue-status" }, QUEUE_STATUSES[c.status]));
    const openBtn = h("button", { class: "btn-mini" }, "审稿");
    const openWorkbench = () => { window.__openDraftId = c.id; switchView("drafts"); };
    openBtn.addEventListener("click", (ev) => { ev.stopPropagation(); openWorkbench(); });
    row.addEventListener("click", openWorkbench);
    row.appendChild(openBtn);
    list.appendChild(row);
  }
  card.appendChild(list);
  if (queue.length > 5) {
    card.appendChild(h("div", { class: "muted" }, "还有 " + (queue.length - 5) + " 篇在队列里"));
  }
}

// 订阅一次：事件/忙闲变化 → 增量更新工作日志与 presence（今日未挂载时安静跳过）
if (typeof EngineStore !== "undefined") {
  EngineStore.subscribe((state) => {
    updateWorklogDom(state);
    updatePresenceDom(state);
  });
}

async function refreshRecentTasks() {
  const el = document.getElementById("today-recent");
  if (!el) return;
  el.innerHTML = "";
  const res = await safeInvoke(window.autocrew.conversationsList);
  const convs = (res.ok && res.data && res.data.conversations) || [];
  const head = h("div", { class: "recent-head" });
  head.appendChild(h("span", { class: "card-kicker" }, "最近任务"));
  if (convs.length > 0) {
    const all = h("button", { class: "btn-mini" }, "全部任务");
    all.addEventListener("click", showAllTasks);
    head.appendChild(all);
  }
  el.appendChild(head);
  if (convs.length === 0) { el.appendChild(h("span", { class: "muted recent-empty" }, "还没有任务")); return; }
  const list = h("div", { class: "recent-list" });
  for (const c of convs.slice(0, 5)) {
    const row = h("button", { class: "recent-item", title: c.title }, c.title);
    row.addEventListener("click", () => loadConversation(c.id));
    list.appendChild(row);
  }
  el.appendChild(list);
}

/** 全部任务轻列表（含删除）——替换今日视图内容，返回点 logo/今日导航 */
async function showAllTasks() {
  const el = document.getElementById("view-today");
  const res = await safeInvoke(window.autocrew.conversationsList);
  const convs = (res.ok && res.data && res.data.conversations) || [];
  el.innerHTML = "";
  const wrap = h("div", { class: "today-wrap" });
  const head = h("div", { class: "recent-head" });
  head.appendChild(h("span", { class: "today-greeting" }, "全部任务"));
  const back = h("button", { class: "btn-mini" }, "← 返回今日");
  back.addEventListener("click", renderToday);
  head.appendChild(back);
  wrap.appendChild(head);
  for (const c of convs) {
    const row = h("div", { class: "alltask-row" });
    const title = h("button", { class: "recent-item", title: c.title }, c.title);
    title.addEventListener("click", () => loadConversation(c.id));
    row.appendChild(title);
    const del = h("button", { class: "btn-mini" }, "删除");
    del.addEventListener("click", async () => {
      if (!confirm("删除任务「" + c.title + "」？聊天记录将一并删除。")) return;
      const r = await safeInvoke(window.autocrew.conversationsDelete, { id: c.id });
      if (!r.ok) { showToast(r.error || "删除失败"); return; }
      showAllTasks();
    });
    row.appendChild(del);
    wrap.appendChild(row);
  }
  if (convs.length === 0) wrap.appendChild(h("p", { class: "muted" }, "还没有任务"));
  el.appendChild(wrap);
}
