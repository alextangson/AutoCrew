/**
 * 侦察员工作档案面板（S2.6）— 定位可编辑 + 热榜源/缓存状态 + 立即刷新。
 * 依赖 dom.js（h/safeInvoke/setLoading/showToast）。
 */

let scoutInflight = false;

async function initScout() {
  if (scoutInflight) return;
  scoutInflight = true;
  try {
    const el = document.getElementById("panel-scout");
    el.innerHTML = "";
    el.appendChild(h("h2", {}, "选题侦察员 · 工作档案"));

    // 定位（驱动选题雷达过滤与生成 persona）
    const status = await safeInvoke(window.autocrew.onboardingStatus);
    const industry = status.ok && status.data ? status.data.industry || "" : "";

    const box = h("div", { class: "dev-zone" });
    box.appendChild(h("h3", {}, "你的定位 / 赛道"));
    box.appendChild(h("p", { class: "muted" }, "侦察员按这个定位筛选热点，编剧按它定调。"));
    const industryInput = h("input", { type: "text", class: "input-full", placeholder: "例：AI技术/科技博主" });
    industryInput.value = industry;
    box.appendChild(industryInput);
    const saveBtn = h("button", { class: "btn-primary" }, "保存定位");
    saveBtn.dataset.label = "保存定位";
    saveBtn.addEventListener("click", async () => {
      const v = industryInput.value.trim();
      if (!v) {
        showToast("定位不能为空");
        return;
      }
      setLoading(saveBtn, true, "保存中...");
      const r = await safeInvoke(window.autocrew.profileUpdate, { industry: v });
      setLoading(saveBtn, false);
      if (!r.ok) {
        showToast(r.error || "保存失败");
        return;
      }
      showToast("已保存，下次选题即生效");
    });
    box.appendChild(saveBtn);
    el.appendChild(box);

    // 情报源管理（IA v4.2 §A1「源清单可配置」）:增删 RSS 源,保存即接管
    const radar = await safeInvoke(window.autocrew.radarStatus);
    const srcBox = h("div", { class: "dev-zone" });
    srcBox.appendChild(h("h3", {}, "情报源（RSS）"));
    srcBox.appendChild(h("p", { class: "muted" },
      "雷达从这些源拉候选,命中你定位的自动进灵感库。贴垂直媒体的 RSS 链接——源越垂直,灵感越准。"));
    if (radar.ok && radar.data) {
      let sources = (radar.data.sources || []).map((s) => ({ ...s }));

      const KIND_LABEL = {
        rss: "RSS", hackernews: "海外·HN", producthunt: "海外·PH",
        github: "海外·GitHub", arxiv: "海外·arXiv", huggingface: "海外·HF",
      };
      const list = h("div", { class: "src-list" });
      const persist = async (next) => {
        const r = await safeInvoke(window.autocrew.radarSourcesSet, { sources: next });
        if (!r.ok) { showToast(r.error || "保存失败"); return false; }
        sources = r.data.sources;
        return true;
      };
      const renderList = () => {
        list.innerHTML = "";
        if (sources.length === 0) {
          list.appendChild(h("p", { class: "muted" }, "没有源了——雷达会停摆,加一个吧。"));
        }
        sources.forEach((s, i) => {
          const row = h("div", { class: "src-row" + (s.enabled === false ? " src-row-off" : "") });
          row.appendChild(h("span", { class: "src-kind" }, KIND_LABEL[s.kind] || s.kind));
          const body = h("div", { class: "src-row-body" });
          body.appendChild(h("div", { class: "src-row-name" }, s.name));
          body.appendChild(h("div", { class: "muted src-row-url" },
            s.kind === "rss" ? (s.config && s.config.url) || "" : "按你的定位自动检索" + ((s.config && s.config.keyword) ? "（关键词:" + s.config.keyword + "）" : "")));
          row.appendChild(body);
          const toggleBtn = h("button", { class: "btn-mini" }, s.enabled === false ? "启用" : "停用");
          toggleBtn.addEventListener("click", async () => {
            const next = sources.map((x, j) => (j === i ? { ...x, enabled: x.enabled === false } : x));
            if (await persist(next)) { showToast((s.enabled === false ? "已启用" : "已停用") + "「" + s.name + "」——下次扫榜生效"); renderList(); }
          });
          row.appendChild(toggleBtn);
          if (s.kind === "rss") {
            const delBtn = h("button", { class: "btn-mini" }, "移除");
            delBtn.addEventListener("click", async () => {
              const next = sources.filter((_, j) => j !== i);
              if (await persist(next)) { showToast("已移除「" + s.name + "」"); renderList(); }
            });
            row.appendChild(delBtn);
          }
          list.appendChild(row);
        });
      };
      renderList();
      srcBox.appendChild(list);

      // 添加行
      const addRow = h("div", { class: "src-add-row" });
      const nameInput = h("input", { type: "text", class: "src-add-name", placeholder: "源名称,如：机器之心" });
      const urlInput = h("input", { type: "text", class: "src-add-url", placeholder: "RSS 链接,https://…/feed" });
      const addBtn = h("button", { class: "btn-mini btn-mini-primary" }, "添加");
      addBtn.addEventListener("click", async () => {
        const name = nameInput.value.trim();
        const url = urlInput.value.trim();
        if (!name || !url) { showToast("名称和 RSS 链接都要填"); return; }
        addBtn.disabled = true;
        const okSave = await persist([...sources, { id: "", kind: "rss", name, enabled: true, config: { url } }]);
        addBtn.disabled = false;
        if (!okSave) return;
        nameInput.value = "";
        urlInput.value = "";
        showToast("已添加「" + name + "」——点立即扫榜验证能不能拉到");
        renderList();
      });
      addRow.appendChild(nameInput);
      addRow.appendChild(urlInput);
      addRow.appendChild(addBtn);
      srcBox.appendChild(addRow);

      const fetched = radar.data.fetchedAt
        ? "上次扫榜 " + fmtDate(radar.data.fetchedAt) + " · " + radar.data.itemCount + " 条在库"
        : "还没扫过榜（启动时自动扫，或点下面立即扫）";
      srcBox.appendChild(h("p", { class: "muted" }, fetched));
    } else {
      srcBox.appendChild(h("p", { class: "muted" }, "源状态读取失败：" + (radar.error || "未知错误")));
    }

    const refreshBtn = h("button", { class: "btn-secondary" }, "立即扫榜");
    refreshBtn.dataset.label = "立即扫榜";
    refreshBtn.addEventListener("click", async () => {
      setLoading(refreshBtn, true, "扫榜中...");
      const r = await safeInvoke(window.autocrew.radarRefresh);
      setLoading(refreshBtn, false);
      if (!r.ok) {
        showToast(r.error || "扫榜失败");
        return;
      }
      const failed = ((r.data && r.data.failedSources) || []).length
        ? "（" + r.data.failedSources.join("/") + " 没拉到）"
        : "";
      showToast("扫到 " + r.data.itemCount + " 条" + failed);
      queueMicrotask(initScout);
    });
    srcBox.appendChild(refreshBtn);
    el.appendChild(srcBox);

    el.appendChild(h("p", { class: "muted" },
      "合规口径：只读公开热榜/RSS，不碰任何账号登录态（PRD §6 红线）。"));
  } finally {
    scoutInflight = false;
  }
}
