/**
 * Day-1 onboarding — PRD §7.3：赛道确认 → CSV 导入 → 风格校准 → playbook 报告。
 * 红线：永不阻断。每步可跳过，聊天输入框全程可用，绝不问 API key。
 * 依赖 dom.js / cards.js / chat.js。
 */

let onboardingImportedPlatform = null;
let onboardingFinished = false;

async function bootOnboarding() {
  const res = await safeInvoke(window.autocrew.onboardingStatus);
  if (!res.ok || (res.data && res.data.onboarded)) {
    bootChatWelcome();
    return;
  }
  appendChatMessage("assistant",
    "你好，我是你的编辑部。第一次见面，花 2 分钟让我认识你——每一步都可以跳过，之后随时在对话里补。");
  onboardingStepTrack();
}

function onboardingStepTrack() {
  const card = cardShell("第 1 步 / 共 3 步", "你的赛道");
  card.appendChild(h("p", {}, "v1 专注知识口播——讲干货、讲经验、讲认知的口播短视频。"));
  const actions = h("div", { class: "card-actions" });

  const okBtn = h("button", { class: "btn-primary" }, "对，我做知识口播");
  okBtn.addEventListener("click", () => {
    okBtn.disabled = true;
    onboardingStepImport();
  });
  actions.appendChild(okBtn);

  const skipAllBtn = h("button", { class: "btn-mini" }, "全部跳过，直接开始");
  skipAllBtn.addEventListener("click", () => finishOnboarding(true));
  actions.appendChild(skipAllBtn);

  card.appendChild(actions);
  appendCardToStream(card);
}

function onboardingStepImport() {
  const card = cardShell("第 2 步 / 共 3 步", "导入历史数据（10 分钟后给你第一份 playbook）");
  card.appendChild(h("p", {},
    "去平台创作者中心导出作品数据 CSV（含播放/完播率），我把你的 baseline 一次拉起来。"));

  const select = h("select", { class: "input-full" });
  for (const [val, label] of [["douyin", "抖音"], ["wechat_video", "视频号"], ["xiaohongshu", "小红书"]]) {
    select.appendChild(h("option", { value: val }, label));
  }
  card.appendChild(select);

  const actions = h("div", { class: "card-actions" });
  const pickBtn = h("button", { class: "btn-primary" }, "选择 CSV 文件");
  pickBtn.dataset.label = "选择 CSV 文件";
  pickBtn.addEventListener("click", async () => {
    const picked = await safeInvoke(window.autocrew.dialogPickFile);
    if (!picked.ok) {
      showToast(picked.error || "文件选择不可用");
      return;
    }
    if (!picked.data || !picked.data.path) return; // 用户取消，静默
    setLoading(pickBtn, true, "导入中...");
    const r = await safeInvoke(window.autocrew.flywheelImportCsv, {
      platform: select.value,
      csv_path: picked.data.path,
    });
    setLoading(pickBtn, false);
    if (!r.ok) {
      showToast(r.error || "导入失败");
      return;
    }
    showToast("导入成功");
    onboardingImportedPlatform = select.value;
    appendChatMessage("assistant", "数据进来了。最后一步：让我学学你的写法。");
    onboardingStepStyle();
  });
  actions.appendChild(pickBtn);

  const skipBtn = h("button", { class: "btn-mini" }, "跳过这步");
  skipBtn.addEventListener("click", () => onboardingStepStyle());
  actions.appendChild(skipBtn);

  card.appendChild(actions);
  appendCardToStream(card);
}

function onboardingStepStyle() {
  const card = cardShell("第 3 步 / 共 3 步", "风格校准");
  card.appendChild(h("p", {}, "粘贴 1-5 条你写过、自己最满意的文案（每行一条），我从真实历史里学你的风格。"));
  const area = h("textarea", { class: "input-full textarea-absorb", placeholder: "第一条\n第二条\n..." });
  card.appendChild(area);

  const actions = h("div", { class: "card-actions" });
  const absorbBtn = h("button", { class: "btn-primary" }, "学习我的风格");
  absorbBtn.dataset.label = "学习我的风格";
  absorbBtn.addEventListener("click", async () => {
    const lines = area.value.split("\n").map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0 || lines.length > 5) {
      showToast("请输入 1-5 条文案");
      return;
    }
    setLoading(absorbBtn, true, "学习中...");
    const r = await safeInvoke(window.autocrew.styleAbsorb, { samples: lines });
    setLoading(absorbBtn, false);
    if (!r.ok) {
      showToast(r.error || "风格吸收失败");
      return;
    }
    finishOnboarding(false);
  });
  actions.appendChild(absorbBtn);

  const skipBtn = h("button", { class: "btn-mini" }, "跳过这步");
  skipBtn.addEventListener("click", () => finishOnboarding(false));
  actions.appendChild(skipBtn);

  card.appendChild(actions);
  appendCardToStream(card);
}

async function finishOnboarding(skippedAll) {
  if (onboardingFinished) return;
  onboardingFinished = true;
  const init = await safeInvoke(window.autocrew.onboardingInit,
    onboardingImportedPlatform ? { platforms: [onboardingImportedPlatform] } : {});
  if (!init.ok) {
    showToast(init.error || "初始化失败");
  }
  if (skippedAll) {
    appendChatMessage("assistant",
      "好，直接开始。说需求就行，比如：帮我写一条关于 Excel 快捷键的抖音口播。数据和风格之后随时补。");
    return;
  }
  // wow 时刻：第一份 playbook 报告
  const report = await safeInvoke(window.autocrew.flywheelReport);
  if (report.ok && report.data && report.data.works && report.data.works.total > 0) {
    appendChatMessage("assistant", "这是我看完你历史数据后的第一份 playbook 报告：");
    appendChatCards([{ type: "report", data: report.data }]);
  }
  const rules = await safeInvoke(window.autocrew.styleRules);
  const ruleCount = rules.ok && rules.data && rules.data.rules ? rules.data.rules.length : 0;
  appendChatMessage("assistant",
    (ruleCount > 0 ? "我已经记下 " + ruleCount + " 条你的写作规则（右侧「风格」可改可停用）。" : "") +
    "搞定，开工吧。直接说选题，我来写。");
  refreshActivePanel();
}
