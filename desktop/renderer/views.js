/**
 * 中央视图切换（S3.0）：今日 / 会话 / 目的页 三模式。
 * 替代 S2.8 抽屉机制——五目的页面板从抽屉移入中央 #view-destination。
 * 同时只显示一个 .view；目的页内同时只显示一个 .panel。
 */

const DEST_TITLES = {
  scout: "选题侦察员", drafts: "内容", report: "数据 · 回流报告",
  library: "素材库", style: "编剧 · 风格档案", settings: "设置",
};
const DEST_PANEL = {
  scout: "panel-scout", drafts: "panel-drafts", report: "panel-report",
  library: "panel-library", style: "panel-style", settings: "panel-settings",
};

let activeView = "today";

function showViewEl(id) {
  for (const v of document.querySelectorAll("#main-area > .view")) v.classList.add("hidden");
  document.getElementById(id).classList.remove("hidden");
}

function setNavActive(view) {
  for (const b of document.querySelectorAll(".nav-item")) {
    b.classList.toggle("active", b.dataset.view === view);
  }
}

/** view ∈ today | conversation | scout|drafts|report|library|style|settings */
function switchView(view) {
  activeView = view;
  if (view === "today") {
    showViewEl("view-today");
    setNavActive("today");
    if (typeof renderToday === "function") renderToday();
    return;
  }
  if (view === "conversation") {
    showViewEl("view-conversation");
    setNavActive(null);
    return;
  }
  if (!DEST_PANEL[view]) return;
  showViewEl("view-destination");
  setNavActive(view);
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

/** 对话回合后刷新当前目的页（原 refreshActiveDrawer 语义） */
function refreshActiveView() {
  if (DEST_PANEL[activeView]) refreshDestination(activeView);
}

function initViews() {
  for (const b of document.querySelectorAll(".nav-item")) {
    b.addEventListener("click", () => switchView(b.dataset.view));
  }
}
