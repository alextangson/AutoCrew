/**
 * 素材库面板（S2.9）— 引用式媒体仓库：导入/文件夹/标签/搜索/失效重定位。
 * 「库是索引，项目是快照」：删除只删记录；挂接复制在 workbench.js。
 * 注意：Electron renderer 无 window.prompt——文本输入一律行内编辑。
 * 依赖 dom.js / drawer.js。
 */

let libCache = { folders: [], assets: [] };
let libFilter = { folderId: null, q: "", type: "" }; // folderId null = 全部

const LIB_TYPE_ICON = { video: "🎬", image: "🖼", audio: "🎵", other: "📄" };
const LIB_TYPE_LABEL = { video: "视频", image: "图片", audio: "音频", other: "其他" };

function libFmtSize(bytes) {
  if (typeof bytes !== "number" || !(bytes >= 0)) return "—";
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " B";
}

async function initLibrary() {
  const el = document.getElementById("panel-library");
  el.innerHTML = "";
  el.appendChild(h("h2", {}, "素材库"));
  el.appendChild(h("p", { class: "muted" }, "引用式仓库：文件留在原地，删除素材不会删原文件。"));

  const bar = h("div", { class: "lib-toolbar" });
  const importBtn = h("button", { class: "btn-primary" }, "导入素材");
  importBtn.dataset.label = "导入素材";
  importBtn.addEventListener("click", () => libImport(importBtn));
  bar.appendChild(importBtn);
  const folderBtn = h("button", { class: "btn-secondary" }, "新建文件夹");
  folderBtn.addEventListener("click", () => libShowFolderInput());
  bar.appendChild(folderBtn);
  el.appendChild(bar);
  el.appendChild(h("div", { id: "lib-folder-input" }));

  const searchRow = h("div", { class: "lib-search-row" });
  const search = h("input", { type: "text", class: "input-full", placeholder: "搜索名称或标签…" });
  search.value = libFilter.q;
  search.addEventListener("input", () => { libFilter.q = search.value.trim(); renderLibraryList(); });
  searchRow.appendChild(search);
  const typeSel = h("select", { class: "lib-type-filter" });
  for (const [val, label] of [["", "全部类型"], ["video", "视频"], ["image", "图片"], ["audio", "音频"], ["other", "其他"]]) {
    typeSel.appendChild(h("option", { value: val }, label));
  }
  typeSel.value = libFilter.type;
  typeSel.addEventListener("change", () => { libFilter.type = typeSel.value; renderLibraryList(); });
  searchRow.appendChild(typeSel);
  el.appendChild(searchRow);

  el.appendChild(h("div", { id: "lib-folders", class: "lib-folders" }));
  el.appendChild(h("div", { id: "lib-list" }));
  await libReload();
}

async function libReload() {
  const res = await safeInvoke(window.autocrew.libraryList);
  if (!res.ok) { showToast(res.error || "素材库加载失败"); return; }
  libCache = res.data || { folders: [], assets: [] };
  if (libFilter.folderId && !libCache.folders.some((f) => f.id === libFilter.folderId)) {
    libFilter.folderId = null; // 当前过滤的文件夹已被删
  }
  renderLibraryFolders();
  renderLibraryList();
}

function renderLibraryFolders() {
  const wrap = document.getElementById("lib-folders");
  if (!wrap) return;
  wrap.innerHTML = "";
  const allChip = h("button", { class: libFilter.folderId === null ? "lib-folder-chip lib-folder-active" : "lib-folder-chip" }, "全部");
  allChip.addEventListener("click", () => { libFilter.folderId = null; renderLibraryFolders(); renderLibraryList(); });
  wrap.appendChild(allChip);
  for (const f of libCache.folders) {
    const chip = h("button", { class: f.id === libFilter.folderId ? "lib-folder-chip lib-folder-active" : "lib-folder-chip" }, f.name);
    chip.addEventListener("click", () => { libFilter.folderId = f.id; renderLibraryFolders(); renderLibraryList(); });
    const del = h("span", { class: "lib-folder-del", title: "删除文件夹（素材回「全部」）" }, "✕");
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("删除文件夹「" + f.name + "」？其中素材会回到「全部」，不会被删除。")) return;
      const r = await safeInvoke(window.autocrew.libraryFolderRemove, { id: f.id });
      if (!r.ok) { showToast(r.error || "删除失败"); return; }
      libReload();
    });
    chip.appendChild(del);
    wrap.appendChild(chip);
  }
}

