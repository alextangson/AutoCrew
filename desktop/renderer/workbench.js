/**
 * 稿件工作台（S2.7）— 应用内编辑/版本时间线/回滚/状态流转。
 * 框选改写在 selection.js（T3）。依赖 dom.js。
 */

async function renderWorkbench(contentId, container) {
  container.innerHTML = "";
  container.classList.remove("hidden");
  const loading = h("p", { class: "muted" }, "加载稿件…");
  container.appendChild(loading);

  const res = await safeInvoke(window.autocrew.contentGet, { id: contentId });
  container.removeChild(loading);
  if (!res.ok || !res.content) {
    showToast(res.error || "加载稿件失败");
    return;
  }
  const c = res.content;

  // ── 标题 + 状态行 ──
  container.appendChild(h("h3", {}, c.title || "（无标题）"));
  const statusRow = h("div", { class: "wb-status-row" });
  statusRow.appendChild(h("span", { class: "wb-status" }, statusLabel(c.status)));
  const allowed = await safeInvoke(window.autocrew.contentAllowedTransitions, { id: contentId });
  // allowedTransitions 在顶层（不在 data 里）：{ ok, currentStatus, allowedTransitions }
  const targets = allowed.ok && allowed.allowedTransitions ? allowed.allowedTransitions : [];
  for (const target of targets) {
    const btn = h("button", { class: "btn-mini" }, "→ " + statusLabel(target));
    btn.addEventListener("click", async () => {
      if (editor.value !== c.body) {
        showToast("有未保存的改动——先点保存，或撤销修改后再操作");
        return;
      }
      btn.disabled = true;
      const r = await safeInvoke(window.autocrew.contentTransition, { id: contentId, target_status: target });
      if (!r.ok) { btn.disabled = false; showToast(r.error || "流转失败"); return; }
      showToast("已流转到「" + statusLabel(target) + "」");
      renderWorkbench(contentId, container);
    });
    statusRow.appendChild(btn);
  }
  container.appendChild(statusRow);

  // ── 可编辑正文 ──
  const editor = h("textarea", { class: "wb-editor" });
  editor.value = c.body || "";
  container.appendChild(editor);
  if (typeof attachSelectionToolbar === "function") attachSelectionToolbar(editor, c, container);

  const actions = h("div", { class: "card-actions" });
  const saveBtn = h("button", { class: "btn-primary" }, "保存（存为新版本）");
  saveBtn.dataset.label = "保存（存为新版本）";
  saveBtn.addEventListener("click", async () => {
    if (editor.value === c.body) { showToast("没有改动"); return; }
    setLoading(saveBtn, true, "保存中...");
    const r = await safeInvoke(window.autocrew.contentUpdate, { id: contentId, body: editor.value });
    setLoading(saveBtn, false);
    if (!r.ok) { showToast(r.error || "保存失败"); return; }
    // contentUpdate 内部已记录编辑 diff 并在攒够时自动蒸馏风格规则（styleLearned）
    const vCount = r.content && r.content.versions ? r.content.versions.length : "?";
    let msg = "已存为 v" + vCount;
    if (r.styleLearned && r.styleLearned.newRules && r.styleLearned.newRules.length > 0) {
      msg += " · " + r.styleLearned.summary;
    }
    showToast(msg);
    renderWorkbench(contentId, container);
  });
  actions.appendChild(saveBtn);
  container.appendChild(actions);

  // ── 采纳裁决三键（PRD-v4 §8：北极星「采纳率」的读数来源） ──
  const adoptRow = h("div", { class: "wb-adopt-row" });
  adoptRow.appendChild(h("span", { class: "muted" }, "采纳裁决："));
  const ADOPT_LABELS = { adopted: "采纳", light_edit: "轻改采纳", rewritten: "重写" };
  for (const verdict of Object.keys(ADOPT_LABELS)) {
    const label = ADOPT_LABELS[verdict];
    const isCurrent = c.adoption && c.adoption.verdict === verdict;
    const btn = h("button", { class: isCurrent ? "btn-mini wb-adopt-current" : "btn-mini" }, isCurrent ? "✓ " + label : label);
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const r = await safeInvoke(window.autocrew.contentAdoption, { id: contentId, verdict });
      if (!r.ok) { btn.disabled = false; showToast(r.error || "记录失败"); return; }
      let msg = "已记录：" + label;
      if (r.stats && r.stats.rate !== null && r.stats.judged > 0) {
        msg += " · 采纳率 " + Math.round(r.stats.rate * 100) + "%（" + (r.stats.adopted + r.stats.lightEdit) + "/" + r.stats.judged + "）";
      }
      showToast(msg);
      renderWorkbench(contentId, container);
    });
    adoptRow.appendChild(btn);
  }
  container.appendChild(adoptRow);

  // ── 版本时间线 ──
  const vres = await safeInvoke(window.autocrew.contentVersions, { id: contentId });
  if (vres.ok && vres.data && (vres.data.versions || []).length > 0) {
    const versions = vres.data.versions;
    container.appendChild(h("h4", {}, "版本（" + versions.length + "）"));
    const timeline = h("div", { class: "wb-timeline" });
    for (const v of [...versions].reverse()) {
      const row = h("div", { class: "wb-version" });
      row.appendChild(h("span", { class: "wb-version-tag" }, "v" + v.version));
      row.appendChild(h("span", { class: "muted" }, (v.note || "") + " · " + fmtDate(v.savedAt)));
      if (v.version !== versions.length) {
        const revertBtn = h("button", { class: "btn-mini" }, "回滚到此版");
        revertBtn.addEventListener("click", async () => {
          if (editor.value !== c.body) {
            showToast("有未保存的改动——先点保存，或撤销修改后再操作");
            return;
          }
          revertBtn.disabled = true;
          const r = await safeInvoke(window.autocrew.contentRevert, { id: contentId, version: v.version });
          if (!r.ok) { revertBtn.disabled = false; showToast(r.error || "回滚失败"); return; }
          showToast("已回滚到 v" + v.version + "（新版本快照已生成）");
          renderWorkbench(contentId, container);
        });
        row.appendChild(revertBtn);
      }
      timeline.appendChild(row);
    }
    container.appendChild(timeline);
  }

  // ── 素材（S2.9：从素材库挂接 = 复制进项目快照） ──
  const assets = c.assets || [];
  container.appendChild(h("h4", {}, "素材（" + assets.length + "）"));
  const assetList = h("div", { class: "wb-assets" });
  for (const a of assets) {
    const row = h("div", { class: "wb-asset-row" });
    row.appendChild(h("span", {}, (typeof LIB_TYPE_ICON !== "undefined" && LIB_TYPE_ICON[a.type] ? LIB_TYPE_ICON[a.type] : "📄") + " " + a.filename));
    row.appendChild(h("span", { class: "muted" }, a.type + (a.description ? " · " + a.description : "")));
    const rmBtn = h("button", { class: "btn-mini" }, "移除");
    rmBtn.addEventListener("click", async () => {
      if (!confirm("移除挂接素材「" + a.filename + "」？项目内副本将被删除（素材库不受影响）。")) return;
      const r = await safeInvoke(window.autocrew.contentAssetRemove, { content_id: contentId, filename: a.filename });
      if (!r.ok) { showToast(r.error || "移除失败"); return; }
      renderWorkbench(contentId, container);
    });
    row.appendChild(rmBtn);
    assetList.appendChild(row);
  }
  container.appendChild(assetList);
  const attachBtn = h("button", { class: "btn-secondary" }, "从素材库挂接");
  const pickerSlot = h("div", {});
  attachBtn.addEventListener("click", () => renderAttachPicker(contentId, container, pickerSlot));
  container.appendChild(attachBtn);
  container.appendChild(pickerSlot);

  // ── 发布操作（沿用既有逻辑） ──
  if (typeof renderPublishActions === "function") renderPublishActions(c, container);
}

