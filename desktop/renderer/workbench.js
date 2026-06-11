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
      const r = await safeInvoke(window.autocrew.contentTransition, { id: contentId, target_status: target });
      if (!r.ok) { showToast(r.error || "流转失败"); return; }
      showToast("已流转到「" + statusLabel(target) + "」");
      renderWorkbench(contentId, container);
    });
    statusRow.appendChild(btn);
  }
  container.appendChild(statusRow);

  // ── 可编辑正文 ──
  const editor = h("textarea", { class: "wb-editor", id: "wb-editor" });
  editor.value = c.body || "";
  container.appendChild(editor);
  if (typeof attachSelectionToolbar === "function") attachSelectionToolbar(editor, c, container);

  const actions = h("div", { class: "card-actions" });
  const saveBtn = h("button", { class: "btn-primary" }, "保存（存为新版本）");
  saveBtn.dataset.label = "保存（存为新版本）";
  saveBtn.addEventListener("click", async () => {
    if (editor.value === c.body) { showToast("没有改动"); return; }
    setLoading(saveBtn, true, "保存中...");
    const before = c.body;
    const r = await safeInvoke(window.autocrew.contentUpdate, { id: contentId, body: editor.value });
    setLoading(saveBtn, false);
    if (!r.ok) { showToast(r.error || "保存失败"); return; }
    // 手动编辑也是风格学习信号
    void safeInvoke(window.autocrew.styleRecordEdit, { content_id: contentId, before, after: editor.value });
    const vCount = r.content && r.content.versions ? r.content.versions.length : "?";
    showToast("已存为 v" + vCount);
    renderWorkbench(contentId, container);
  });
  actions.appendChild(saveBtn);
  container.appendChild(actions);

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
          const r = await safeInvoke(window.autocrew.contentRevert, { id: contentId, version: v.version });
          if (!r.ok) { showToast(r.error || "回滚失败"); return; }
          showToast("已回滚到 v" + v.version + "（新版本快照已生成）");
          renderWorkbench(contentId, container);
        });
        row.appendChild(revertBtn);
      }
      timeline.appendChild(row);
    }
    container.appendChild(timeline);
  }

  // ── 发布操作（沿用既有逻辑） ──
  if (typeof renderPublishActions === "function") renderPublishActions(c, container);
}
