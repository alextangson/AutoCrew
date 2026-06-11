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

    // 热榜源 + 缓存状态
    const radar = await safeInvoke(window.autocrew.radarStatus);
    const srcBox = h("div", { class: "dev-zone" });
    srcBox.appendChild(h("h3", {}, "盯着的热榜源"));
    if (radar.ok && radar.data) {
      const list = h("ul", { class: "rules-list" });
      for (const s of radar.data.sources || []) {
        list.appendChild(h("li", {}, s.name + "（" + (s.tracks || []).join("/") + "）"));
      }
      srcBox.appendChild(list);
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
      const failed = (r.data.failedSources || []).length
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
