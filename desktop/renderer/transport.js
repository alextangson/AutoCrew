/**
 * 浏览器传输层（PRD-v4 §11）——在 web 模式下用 fetch + SSE 复刻 Electron preload
 * 暴露的 window.autocrew 表面。config.js（server 动态生成）注入 window.__AUTOCREW。
 * 必须在其它 renderer 脚本之前加载。Electron 若并存则不覆盖（preload 优先）。
 */
(() => {
  if (window.autocrew) return; // Electron preload 已注入,让位
  const cfg = window.__AUTOCREW;
  if (!cfg) { console.error("[transport] 缺 config.js —— server 未注入 window.__AUTOCREW"); return; }

  const api = {};
  async function invoke(channel, payload) {
    const res = await fetch("/api/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-autocrew-token": cfg.token },
      body: JSON.stringify({ channel, payload: payload || {} }),
    });
    return res.json();
  }
  for (const [method, channel] of Object.entries(cfg.methodMap)) {
    api[method] = (payload) => invoke(channel, payload);
  }

  // 单条 SSE,按事件类型分发到 chat / engine 订阅者
  let source = null;
  const chatSubs = new Set();
  const engineSubs = new Set();
  function ensureSource() {
    if (source) return;
    source = new EventSource("/api/events?token=" + encodeURIComponent(cfg.token));
    source.addEventListener("chat", (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      for (const cb of chatSubs) { try { cb(d); } catch (e) { console.error(e); } }
    });
    source.addEventListener("engine", (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      for (const cb of engineSubs) { try { cb(d); } catch (e) { console.error(e); } }
    });
  }
  api.onChatProgress = (cb) => { ensureSource(); chatSubs.add(cb); return () => chatSubs.delete(cb); };
  api.onEngineEvent = (cb) => { ensureSource(); engineSubs.add(cb); return () => engineSubs.delete(cb); };

  window.autocrew = api;
})();