/** 挂接选择器：内联列出库内可用素材（missing 隐藏），>500MB 复制前确认 */
async function renderAttachPicker(contentId, container, slot) {
  if (slot.childNodes.length > 0) { slot.innerHTML = ""; return; } // 再点收起
  const res = await safeInvoke(window.autocrew.libraryList);
  if (!res.ok) { showToast(res.error || "素材库加载失败"); return; }
  const usable = ((res.data && res.data.assets) || []).filter((a) => !a.missing);
  const box = h("div", { class: "wb-attach-picker" });
  if (usable.length === 0) {
    box.appendChild(h("p", { class: "muted" }, "素材库暂无可用素材——先到侧边栏「素材库」导入。"));
  }
  for (const a of usable) {
    const row = h("div", { class: "wb-asset-row" });
    row.appendChild(h("span", {}, (typeof LIB_TYPE_ICON !== "undefined" && LIB_TYPE_ICON[a.type] ? LIB_TYPE_ICON[a.type] : "📄") + " " + a.name));
    row.appendChild(h("span", { class: "muted" }, libFmtSize(a.size)));
    const btn = h("button", { class: "btn-mini" }, "挂接");
    btn.addEventListener("click", async () => {
      if (a.size > 500 * 1024 * 1024 &&
          !confirm("该素材 " + libFmtSize(a.size) + "，挂接会把文件复制进项目目录。继续？")) return;
      btn.disabled = true;
      const r = await safeInvoke(window.autocrew.contentAssetAdd, { content_id: contentId, library_id: a.id });
      if (!r.ok) { btn.disabled = false; showToast(r.error || "挂接失败"); return; }
      showToast("已挂接「" + a.name + "」");
      renderWorkbench(contentId, container);
    });
    row.appendChild(btn);
    box.appendChild(row);
  }
  slot.appendChild(box);
}
