/**
 * ego lite 子进程脚本生成（数据回流规格 2026-10-03）。
 *
 * 每个脚本交给 `ego-browser nodejs`（stdin）执行，在 ego lite 内嵌 Node 里跑，**不是页面里**。
 * 约定：
 * - 结果只认一行 `__AUTOCREW_EGO__{json}`；其余输出（升级提示等）一律忽略；
 * - 拿到 TaskSpace 立刻先打一行 `__AUTOCREW_EGO_SPACE__<id>`，供父进程在子进程被杀后兜底关；
 * - 参数整体 JSON 序列化进 `const P = …`，绝不把 URL/表达式拼进代码文本；
 * - 打开页、旁听抓包两类脚本自己管 TaskSpace 生命周期：异常路径也 `finish({ keep: [] })`；
 *   在已开 TaskSpace 里的单步操作（eval/fetch）失败不关——由会话收尾统一 finish。
 */

export const EGO_RESULT_MARKER = "__AUTOCREW_EGO__";
/** 一拿到 TaskSpace 就先报 spaceId：子进程之后卡死被杀，父进程也知道该关哪个 */
export const EGO_SPACE_MARKER = "__AUTOCREW_EGO_SPACE__";

/** 每个脚本共用的开头：参数、输出、错误文本 */
function prelude(params: unknown): string {
  return [
    `const P = ${JSON.stringify(params)};`,
    `const emit = (o) => console.log(${JSON.stringify(EGO_RESULT_MARKER)} + JSON.stringify(o));`,
    `const errText = (e) => String((e && e.message) || e).slice(0, 300);`,
  ].join("\n");
}

/**
 * 统一骨架：先连 TaskSpace（连不上 = stage "connect"，调用方判浏览器未连接），
 * 再跑 body。`finishOnError` / `finishAlways` 决定异常路径是否关掉这个 TaskSpace。
 */
function wrap(params: unknown, body: string, policy: { finishOnError: boolean; finishAlways: boolean }): string {
  const finishCall = "await task.finish({ keep: [] }).catch(() => {});";
  return `${prelude(params)}
let task = null;
try {
  task = await taskSpace(P.space);
  console.log(${JSON.stringify(EGO_SPACE_MARKER)} + task.spaceId);
} catch (e) {
  emit({ ok: false, stage: "connect", error: errText(e) });
}
if (task) {
  let failed = false;
  try {
    const out = await (async () => {
${body}
    })();
    emit({ ok: true, spaceId: task.spaceId, ...out });
  } catch (e) {
    failed = true;
    ${policy.finishOnError && !policy.finishAlways ? finishCall : ""}
    emit({ ok: false, stage: "op", spaceId: task.spaceId, error: errText(e) });
  } finally {
    ${policy.finishAlways ? finishCall : "void failed;"}
  }
}
`;
}

/** 新建一个 TaskSpace，把 p1 导航到平台后台页；导航失败就当场关掉这个 TaskSpace */
export function openScript(p: { space: string; url: string; timeoutMs: number }): string {
  const body = `      const page = task.page("p1");
      await page.goto(P.url, { waitUntil: "domcontentloaded", timeout: P.timeoutMs });
      return {};`;
  return wrap(p, body, { finishOnError: true, finishAlways: false });
}

/** 在已开 TaskSpace 的 p1 里求值（页面内表达式；Promise 会被等完） */
export function evalScript(p: { space: number; expression: string }): string {
  const body = `      const value = await task.page("p1").evaluate(P.expression);
      return { value: value === undefined ? null : value };`;
  return wrap(p, body, { finishOnError: false, finishAlways: false });
}

/** 在已开 TaskSpace 的 p1 里 page.fetch（window.fetch，带页面 cookie），交回 PageFetchResponse 形状 */
export function fetchScript(p: {
  space: number;
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string; timeout: number };
}): string {
  const body = `      const r = await task.page("p1").fetch(P.url, { ...P.init, credentials: "include" });
      const headers = r.headers || {};
      const ct = typeof headers.get === "function" ? headers.get("content-type") : (headers["content-type"] || headers["Content-Type"]);
      return { response: { httpStatus: r.status, finalUrl: r.url || P.url, contentType: String(ct || ""), bodyText: String(r.body ?? "") } };`;
  return wrap(p, body, { finishOnError: false, finishAlways: false });
}

/** 关掉 TaskSpace（不保留任何 Agent 页；用户自己的标签受 ego lite 保护，不会被关） */
export function finishScript(p: { space: number }): string {
  const body = `      await task.finish({ keep: [] });
      return {};`;
  return wrap(p, body, { finishOnError: false, finishAlways: false });
}

const INTERCEPT_BODY = `      const page = task.page("p1");
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const ids = [];
      const collect = (events) => {
        for (const ev of events || []) {
          const params = (ev && ev.params) || {};
          if (!ev || ev.method !== "Network.responseReceived") continue;
          const url = String((params.response && params.response.url) || "");
          const id = params.requestId;
          if (id && P.patterns.some((x) => url.includes(x)) && !ids.includes(id)) ids.push(id);
        }
      };
      await page.cdp("Network.enable", {});
      await page.events();
      await page.goto(P.url, { waitUntil: "domcontentloaded", timeout: P.waitMs }).catch(() => {});
      const deadline = Date.now() + P.waitMs;
      collect(await page.events());
      while (ids.length === 0 && Date.now() < deadline) {
        await sleep(250);
        collect(await page.events());
      }
      if (ids.length === 0) {
        const domText = await page.evaluate("document.body ? document.body.innerText.slice(0,4000) : ''").catch(() => null);
        return { matched: 0, bodies: [], domText: typeof domText === "string" ? domText : null };
      }
      await sleep(P.settleMs);
      collect(await page.events());
      const bodies = [];
      for (const requestId of ids) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const r = await page.cdp("Network.getResponseBody", { requestId });
            const raw = typeof r.body === "string" ? r.body : "";
            bodies.push(r.base64Encoded === true ? Buffer.from(raw, "base64").toString("utf8") : raw);
            break;
          } catch {
            await sleep(300);
          }
        }
      }
      return { matched: ids.length, bodies, domText: null };`;

/**
 * 抖音旁听：一个子进程走完「开 Network → 导航作品管理页 → 收列表响应体 → 关 TaskSpace」。
 * 抖音接口带页面自己算的签名，只能让页面自己发请求、我们接响应（同旧 CDP 路线）。
 * 什么都没拦到时顺手取页面文本前 4000 字，交给调用方判登录墙——文本只用于判定，不出这个进程以外的日志。
 */
export function interceptScript(p: {
  space: string;
  url: string;
  patterns: string[];
  waitMs: number;
  settleMs: number;
}): string {
  return wrap(p, INTERCEPT_BODY, { finishOnError: true, finishAlways: true });
}

/** doctor 用：只连一下 ego lite（列 TaskSpace），不开任何页 */
export function pingScript(): string {
  return `${prelude({})}
try {
  const spaces = await listTaskSpaces();
  emit({ ok: true, spaces: Array.isArray(spaces) ? spaces.length : 0 });
} catch (e) {
  emit({ ok: false, stage: "connect", error: errText(e) });
}
`;
}
