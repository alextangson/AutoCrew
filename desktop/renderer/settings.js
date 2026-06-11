/**
 * Settings panel — 个性化中心的设置页。开发者区折叠收纳 provider 配置
 * （dogfood 默认路径；终端用户版本此区隐藏，积分中转上线后退役——PRD §9）。
 */

let settingsInflight = false;

async function initSettings() {
  if (settingsInflight) return;
  settingsInflight = true;
  try {
    const el = document.getElementById("panel-settings");
    el.innerHTML = "";
    el.appendChild(h("h2", {}, "设置"));

    const res = await safeInvoke(window.autocrew.settingsGet);
    if (!res.ok) {
      showToast(res.error || "读取设置失败");
      return;
    }
    const d = res.data;

    // 引擎状态行
    const statusText = d.configured
      ? "引擎已配置（" + (d.source === "env" ? "环境变量" : "engine.json") + " · " + (d.apiKeyMasked || "") + "）"
      : "引擎未配置 — 在下方开发者区填入 API key";
    el.appendChild(h("p", { class: d.configured ? "success-msg" : "muted" }, statusText));

    // 开发者区（折叠）
    const dev = h("details", { class: "dev-zone" });
    dev.appendChild(h("summary", {}, "开发者区（model provider）"));

    const keyLabel = h("label", {}, "API Key");
    const keyInput = h("input", { type: "password", class: "input-full", placeholder: d.apiKeyMasked || "sk-..." });
    const urlLabel = h("label", {}, "Base URL");
    const urlInput = h("input", { type: "text", class: "input-full" });
    urlInput.value = d.baseUrl || "";
    const strongLabel = h("label", {}, "强模型（核心生成）");
    const strongInput = h("input", { type: "text", class: "input-full" });
    strongInput.value = d.strongModel || "";
    const fastLabel = h("label", {}, "快模型（对话/过滤）");
    const fastInput = h("input", { type: "text", class: "input-full" });
    fastInput.value = d.fastModel || "";

    for (const node of [keyLabel, keyInput, urlLabel, urlInput, strongLabel, strongInput, fastLabel, fastInput]) {
      dev.appendChild(node);
    }

    const saveBtn = h("button", { class: "btn-primary" }, "保存");
    saveBtn.dataset.label = "保存";
    saveBtn.addEventListener("click", async () => {
      const payload = {};
      if (keyInput.value.trim()) payload.api_key = keyInput.value.trim();
      if (urlInput.value.trim() && urlInput.value.trim() !== d.baseUrl) payload.base_url = urlInput.value.trim();
      if (strongInput.value.trim() && strongInput.value.trim() !== d.strongModel) payload.strong_model = strongInput.value.trim();
      if (fastInput.value.trim() && fastInput.value.trim() !== d.fastModel) payload.fast_model = fastInput.value.trim();
      if (Object.keys(payload).length === 0) {
        showToast("没有要保存的修改");
        return;
      }
      setLoading(saveBtn, true, "保存中...");
      const r = await safeInvoke(window.autocrew.settingsSet, payload);
      setLoading(saveBtn, false);
      if (!r.ok) {
        showToast(r.error || "保存失败");
        return;
      }
      showToast("已保存");
      initSettings();
    });
    dev.appendChild(saveBtn);
    el.appendChild(dev);

    // 知识库入口（PRD §7.1 轻量没入式知识库）
    const kb = await safeInvoke(window.autocrew.knowledgeStatus);
    if (kb.ok && kb.data) {
      const kbBox = h("div", { class: "dev-zone" });
      kbBox.appendChild(h("h3", {}, "知识库"));
      kbBox.appendChild(h("p", { class: "muted" },
        "把你的笔记/干货文档（.md / .txt）放进 " + kb.data.dir + "，生成时自动检索注入。当前 " + kb.data.count + " 个文件。"));
      el.appendChild(kbBox);
    }
  } finally {
    settingsInflight = false;
  }
}
