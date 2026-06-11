/**
 * 框选改写（S2.7）— SelectionToolbar + PendingEdit（设计搬自创始人网页版 qingmoagent）。
 * 采纳 = 替换选区 + 保存新版本 + 编辑信号喂风格学习；放弃 = 丢弃（不记信号）。
 * 依赖 dom.js / workbench.js（renderWorkbench 重绘）。
 */

const QUICK_ACTIONS = [
  ["重写", "重写这段，意思不变"],
  ["扩写", "在保持风格的前提下扩写这段，补充细节"],
  ["缩写", "把这段压缩到一半以内，保留核心信息"],
  ["口语化", "改成口语表达，像跟朋友说话"],
];

function attachSelectionToolbar(editor, content, container) {
  let toolbar = null;

  const removeToolbar = () => {
    if (toolbar) { toolbar.remove(); toolbar = null; }
  };

  editor.addEventListener("mouseup", () => {
    removeToolbar();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    if (start === end) return;
    const selection = editor.value.slice(start, end);
    if (!selection.trim()) return;

    toolbar = h("div", { class: "sel-toolbar" });
    for (const [label, instruction] of QUICK_ACTIONS) {
      const btn = h("button", { class: "btn-mini" }, label);
      btn.addEventListener("click", () => {
        requestRewrite(editor, content, container, { start, end, selection, instruction }, toolbar);
      });
      toolbar.appendChild(btn);
    }
    const custom = h("input", { type: "text", class: "sel-custom", placeholder: "或输入修改要求，回车发送" });
    custom.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter" && custom.value.trim()) {
        requestRewrite(editor, content, container, { start, end, selection, instruction: custom.value.trim() }, toolbar);
      }
    });
    toolbar.appendChild(custom);
    editor.parentElement.insertBefore(toolbar, editor);
  });

  editor.addEventListener("blur", () => {
    // 延迟移除，让工具条按钮的 click 先触发
    setTimeout(() => { if (toolbar && !toolbar.contains(document.activeElement)) removeToolbar(); }, 200);
  });
}

async function requestRewrite(editor, content, container, sel, toolbar) {
  const pending = h("div", { class: "pending-edit" });
  pending.appendChild(h("div", { class: "card-kicker" }, "编剧改写中…（" + sel.instruction.slice(0, 20) + "）"));
  toolbar.replaceWith(pending);

  const res = await safeInvoke(window.autocrew.draftRewriteSelection, {
    body: editor.value,
    selection: sel.selection,
    instruction: sel.instruction,
  });

  pending.innerHTML = "";
  if (!res.ok) {
    pending.appendChild(h("p", { class: "muted" },
      "改写失败：" + (res.error || "未知错误") + (res.needsSetup ? "（请先在设置配置引擎）" : "")));
    const dismiss = h("button", { class: "btn-mini" }, "关闭");
    dismiss.addEventListener("click", () => pending.remove());
    pending.appendChild(dismiss);
    return;
  }

  const rewritten = res.data.rewritten;
  pending.appendChild(h("div", { class: "card-kicker" }, "改写建议（" + sel.instruction.slice(0, 20) + "）"));
  const beforeEl = h("div", { class: "pe-before" });
  beforeEl.textContent = sel.selection;
  const afterEl = h("div", { class: "pe-after" });
  afterEl.textContent = rewritten;
  pending.appendChild(beforeEl);
  pending.appendChild(afterEl);

  const actions = h("div", { class: "card-actions" });
  const acceptBtn = h("button", { class: "btn-primary" }, "采纳");
  acceptBtn.dataset.label = "采纳";
  acceptBtn.addEventListener("click", async () => {
    setLoading(acceptBtn, true, "应用中...");
    // 用当前 editor 内容定位选区（编辑器可能已被用户改动——按原文匹配兜底）
    let newBody;
    const current = editor.value;
    if (current.slice(sel.start, sel.end) === sel.selection) {
      newBody = current.slice(0, sel.start) + rewritten + current.slice(sel.end);
    } else if (current.includes(sel.selection)) {
      newBody = current.replace(sel.selection, rewritten);
    } else {
      setLoading(acceptBtn, false);
      showToast("原文已被改动，无法定位选区——请手动应用");
      return;
    }
    const r = await safeInvoke(window.autocrew.contentUpdate, { id: content.id, body: newBody });
    setLoading(acceptBtn, false);
    if (!r.ok) { showToast(r.error || "保存失败"); return; }
    void safeInvoke(window.autocrew.styleRecordEdit, {
      content_id: content.id, before: sel.selection, after: rewritten,
    });
    showToast("已采纳并存为新版本");
    renderWorkbench(content.id, container);
  });
  actions.appendChild(acceptBtn);

  const rejectBtn = h("button", { class: "btn-secondary" }, "放弃");
  rejectBtn.addEventListener("click", () => pending.remove());
  actions.appendChild(rejectBtn);
  pending.appendChild(actions);
}
