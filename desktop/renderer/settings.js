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

    // 低频对象管理收编入口（IA v4.2 §7:菜单收敛,风格档案=校准中心、选题雷达=情报源,归设置）
    const zones = h("div", { class: "settings-zones" });
    for (const [label, view, desc] of [
      ["校准中心", "style", "声音内核规则:可看、可改、可停用"],
      ["情报源", "scout", "雷达源清单与扫榜状态(命中定位自动入灵感库)"],
    ]) {
      const zone = h("button", { class: "settings-zone" });
      zone.appendChild(h("span", { class: "settings-zone-title" }, label));
      zone.appendChild(h("span", { class: "muted settings-zone-desc" }, desc));
      zone.addEventListener("click", () => switchView(view));
      zones.appendChild(zone);
    }
    el.appendChild(zones);

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

    // 搜索 API（V5.3:侦查员主动搜集的能力底座——配好后对话里就能「搜一下 X」）
    const searchRes = await safeInvoke(window.autocrew.settingsSearchGet);
    const sd = (searchRes.ok && searchRes.data) || { configured: false };
    const searchZone = h("details", { class: "dev-zone" });
    searchZone.appendChild(h("summary", {}, "搜索 API（侦查员主动搜集）" + (sd.configured ? " · 已配置" : " · 未配置")));
    searchZone.appendChild(h("p", { class: "muted" },
      sd.configured
        ? "当前:" + sd.provider + " · " + (sd.apiKeyMasked || "") + "。配置存本地 search.json,不入库。"
        : "配一个搜索 provider 的 key,总编辑就能派侦查员按你的定位全网搜灵感。推荐:博查(中文) / Tavily(英文)。"));
    const spLabel = h("label", {}, "Provider");
    const spSelect = h("select", { class: "input-full" });
    for (const [val, txt] of [["bocha", "博查 bocha(中文优先)"], ["tavily", "Tavily(英文圈)"]]) {
      const opt = h("option", { value: val }, txt);
      if (sd.provider === val) opt.selected = true;
      spSelect.appendChild(opt);
    }
    const skLabel = h("label", {}, "API Key");
    const skInput = h("input", { type: "password", class: "input-full", placeholder: sd.apiKeyMasked || "sk-..." });
    for (const node of [spLabel, spSelect, skLabel, skInput]) searchZone.appendChild(node);
    const searchSave = h("button", { class: "btn-primary" }, "保存搜索配置");
    searchSave.dataset.label = "保存搜索配置";
    searchSave.addEventListener("click", async () => {
      if (!skInput.value.trim()) { showToast("请填入 API key"); return; }
      setLoading(searchSave, true, "保存中...");
      const r = await safeInvoke(window.autocrew.settingsSearchSet, {
        provider: spSelect.value, api_key: skInput.value.trim(),
      });
      setLoading(searchSave, false);
      if (!r.ok) { showToast(r.error || "保存失败"); return; }
      showToast("搜索能力已就绪——对话里试试「搜一下最近的行业动态」");
      initSettings();
    });
    searchZone.appendChild(searchSave);
    el.appendChild(searchZone);

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