function libShowFolderInput() {
  const slot = document.getElementById("lib-folder-input");
  if (!slot || slot.childNodes.length > 0) return; // 已在编辑
  const input = h("input", { type: "text", class: "input-full", placeholder: "文件夹名称" });
  const okBtn = h("button", { class: "btn-mini" }, "创建");
  const cancelBtn = h("button", { class: "btn-mini" }, "取消");
  okBtn.addEventListener("click", async () => {
    const name = input.value.trim();
    if (!name) { showToast("名称不能为空"); return; }
    const r = await safeInvoke(window.autocrew.libraryFolderCreate, { name });
    if (!r.ok) { showToast(r.error || "创建失败"); return; }
    slot.innerHTML = "";
    libReload();
  });
  cancelBtn.addEventListener("click", () => { slot.innerHTML = ""; });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") okBtn.click();
    if (e.key === "Escape") cancelBtn.click();
  });
  slot.appendChild(input);
  slot.appendChild(okBtn);
  slot.appendChild(cancelBtn);
  input.focus();
}

function renderLibraryList() {
  const list = document.getElementById("lib-list");
  if (!list) return;
  list.innerHTML = "";
  const q = libFilter.q.toLowerCase();
  const rows = libCache.assets.filter((a) =>
    (libFilter.folderId === null || a.folderId === libFilter.folderId) &&
    (libFilter.type === "" || a.type === libFilter.type) &&
    (q === "" || a.name.toLowerCase().includes(q) || (a.tags || []).some((t) => t.toLowerCase().includes(q))));
  if (rows.length === 0) {
    list.appendChild(h("p", { class: "empty-state" }, "没有匹配的素材。点「导入素材」从本机挑选文件。"));
    return;
  }
  for (const a of rows) list.appendChild(renderLibraryRow(a));
}

function renderLibraryRow(a) {
  const row = h("div", { class: a.missing ? "lib-row lib-missing" : "lib-row" });
  if (a.type === "image" && !a.missing) {
    const img = h("img", { class: "lib-thumb", src: "file://" + a.path, alt: "" });
    img.addEventListener("error", () => img.replaceWith(h("span", { class: "lib-icon" }, LIB_TYPE_ICON.image)));
    row.appendChild(img);
  } else {
    row.appendChild(h("span", { class: "lib-icon" }, LIB_TYPE_ICON[a.type] || "📄"));
  }
  const main = h("div", { class: "lib-row-main" });
  main.appendChild(h("div", { class: "lib-name", title: a.path }, a.name));
  main.appendChild(h("div", { class: "lib-meta muted" },
    (LIB_TYPE_LABEL[a.type] || a.type) + " · " + libFmtSize(a.size) + (a.missing ? " · 文件已移动或删除" : "")));
  if ((a.tags || []).length > 0) {
    const tagWrap = h("div", { class: "tag-wrap" });
    for (const t of a.tags) tagWrap.appendChild(h("span", { class: "tag" }, t));
    main.appendChild(tagWrap);
  }
  row.appendChild(main);

  const ops = h("div", { class: "lib-ops" });
  ops.appendChild(libMiniBtn("改名", () => libInlineEdit(row, main, a, "name")));
  ops.appendChild(libMiniBtn("标签", () => libInlineEdit(row, main, a, "tags")));
  ops.appendChild(libMiniBtn("移动", () => libInlineMove(row, main, a)));
  if (a.missing) ops.appendChild(libMiniBtn("重新定位", () => libRelocate(a)));
  ops.appendChild(libMiniBtn("移除", () => libRemove(a)));
  row.appendChild(ops);
  return row;
}

