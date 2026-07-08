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
  };
  const subs = new Set();
  function notify() {
    for (const fn of subs) {
      try { fn(state); } catch (e) { console.error("[store] 订阅者异常", e); }
    }
  }
  return {
    state,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    hydrateEvents(events) { state.events = Array.isArray(events) ? events : []; notify(); },
    pushEvent(e) {
      if (!e || !e.label) return;
      state.events.push(e);
      if (state.events.length > 100) state.events.shift();
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
    });
  }
})();
