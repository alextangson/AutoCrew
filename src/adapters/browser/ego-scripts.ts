/**
 * ego lite 子进程脚本生成（数据回流规格 2026-10-03）。
 *
 * 每个脚本交给 `ego-browser nodejs`（stdin）执行，在 ego lite 内嵌 Node 里跑，**不是页面里**。
 * 约定：
 * - 结果只认一行 `__AUTOCREW_EGO__{json}`；其余输出（升级提示等）一律忽略；
 * - 拿到 TaskSpace 立刻先打一行 `__AUTOCREW_EGO_SPACE__<id>`，供父进程在子进程被杀后兜底关；
 * - 参数整体 JSON 序列化进 `const P = …`，绝不把 URL/表达式拼进代码文本；
 * - 旁听脚本（browseScript）自己管 TaskSpace 生命周期：任何路径都 `finish({ keep: [] })`；
 * - **只看不发**：脚本只开官方页面、旁听页面自己收到的响应、像人一样滚动/点翻页；
 *   不调用平台接口、不加请求头、不调页面签名函数（规格 2026-10-03-metrics-pull-human-like）。
 */

export const EGO_RESULT_MARKER = "__AUTOCREW_EGO__";
/** 一拿到 TaskSpace 就先报 spaceId：子进程之后卡死被杀，父进程也知道该关哪个 */
export const EGO_SPACE_MARKER = "__AUTOCREW_EGO_SPACE__";
/** 每拿到一页完整数据就先打一行：子进程之后出错 / 被杀，已拿到的页父进程照样能用 */
export const EGO_PAGE_MARKER = "__AUTOCREW_EGO_PAGE__";

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

/** 页面上可见文字（含 shadow DOM，视频号是 wujie 微前端）：只用于判登录墙 / 风控页，不用来抓数 */
const PAGE_TEXT_EXPR =
  "(()=>{let t=document.body?document.body.innerText:'';for(const el of document.querySelectorAll('*'))if(el.shadowRoot)t+='\\n'+(el.shadowRoot.textContent||'');return t.slice(0,6000)})()";

/**
 * 找翻页控件（含 shadow DOM）：css 圈候选，texts 非空按文字精确匹配，为空取「无文字」的那个（图标箭头）；
 * 多个命中取最后一个（最内层 / 最靠后）。返回是否禁用与屏幕坐标，点击走原生鼠标。
 */
const FIND_NEXT_FN = `(cfg) => {
  const roots = [document];
  for (const el of document.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
  let hit = null;
  for (const root of roots) {
    for (const el of root.querySelectorAll(cfg.css)) {
      const t = (el.innerText || el.textContent || '').trim();
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (cfg.texts.length ? cfg.texts.includes(t) : t === '') hit = el;
    }
  }
  if (!hit) return { found: false };
  const off = (el) => !!el && (el.disabled === true || el.getAttribute('aria-disabled') === 'true' || /disabled/i.test(String(el.className || '')));
  if (off(hit) || off(hit.parentElement)) return { found: true, disabled: true };
  hit.scrollIntoView({ block: 'center' });
  const r = hit.getBoundingClientRect();
  return { found: true, disabled: false, x: r.x + r.width / 2, y: r.y + r.height / 2 };
}`;

const BROWSE_HELPERS = `      const page = task.page("p1");
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const rand = (a, b) => a + Math.random() * (b - a);
      const pause = () => sleep(rand(P.pauseMinMs, P.pauseMaxMs));
      const inspect = (0, eval)("(" + P.inspectSrc + ")");
      const rx = (s) => (s ? new RegExp(s, "i") : null);
      const G = { loginUrl: rx(P.gates.loginUrl), riskUrl: rx(P.gates.riskUrl), loginText: rx(P.gates.loginText), riskText: rx(P.gates.riskText) };
      const seen = new Set();
      const pending = [];
      const collect = (events) => {
        for (const ev of events || []) {
          if (!ev || ev.method !== "Network.responseReceived") continue;
          const r = (ev.params && ev.params.response) || {};
          const url = String(r.url || "");
          const id = ev.params.requestId;
          if (id && !seen.has(id) && P.patterns.some((x) => url.includes(x))) {
            seen.add(id);
            pending.push({ requestId: id, url, status: Number(r.status) || 0 });
          }
        }
      };
      const gate = async (withText) => {
        const href = String(await page.evaluate("location.href").catch(() => ""));
        if (G.riskUrl && G.riskUrl.test(href)) return "risk";
        if (G.loginUrl && G.loginUrl.test(href)) return "login";
        if (!withText) return null;
        const text = String(await page.evaluate(${JSON.stringify(PAGE_TEXT_EXPR)}).catch(() => ""));
        if (G.riskText && G.riskText.test(text)) return "risk";
        if (G.loginText && G.loginText.test(text)) return "login";
        return null;
      };
      const readBody = async (requestId) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const r = await page.cdp("Network.getResponseBody", { requestId });
            const raw = typeof r.body === "string" ? r.body : "";
            return r.base64Encoded === true ? Buffer.from(raw, "base64").toString("utf8") : raw;
          } catch {
            await sleep(400);
          }
        }
        return null;
      };`;