function libMiniBtn(label, fn) {
  const b = h("button", { class: "btn-mini" }, label);
  b.addEventListener("click", fn);
  return b;
}

/** 行内编辑（改名/标签）——Electron 无 prompt，复用风格面板的 input+保存模式 */
function libInlineEdit(row, main, a, field) {
  const input = h("input", { type: "text", class: "input-full" });
  input.value = field === "name" ? a.name : (a.tags || []).join(", ");
  const saveBtn = h("button", { class: "btn-mini" }, "保存");
  saveBtn.addEventListener("click", async () => {
    const payload = { id: a.id };
    if (field === "name") {
      if (!input.value.trim()) { showToast("名称不能为空"); return; }
      payload.name = input.value.trim();
    } else {
      payload.tags = input.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
    const r = await safeInvoke(window.autocrew.libraryUpdate, payload);
    if (!r.ok) { showToast(r.error || "保存失败"); return; }
    libReload();
  });
  const cancelBtn = h("button", { class: "btn-mini" }, "取消");
  cancelBtn.addEventListener("click", () => libReload());
  main.innerHTML = "";
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter") saveBtn.click();
    if (e.key === "Escape") cancelBtn.click();
  });
  main.appendChild(input);
  main.appendChild(saveBtn);
  main.appendChild(cancelBtn);
  input.focus();
}

function libInlineMove(row, main, a) {
  const sel = h("select", { class: "lib-type-filter" });
  sel.appendChild(h("option", { value: "" }, "（全部/根）"));
  for (const f of libCache.folders) {
    const opt = h("option", { value: f.id }, f.name);
    sel.appendChild(opt);
  }
  sel.value = a.folderId || "";
  const okBtn = h("button", { class: "btn-mini" }, "确定");
  okBtn.addEventListener("click", async () => {
    const r = await safeInvoke(window.autocrew.libraryUpdate, { id: a.id, folder_id: sel.value || null });
    if (!r.ok) { showToast(r.error || "移动失败"); return; }
    libReload();
  });
  const cancelBtn = h("button", { class: "btn-mini" }, "取消");
  cancelBtn.addEventListener("click", () => libReload());
  main.innerHTML = "";
  main.appendChild(sel);
  main.appendChild(okBtn);
  main.appendChild(cancelBtn);
}

async function libImport(btn) {
  const picked = await safeInvoke(window.autocrew.dialogPickMedia);
  if (!picked.ok) { showToast(picked.error || "文件选择不可用"); return; }
  const paths = (picked.data && picked.data.paths) || [];
  if (paths.length === 0) return; // 用户取消，静默
  setLoading(btn, true, "导入中...");
  const payload = libFilter.folderId ? { paths, folder_id: libFilter.folderId } : { paths };
  const r = await safeInvoke(window.autocrew.libraryAdd, payload);
  setLoading(btn, false);
  if (!r.ok) { showToast(r.error || "导入失败"); return; }
  const added = (r.data && r.data.added) || [];
  const skipped = (r.data && r.data.skipped) || [];
  showToast("已导入 " + added.length + " 条" + (skipped.length ? "，跳过 " + skipped.length + " 条（重复或不可读）" : ""));
  libReload();
}

async function libRelocate(a) {
  const picked = await safeInvoke(window.autocrew.dialogPickMedia);
  if (!picked.ok) { showToast(picked.error || "文件选择不可用"); return; }
  const paths = (picked.data && picked.data.paths) || [];
  if (paths.length === 0) return;
  const r = await safeInvoke(window.autocrew.libraryUpdate, { id: a.id, path: paths[0] });
  if (!r.ok) { showToast(r.error || "重新定位失败"); return; }
  showToast("已重新定位");
  libReload();
}

async function libRemove(a) {
  if (!confirm("从素材库移除「" + a.name + "」？原文件不会被删除。")) return;
  const r = await safeInvoke(window.autocrew.libraryRemove, { id: a.id });
  if (!r.ok) { showToast(r.error || "移除失败"); return; }
  libReload();
}
