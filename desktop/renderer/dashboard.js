/**
 * Dashboard 经营层首页（IA v4.2 §1/§2 第一批组件）。
 * 三主卡全功能（待审队列/回填待办/校准状态）+ 两摘要朴素卡（管线/灵感 top-3）。
 * 红线：全部数字来自 dashboard:summary 真实聚合,无引擎事件不造活性（§7.4）;
 * 空态即 onboarding（§3）——每张卡的空态就是引导入口,永不阻断。
 */

const REVIEW_PRIORITY_META = {
  overdue: { label: "过期", cls: "dash-pri-overdue" },
  window: { label: "该发了", cls: "dash-pri-window" },
  fresh: { label: "新完成", cls: "dash-pri-fresh" },
};

function dashCard(title, kicker, role) {
  const el = cardShell(title, kicker, role);
  el.classList.add("dash-card");
  return el;
}

/** 从 dashboard 打开某稿工作台：进看板视图再开（复用 board 的容器与返回逻辑） */
function dashOpenContent(contentId) {
  switchView("board");
  // renderBoard 是 async——openInBoard 自己重画 board-main,无需等待完成
  setTimeout(() => openInBoard(contentId, null), 60);
}

/** 任务动态带（IA v4.2,runId 聚合）:进行中实时步进 + 最近完成。只由真实事件驱动,无 run 不渲染。 */
function renderRunStrip(container, state) {
  container.innerHTML = "";
  const order = state.runOrder || [];
  if (order.length === 0) { container.classList.add("hidden"); return; }
  const running = order.filter((id) => state.runs[id].status === "running");
  const settled = order.filter((id) => state.runs[id].status !== "running").slice(-2);
  const show = [...running, ...settled];
  if (show.length === 0) { container.classList.add("hidden"); return; }
  container.classList.remove("hidden");
  for (const runId of show) {
    const run = state.runs[runId];
    const cls = run.status === "done" ? " dash-run-done" : run.status === "failed" ? " dash-run-failed" : "";
    const card = h("div", { class: "dash-run" + cls });
    const head = h("div", { class: "dash-run-head" });
    head.appendChild(h("span", { class: "dash-run-status" },
      run.status === "done" ? "✓ 完成" : run.status === "failed" ? "✕ 中断" : "● 进行中"));
    if (run.status !== "running" && run.doneLabel) head.appendChild(h("span", { class: "muted" }, run.doneLabel));
    card.appendChild(head);
    const steps = h("div", { class: "dash-run-steps" });
    for (const s of run.steps.slice(-4)) {
      steps.appendChild(h("span", { class: "dash-run-step" + (s.done ? " dash-run-step-done" : "") },
        (s.done ? "✓ " : "… ") + s.label));
    }
    if (run.steps.length > 0) card.appendChild(steps);
    container.appendChild(card);
  }
}

// 模块级单一订阅:dashboard 全量重绘不累积订阅,回调只碰任务带容器
EngineStore.subscribe((state) => {
  const strip = document.getElementById("dash-runs");
  if (strip) renderRunStrip(strip, state);
});