const BROWSE_WAIT = `      const waitPage = async (ms) => {
        const deadline = Date.now() + ms;
        let lastGate = Date.now();
        collect(await page.events());
        while (pending.length === 0 && Date.now() < deadline) {
          await sleep(250);
          collect(await page.events());
          if (Date.now() - lastGate > 1000) {
            lastGate = Date.now();
            const g = await gate(false);
            if (g) return { gate: g, responses: [] };
          }
        }
        if (pending.length === 0) return { gate: await gate(true), responses: [] };
        await sleep(P.settleMs);
        collect(await page.events());
        const responses = [];
        for (const p of pending.splice(0)) {
          const body = await readBody(p.requestId);
          if (body !== null) responses.push({ url: p.url, status: p.status, body });
        }
        return { gate: null, responses };
      };
      const advance = async () => {
        const info = await page.info().catch(() => ({ w: 1280, h: 800 }));
        if (P.next.kind === "scroll") {
          await page.mouse.move(rand(0.35, 0.65) * (info.w || 1280), rand(0.45, 0.7) * (info.h || 800), { steps: 6 + Math.floor(rand(0, 6)) });
          const n = 3 + Math.floor(rand(0, 4));
          for (let i = 0; i < n; i += 1) { await page.mouse.wheel(0, rand(400, 900)); await sleep(rand(250, 700)); }
          return "moved";
        }
        const hit = await page.evaluate("(" + ${JSON.stringify(FIND_NEXT_FN)} + ")(" + JSON.stringify(P.next) + ")");
        if (!hit || !hit.found) return "pagination_missing";
        if (hit.disabled) return "no_more";
        await sleep(rand(300, 800));
        await page.mouse.move(hit.x + rand(-3, 3), hit.y + rand(-2, 2), { steps: 8 + Math.floor(rand(0, 8)) });
        await page.mouse.click(hit.x, hit.y);
        return "moved";
      };`;

const BROWSE_MAIN = `      const follow = async () => {
        const re = new RegExp(P.follow.match);
        const deadline = Date.now() + P.waitMs;
        let m = null;
        while (!m && Date.now() < deadline) {
          m = re.exec(String(await page.evaluate("location.href").catch(() => "")));
          if (!m) await sleep(500);
        }
        if (!m) return false;
        await pause();
        await page.goto(P.follow.template.replace("$1", m[1]), { waitUntil: "domcontentloaded", timeout: P.navTimeoutMs }).catch(() => {});
        return true;
      };
      await page.cdp("Network.enable", {});
      await page.events();
      await page.goto(P.url, { waitUntil: "domcontentloaded", timeout: P.navTimeoutMs }).catch(() => {});
      if (P.follow && !(await follow())) return { pages: 0, end: "no_response", gate: await gate(true) };
      let pages = 0;
      for (let i = 0; i < P.maxPages; i += 1) {
        const got = await waitPage(i === 0 ? P.waitMs : P.nextWaitMs);
        if (got.gate) return { pages, end: "gate", gate: got.gate };
        if (got.responses.length === 0) return { pages, end: i === 0 ? "no_response" : "no_new_response", gate: null };
        console.log(${JSON.stringify("__PAGE__")} + JSON.stringify({ index: i, responses: got.responses }));
        pages += 1;
        if (got.responses.some((r) => r.status < 200 || r.status >= 300)) return { pages, end: "http_status", gate: null };
        let seenInfo = { oldestMs: null, hasMore: null };
        try { seenInfo = inspect(got.responses) || seenInfo; } catch { /* 判不出就按「还有」处理，翻页上限兜底 */ }
        if (typeof seenInfo.oldestMs === "number" && seenInfo.oldestMs < P.cutoffMs) return { pages, end: "cutoff", gate: null };
        if (seenInfo.hasMore === false) return { pages, end: "no_more", gate: null };
        if (i === P.maxPages - 1) break;
        await pause();
        const moved = await advance();
        if (moved !== "moved") return { pages, end: moved, gate: null };
      }
      return { pages, end: "max_pages", gate: null };`;

/** 旁听一次抓取的参数（平台差异全在这里，脚本本身不认平台） */
export interface BrowseParams {
  space: string;
  url: string;
  /** 先落到某个 URL 再跳数据页（公众号：首页 URL 里拿 token 拼发表记录页） */
  follow?: { match: string; template: string };
  patterns: string[];
  gates: { loginUrl?: string; riskUrl?: string; loginText?: string; riskText?: string };
  next: { kind: "scroll" } | { kind: "click"; css: string; texts: string[] };
  /** 自包含 JS 函数源码：(responses) => { oldestMs, hasMore } —— 决定还翻不翻 */
  inspectSrc: string;
  cutoffMs: number;
  maxPages: number;
  waitMs: number;
  nextWaitMs: number;
  settleMs: number;
  navTimeoutMs: number;
  pauseMinMs: number;
  pauseMaxMs: number;
}

/**
 * 旁听抓取：一个子进程走完「开 Network → 打开官方页 → 收页面自己的数据响应 → 像人一样翻页 → 关 TaskSpace」。
 * 每页先打一行 EGO_PAGE_MARKER；翻页前随机停 pauseMin–pauseMax；碰到登录页 / 风控页立刻收手（不绕过）。
 */
export function browseScript(p: BrowseParams): string {
  const body = [BROWSE_HELPERS, BROWSE_WAIT, BROWSE_MAIN].join("\n").replace(JSON.stringify("__PAGE__"), JSON.stringify(EGO_PAGE_MARKER));
  return wrap(p, body, { finishOnError: true, finishAlways: true });
}

/** 关掉 TaskSpace（不保留任何 Agent 页；用户自己的标签受 ego lite 保护，不会被关）——父进程兜底收尾用 */
export function finishScript(p: { space: number }): string {
  const body = `      await task.finish({ keep: [] });
      return {};`;
  return wrap(p, body, { finishOnError: false, finishAlways: false });
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
