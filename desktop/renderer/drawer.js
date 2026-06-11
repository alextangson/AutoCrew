/**
 * 右侧工作台抽屉（S2.8）：默认两栏，面板按需滑出。
 * 同时只开一个；Esc / 遮罩 / ✕ 关闭。面板渲染复用 app.js 的 init*（点击时已定义）。
 */

const DRAWER_TITLES = {
  report: "数据分析师 · 回流报告",
  drafts: "稿件",
  style: "编剧 · 风格档案",
  settings: "设置",
  scout: "选题侦察员",
  library: "素材库",
};

let activeDrawerPanel = null;

function openDrawer(name) {
  if (!Object.hasOwn(DRAWER_TITLES, name)) return;
  activeDrawerPanel = name;
  document.getElementById("drawer-title").textContent = DRAWER_TITLES[name];
  document.querySelectorAll("#drawer-body .panel").forEach((p) => p.classList.remove("active"));
  document.getElementById("panel-" + name).classList.add("active");
  const drawer = document.getElementById("drawer");
  drawer.classList.remove("drawer-closed");
  drawer.setAttribute("aria-hidden", "false");
  document.getElementById("drawer-mask").classList.remove("hidden");
  refreshDrawerPanel(name);
}

function closeDrawer() {
  if (document.activeElement && document.getElementById("drawer").contains(document.activeElement)) document.activeElement.blur();
  activeDrawerPanel = null;
  const drawer = document.getElementById("drawer");
  drawer.classList.add("drawer-closed");
  drawer.setAttribute("aria-hidden", "true");
  document.getElementById("drawer-mask").classList.add("hidden");
}

function refreshDrawerPanel(name) {
  if (name === "report") initReport();
  if (name === "drafts") initDrafts();
  if (name === "style") initStyle();
  if (name === "settings" && typeof initSettings === "function") initSettings();
  if (name === "scout" && typeof initScout === "function") initScout();
  if (name === "library" && typeof initLibrary === "function") initLibrary();
}

/** 抽屉开着才刷新（对话回合后调用，原 refreshActivePanel 语义） */
function refreshActiveDrawer() {
  if (activeDrawerPanel) refreshDrawerPanel(activeDrawerPanel);
}

function initDrawer() {
  document.getElementById("drawer-close").addEventListener("click", closeDrawer);
  document.getElementById("drawer-mask").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.isComposing || e.key !== "Escape") return;
    closeDrawer();
  });
}