async function renderDashboard() {
  const view = document.getElementById("view-dashboard");
  if (!view) return;
  window.__wbOpenContent = null; // 首页 = 离开单稿上下文（§C1）
  view.innerHTML = "";

  const res = await safeInvoke(window.autocrew.dashboardSummary, {});
  if (!res.ok) {
    view.appendChild(h("p", { class: "muted dash-error" }, "工作台数据加载失败：" + (res.error || "未知错误")));
    return;
  }
  const d = res.data;

  // ── 问候行（衬线点缀,DESIGN.md §3 允许的两处之一） ──
  const hour = new Date().getHours();
  const greet = hour < 5 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  const head = h("div", { class: "dash-head" });
  head.appendChild(h("h2", { class: "dash-greet" }, greet + "，编辑部已就位。"));
  const boardBtn = h("button", { class: "btn-secondary" }, "进看板 →");
  boardBtn.addEventListener("click", () => switchView("board"));
  head.appendChild(boardBtn);
  view.appendChild(head);

  if (d.isFirstRun) {
    view.appendChild(h("p", { class: "muted dash-firstrun" },
      "第一次来。下面每张卡的空态都是一个起点——从「校准你的声音」开始最划算，全程可跳过。"));
  }

  // 任务动态带:只由真实 run 事件驱动,空时隐藏（假活性红线 §7.4）
  const runStrip = h("div", { id: "dash-runs", class: "dash-runs hidden" });
  view.appendChild(runStrip);
  renderRunStrip(runStrip, EngineStore.state);

  const grid = h("div", { class: "dash-grid" });
  view.appendChild(grid);

  // ── 1. 待审队列（核心组件,§7.3-2）──
  const rq = d.reviewQueue || [];
  const queueCard = dashCard("待审队列", rq.length ? rq.length + " 篇等你过目" : "空", "review");
  if (rq.length === 0) {
    queueCard.appendChild(h("p", { class: "muted" }, d.isFirstRun ? "还没有稿子。校准声音后,从灵感库派一篇试试。" : "没有待审稿——去灵感库挑一条开写？"));
  } else {
    const list = h("div", { class: "dash-queue" });
    for (const item of rq.slice(0, 6)) {
      const row = h("div", { class: "dash-queue-row" });
      const pri = REVIEW_PRIORITY_META[item.priority] || REVIEW_PRIORITY_META.fresh;
      row.appendChild(h("span", { class: "dash-pri " + pri.cls }, pri.label));
      const title = h("span", { class: "dash-queue-title" }, item.title || "（无标题）");
      row.appendChild(title);
      row.appendChild(h("span", { class: "muted dash-queue-meta" },
        (item.platform ? platformLabel(item.platform) + " · " : "") + item.ageDays + " 天"));
      row.addEventListener("click", () => dashOpenContent(item.id));
      list.appendChild(row);
    }
    queueCard.appendChild(list);
    const actions = h("div", { class: "card-actions" });
    const runBtn = h("button", { class: "btn-mini btn-mini-primary" }, "连续审稿（" + rq.length + "）");
    runBtn.addEventListener("click", () => {
      window.__reviewQueue = rq.map((r) => r.id); // 连续审稿模式:工作台出「下一篇」
      dashOpenContent(rq[0].id);
    });
    actions.appendChild(runBtn);
    queueCard.appendChild(actions);
  }
  grid.appendChild(queueCard);

  // ── 2. 回填待办（v4 §7.3-2 三组件补齐:提醒 + 拖延告警）──
  const bf = d.backfillTodos || [];
  const bfCard = dashCard("回填待办", bf.length ? bf.length + " 篇等数据" : "无", "analyst");
  if (bf.length === 0) {
    bfCard.appendChild(h("p", { class: "muted" }, "没有等回填的稿子。发布满 1 天的稿件会出现在这里提醒你回数据。"));
  } else {
    const list = h("div", { class: "dash-queue" });
    for (const t of bf.slice(0, 5)) {
      const row = h("div", { class: "dash-queue-row" });
      row.appendChild(h("span", {
        class: "dash-pri " + (t.level === "overdue" ? "dash-pri-overdue" : "dash-pri-window"),
      }, t.level === "overdue" ? "拖了" : "该回了"));
      row.appendChild(h("span", { class: "dash-queue-title" }, t.title || "（无标题）"));
      row.appendChild(h("span", { class: "muted dash-queue-meta" }, "发布 " + t.daysSince + " 天"));
      row.addEventListener("click", () => dashOpenContent(t.id));
      list.appendChild(row);
    }
    bfCard.appendChild(list);
    bfCard.appendChild(h("p", { class: "muted dash-hint" }, "点开稿件填数据,或在设置里用平台 CSV 批量导入。"));
  }
  grid.appendChild(bfCard);

  // ── 3. 校准状态（飞轮可见面,§B5-3）──
  const cal = d.calibration;
  const calCard = dashCard("声音内核", cal.styleCalibrated ? "已校准" : "未校准", "writer");
  if (!cal.styleCalibrated && cal.activeRuleCount === 0) {
    calCard.appendChild(h("p", { class: "muted" }, "还没学过你的声音——贴几篇你最满意的作品,10 分钟建立你的风格档案,之后每次纠正它都会更像你。"));
    const actions = h("div", { class: "card-actions" });
    const calBtn = h("button", { class: "btn-mini btn-mini-primary" }, "校准你的声音");
    calBtn.addEventListener("click", () => {
      if (typeof onboardingStepStyle === "function") onboardingStepStyle();
      const input = document.getElementById("chat-input");
      if (input) input.focus();
      showToast("看右侧对话——贴上你的代表作");
    });
    actions.appendChild(calBtn);
    calCard.appendChild(actions);
  } else {
    calCard.appendChild(h("p", {},
      "写作规则 " + cal.activeRuleCount + " 条,其中声音内核 " + cal.voiceCoreCount + " 条。"));
    if (cal.recentRules.length > 0) {
      const ul = h("ul", { class: "insight-list" });
      for (const r of cal.recentRules) ul.appendChild(h("li", {}, "最近学到：" + r.rule));
      calCard.appendChild(ul);
    }
    const actions = h("div", { class: "card-actions" });
    const openBtn = h("button", { class: "btn-mini" }, "校准中心");
    openBtn.addEventListener("click", () => switchView("style"));
    actions.appendChild(openBtn);
    calCard.appendChild(actions);
  }
  grid.appendChild(calCard);

  // ── 4. 灵感摘要（今日 top-3 可写 + 理由 + 一键开写,轻版选题裁决台）──
  const insp = d.inspirations || [];
  const inspCard = dashCard("今日可写", insp.length ? "灵感库 top " + insp.length : "灵感库空", "scout");
  if (insp.length === 0) {
    inspCard.appendChild(h("p", { class: "muted" }, "灵感库还是空的。雷达会自动送命中你定位的选题进来;也可以点顶栏「＋新想法」随手记。"));
  } else {
    const list = h("div", { class: "dash-insp" });
    for (const t of insp) {
      const row = h("div", { class: "dash-insp-row" });
      const body = h("div", { class: "dash-insp-body" });
      body.appendChild(h("div", { class: "dash-insp-title" }, t.title));
      if (t.reason) body.appendChild(h("div", { class: "muted dash-insp-reason" }, t.reason));
      row.appendChild(body);
      // 派活默认平台 = 你的第一席位（IA v4.2:不再硬编码公众号）
      const seat = typeof defaultSeat === "function" ? defaultSeat() : "wechat_mp";
      const writeBtn = h("button", { class: "btn-mini" }, "开写");
      writeBtn.addEventListener("click", () => {
        let brief = "用选题《" + t.title + "》写一篇" + platformLabel(seat) + "原生版本";
        const ctx = [];
        if (t.reason) ctx.push("入库理由：" + t.reason);
        if (t.link) ctx.push("参考链接：" + t.link + "（先用 read_url 读原文再写）");
        if (ctx.length) brief += "。选题上下文——" + ctx.join("；");
        sendChat(brief);
        showToast("已派给总编辑——看右侧对话");
      });
      row.appendChild(writeBtn);
      list.appendChild(row);
    }
    inspCard.appendChild(list);
  }
  // 情报源健康度一行（数据现成:radar:status;账号现状等第二批,这行不越界——只报已有真数据）
  safeInvoke(window.autocrew.radarStatus, {}).then((r) => {
    if (!r.ok || !r.data) return;
    const srcs = r.data.sources || [];
    const fetchedAt = r.data.fetchedAt;
    const ageH = fetchedAt ? Math.floor((Date.now() - new Date(fetchedAt).getTime()) / 3600000) : null;
    inspCard.appendChild(h("p", { class: "muted dash-hint" },
      "情报源 " + srcs.length + " 个" + (ageH !== null ? " · " + (ageH < 1 ? "刚刚" : ageH + " 小时前") + "更新" : " · 未扫过榜")));
  });
  grid.appendChild(inspCard);

  // ── 5. 管线摘要（朴素版）──
  const p = d.pipeline;
  const pipeCard = dashCard("管线", "灵感到发布", "system");
  const stats = h("div", { class: "dash-pipe" });
  for (const [label, n] of [["灵感", p.idea], ["在写", p.writing], ["待审", p.review], ["待发", p.ready], ["已发", p.published]]) {
    const cell = h("div", { class: "dash-pipe-cell" });
    cell.appendChild(h("div", { class: "dash-pipe-n" }, String(n)));
    cell.appendChild(h("div", { class: "muted dash-pipe-label" }, label));
    stats.appendChild(cell);
  }
  pipeCard.appendChild(stats);
  const pipeActions = h("div", { class: "card-actions" });
  const goBoard = h("button", { class: "btn-mini" }, "进看板");
  goBoard.addEventListener("click", () => switchView("board"));
  pipeActions.appendChild(goBoard);
  pipeCard.appendChild(pipeActions);
  grid.appendChild(pipeCard);
}
