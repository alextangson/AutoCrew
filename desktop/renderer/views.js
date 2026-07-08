/**
 * 中央视图切换（IA v3）：看板(主区首页) + 目的页(次级,菜单进入)。
 * 对话不再是一个「视图」——它常驻右栏 #chat-zone,始终可见。
 * 目的页(数据/选题/素材/风格/设置)从顶栏「菜单」进入,在主区替换看板显示。
 */

const DEST_TITLES = {
  scout: "选题侦察员", drafts: "内容", report: "数据 · 回流报告",
  library: "素材库", style: "编剧 · 风格档案", settings: "设置",
};
const DEST_PANEL = {
  scout: "panel-scout", drafts: "panel-drafts", report: "panel-report",
  library: "panel-library", style: "panel-style", settings: "panel-settings",
};

let activeView = "board";

function showViewEl(id) {
  for (const v of document.querySelectorAll("#main-area > .view")) v.classList.add("hidden");
  const el = document.getElementById(id);
  if (el) el.classList.remove("hidden");
}

/** 无左侧导航——保留空函数,兼容历史调用点 */
function setNavActive() {}

/** view ∈ board | conversation(no-op) | scout|drafts|report|library|style|settings */
function switchView(view) {
  if (view === "today" || view === "board") {
    activeView = "board";
    showViewEl("view-board");
    if (typeof renderBoard === "function") renderBoard();
    return;
  }
  if (view === "conversation") return; // 对话常驻右栏,不再抢主区
  if (!DEST_PANEL[view]) return;
  activeView = view;
  showViewEl("view-destination");
  document.getElementById("dest-title").textContent = DEST_TITLES[view];
  for (const p of document.querySelectorAll("#dest-body .panel")) p.classList.remove("active");
  document.getElementById(DEST_PANEL[view]).classList.add("active");
  refreshDestination(view);
}

function refreshDestination(view) {
  if (view === "report") initReport();
  if (view === "drafts") initDrafts();
  if (view === "style") initStyle();
  if (view === "scout" && typeof initScout === "function") initScout();
  if (view === "library" && typeof initLibrary === "function") initLibrary();
  if (view === "settings" && typeof initSettings === "function") initSettings();
}

/** 对话回合后刷新当前主区(看板 or 活动目的页) */
function refreshActiveView() {
  if (activeView === "board") { if (typeof renderBoard === "function") renderBoard(); return; }
  if (DEST_PANEL[activeView]) refreshDestination(activeView);
}

function initViews() {
  const menuBtn = document.getElementById("menu-btn");
  const drop = document.getElementById("menu-drop");
  if (menuBtn && drop) {
    menuBtn.addEventListener("click", (e) => { e.stopPropagation(); drop.classList.toggle("hidden"); });
    document.addEventListener("click", () => drop.classList.add("hidden"));
    for (const item of drop.querySelectorAll(".menu-item")) {
      item.addEventListener("click", () => { drop.classList.add("hidden"); switchView(item.dataset.view); });
    }
  }
  const back = document.getElementById("dest-back");
  if (back) back.addEventListener("click", () => switchView("board"));
}
