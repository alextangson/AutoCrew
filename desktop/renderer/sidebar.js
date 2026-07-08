/**
 * 顶栏「＋新想法」按钮（IA v3 无左侧边栏）。菜单/目的页在 views.js。
 */

function initSidebar() {
  const btn = document.getElementById("new-task");
  if (btn) btn.addEventListener("click", newTask);
}
