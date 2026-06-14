/**
 * 左侧边栏（S3.0）：＋新任务 + 导航（今日/选题/内容/数据/素材 + 设置）。
 * 导航点击在 views.js 的 initViews 接管；本文件只管新任务按钮。
 * 任务历史移入今日首屏（today.js），数字员工移入今日存在感条。
 */

function initSidebar() {
  document.getElementById("new-task").addEventListener("click", newTask);
}
