/**
 * 顶栏「＋新想法」按钮 + 工作区切换器（IA v4.2:一人多 IP,每个 IP 一个独立编辑部）。
 * 菜单/目的页在 views.js。
 */

function initSidebar() {
  const btn = document.getElementById("new-task");
  if (btn) btn.addEventListener("click", newTask);
  initWorkspaceSwitch();
}

/** 工作区切换器:当前名下拉,切换/新建即整页刷新（每个工作区是独立世界,全量重载最干净） */
async function initWorkspaceSwitch() {
  const mount = document.getElementById("workspace-switch");
  if (!mount) return;
  const res = await safeInvoke(window.autocrew.workspaceList, {});
  if (!res.ok || !res.data) return; // 注册表异常 → 不渲染切换器,默认工作区照常用
  const { active, workspaces } = res.data;
  const current = workspaces.find((w) => w.id === active) || workspaces[0];

  mount.innerHTML = "";
  const btnEl = h("button", { class: "btn-secondary ws-btn", title: "切换工作区" }, current.name + " ▾");
  const drop = h("div", { class: "menu-drop ws-drop hidden" });

  for (const w of workspaces) {
    const item = h("button", { class: "menu-item" }, (w.id === active ? "✓ " : "") + w.name);
    item.addEventListener("click", async () => {
      if (w.id === active) { drop.classList.add("hidden"); return; }
      const r = await safeInvoke(window.autocrew.workspaceSwitch, { id: w.id });
      if (!r.ok) { showToast(r.error || "切换失败"); return; }
      location.reload();
    });
    drop.appendChild(item);
  }
  const createItem = h("button", { class: "menu-item ws-create" }, "＋ 新建工作区");
  createItem.addEventListener("click", async () => {
    const name = prompt("新工作区名称（如：Muse 公众号）");
    if (!name || !name.trim()) return;
    const r = await safeInvoke(window.autocrew.workspaceCreate, { name: name.trim() });
    if (!r.ok) { showToast(r.error || "创建失败"); return; }
    location.reload(); // 新建即切换（server 端已置 active）
  });
  drop.appendChild(createItem);

  btnEl.addEventListener("click", (e) => { e.stopPropagation(); drop.classList.toggle("hidden"); });
  document.addEventListener("click", () => drop.classList.add("hidden"));
  mount.appendChild(btnEl);
  mount.appendChild(drop);
}
