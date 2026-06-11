/**
 * 左侧边栏（S2.8 任务工作台）：新任务 / 任务历史 / 数字员工 / 设置。
 * 列表数据源 = conversations:list；点击回放走 chat.js 的 loadConversation。
 * activeConversationId / newTask 由 chat.js 定义（脚本顺序在前）。
 */

const SIDEBAR_CREW = [
  { role: "scout", badge: "侦", name: "选题侦察员", hint: "雷达扫描赛道热点，每日推送候选选题" },
  { role: "writer", badge: "编", name: "编剧", hint: "根据选题和风格档案撰写口播稿件" },
  { role: "review", badge: "审", name: "合规审核员", hint: "检查稿件风格合规并排版发布文案" },
  { role: "analyst", badge: "析", name: "数据分析师", hint: "分析回流数据，生成 playbook 报告" },
];

async function refreshConversationList() {
  const listEl = document.getElementById("conversation-list");
  const res = await safeInvoke(window.autocrew.conversationsList);
  listEl.innerHTML = "";
  if (!res.ok) {
    listEl.appendChild(h("p", { class: "muted sidebar-empty" }, "任务列表加载失败"));
    return;
  }
  const conversations = (res.data && res.data.conversations) || [];
  if (conversations.length === 0) {
    listEl.appendChild(h("p", { class: "muted sidebar-empty" }, "还没有任务"));
    return;
  }
  for (const conv of conversations) {
    const row = h("div", {
      class: "conv-row" + (conv.id === activeConversationId ? " conv-active" : ""),
      title: conv.title,
    });
    row.addEventListener("click", () => loadConversation(conv.id));
    const titleSpan = h("span", { class: "conv-title" }, conv.title);
    row.appendChild(titleSpan);
    const delBtn = h("button", { class: "btn-mini conv-del", title: "删除任务" }, "✕");
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (chatBusy) { showToast("正在干活，稍等片刻再删除任务"); return; }
      if (!confirm("删除任务「" + conv.title + "」？聊天记录将一并删除。")) return;
      const r = await safeInvoke(window.autocrew.conversationsDelete, { id: conv.id });
      if (!r.ok) { showToast(r.error || "删除失败"); return; }
      if (conv.id === activeConversationId) newTask();
      else refreshConversationList();
    });
    row.appendChild(delBtn);
    listEl.appendChild(row);
  }
}

function renderCrewList() {
  const crewEl = document.getElementById("crew-list");
  crewEl.innerHTML = "";
  for (const c of SIDEBAR_CREW) {
    const row = h("div", { class: "sidebar-item crew-item", title: c.hint });
    row.appendChild(h("span", { class: "byline-badge byline-badge-" + c.role }, c.badge));
    row.appendChild(h("span", {}, c.name));
    row.addEventListener("click", () => {
      if (c.role === "scout") openDrawer("scout");
      else if (c.role === "writer") openDrawer("style");
      else if (c.role === "analyst") openDrawer("report");
      else if (c.role === "review") appendReviewerCard();
    });
    crewEl.appendChild(row);
  }
}

function initSidebar() {
  document.getElementById("new-task").addEventListener("click", newTask);
  document.getElementById("open-settings").addEventListener("click", () => openDrawer("settings"));
  renderCrewList();
  refreshConversationList();
  const libSection = document.getElementById("sidebar-library");
  if (libSection) libSection.addEventListener("click", () => openDrawer("library"));
}
