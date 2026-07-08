/**
 * 渲染层单一 store（P1 一期，PRD-v4 §7.3-1）：events + busy 两块状态，
 * widgets 订阅增量更新。全局只接线一次：engine:event 喂日志，
 * chat:progress 的 phase start/end 喂 presence 忙闲。
 */

const EngineStore = (() => {
  const state = {
    /** 工作日志事件（EngineEvent[]，尾部最新） */
    events: [],
    /** role -> { label, since }（真实工具执行中） */
    busy: {},
    /** runId -> { steps: [{label, role, done}], status: running|done, doneLabel, startedAt }（任务动态带,IA v4.2） */
    runs: {},
    /** 插入顺序（尾部最新），渲染任务带用 */
    runOrder: [],
  };
  const subs = new Set();
  function notify() {
    for (const fn of subs) {
      try { fn(state); } catch (e) { console.error("[store] 订阅者异常", e); }
    }
  }
  function ensureRun(runId) {
    if (!state.runs[runId]) {
      state.runs[runId] = { steps: [], status: "running", doneLabel: "", startedAt: Date.now() };
      state.runOrder.push(runId);
      // 只留最近 8 个 run——任务带是动态,不是档案（历史去 events）
      while (state.runOrder.length > 8) {
        delete state.runs[state.runOrder.shift()];
      }
    }
    return state.runs[runId];
  }
  return {
    state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    hydrateEvents(events) { state.events = Array.isArray(events) ? events : []; notify(); },
    pushEvent(e) {
      if (!e || !e.label) return;
      state.events.push(e);
      if (state.events.length > 100) state.events.shift();
      // 后台任务（生成后台化）:work+runId 开卡步进——chat 立即返回后,持续感由任务带承担
      if (e.kind === "work" && e.runId) {
        const run = ensureRun(e.runId);
        run.steps.push({ label: e.label, role: e.role || null, done: false });
      }
      // run 收尾信号（引擎事件流）:done / failed 都要闭合,任务带不许悬空
      if ((e.kind === "run_done" || e.kind === "run_failed") && e.runId) {
        const run = ensureRun(e.runId);
        run.status = e.kind === "run_done" ? "done" : "failed";
        run.doneLabel = e.label;
        run.steps.forEach((s) => { s.done = true; });
      }
      notify();
    },
    runStep(runId, role, label, phase) {
      if (!runId || !label) return;
      const run = ensureRun(runId);
      if (phase === "start") {
        run.steps.push({ label, role: role || null, done: false });
      } else {
        for (let i = run.steps.length - 1; i >= 0; i--) {
          if (run.steps[i].label === label && !run.steps[i].done) { run.steps[i].done = true; break; }
        }
      }
      notify();
    },
    setBusy(role, label) { if (!role) return; state.busy[role] = { label, since: Date.now() }; notify(); },
    clearBusy(role) { if (!role) return; delete state.busy[role]; notify(); },
  };
})();

(() => {
  if (!window.autocrew) return;
  if (typeof window.autocrew.onEngineEvent === "function") {
    window.autocrew.onEngineEvent((e) => EngineStore.pushEvent(e));
  }
  if (typeof window.autocrew.onChatProgress === "function") {
    window.autocrew.onChatProgress((e) => {
      if (!e) return;
      if (e.phase === "start") EngineStore.setBusy(e.role, e.label);
      if (e.phase === "end") EngineStore.clearBusy(e.role);
      if (e.runId) EngineStore.runStep(e.runId, e.role, e.label, e.phase);
    });
  }
})();
