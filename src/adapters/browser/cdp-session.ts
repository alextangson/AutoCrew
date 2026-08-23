/**
 * CDP 会话基座 —— 带登录态的后台标签 + 页面 origin 内 fetch(spec §4.1)。
 *
 * 机制:常驻 chrome-cdp(launchd ai.openclaw.chrome-cdp,默认 127.0.0.1:18792)的 profile
 * 持久化着各平台登录态 → 开后台标签 → 在页面 origin 内 fetch(credentials:'include')调
 * 后台自己的 JSON 接口。登录态永远留在浏览器 profile,AutoCrew 不提取/不存储 cookie。
 *
 * 为什么裸 CDP 不用 playwright:connect_over_cdp 在 Chrome 149+ 握手发
 * Browser.setDownloadBehavior 直接崩(musegzh 实测);裸 WebSocket 只发需要的命令,版本无关。
 * 零依赖:Node ≥22 全局 WebSocket。
 *
 * 加固点(codex #15,公众号首版的五处缺陷):
 * 1. 超时定时器成功路径清理,不再泄漏到进程退出;
 * 2. WebSocket 断开时 reject 全部 pending,不再挂到超时;
 * 3. Runtime.evaluate 检查 exceptionDetails,页面内异常转错误而非静默 undefined;
 * 4. in-page fetch 返回 {httpStatus,finalUrl,contentType,bodyText},由调用方按 schema 判定
 *    ——JSON 解析失败是接口漂移(schema_changed),不是"空数组";
 * 5. 标签页关闭放 finally(withCdpTab),异常路径也关。
 */

const DEFAULT_CDP_HTTP = process.env.AUTOCREW_CHROME_CDP ?? "http://127.0.0.1:18792";
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const VERSION_FETCH_TIMEOUT_MS = 15_000;
/** 页面内异常描述截断:够定位,又不把后台响应片段整段带进日志(codex #22) */
const ERROR_DETAIL_MAX = 300;

export interface CdpTab {
  targetId: string;
  sessionId: string;
}

/** 页面内 fetch 的原始结果——判定权归调用方,这里不替它解析 JSON */
export interface PageFetchResponse {
  httpStatus: number;
  /** 跟随重定向后的最终 URL(登录跳转的正向证据) */
  finalUrl: string;
  contentType: string;
  bodyText: string;
}

export interface CdpConnectOptions {
  httpBase?: string;
  commandTimeoutMs?: number;
  /** 测试注入点:默认全局 fetch */
  fetchImpl?: typeof fetch;
  /** 测试注入点:默认 new WebSocket(url) */
  createSocket?: (url: string) => WebSocket;
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

export class CdpSession {
  private id = 0;
  private pending = new Map<number, Pending>();
  private dead = false;

  private constructor(
    private readonly ws: WebSocket,
    private readonly commandTimeoutMs: number,
  ) {
    ws.addEventListener("message", (ev) => this.onMessage(String((ev as { data?: unknown }).data ?? "")));
    const onGone = () => {
      this.dead = true;
      this.rejectAllPending(new Error("chrome-cdp WebSocket 已断开"));
    };
    ws.addEventListener("close", onGone);
    ws.addEventListener("error", onGone);
  }

  static async connect(opts: CdpConnectOptions = {}): Promise<CdpSession> {
    const httpBase = opts.httpBase ?? DEFAULT_CDP_HTTP;
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(`${httpBase}/json/version`, { signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS) });
    const ver = (await res.json()) as { webSocketDebuggerUrl?: string };
    if (!ver.webSocketDebuggerUrl) throw new Error(`chrome-cdp 未返回 webSocketDebuggerUrl(${httpBase})`);
    const ws = opts.createSocket ? opts.createSocket(ver.webSocketDebuggerUrl) : new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error(`chrome-cdp WebSocket 连接失败(${httpBase})`));
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", fail, { once: true });
      ws.addEventListener("close", fail, { once: true });
    });
    return new CdpSession(ws, opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; error?: { message?: string }; result?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return; // 事件,忽略
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
    else p.resolve(msg.result ?? {});
  }

  private rejectAllPending(err: Error): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) p.reject(err);
  }

  cmd(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.dead) return Promise.reject(new Error(`chrome-cdp 连接已断开,${method} 未发出`));
    this.id += 1;
    const mid = this.id;
    const msg: Record<string, unknown> = { id: mid, method, params: params ?? {} };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(mid)) reject(new Error(`CDP ${method} ${this.commandTimeoutMs}ms 无响应`));
      }, this.commandTimeoutMs);
      timer.unref?.();
      // 成功/失败都清定时器——泄漏的定时器会把进程钉在事件循环里
      this.pending.set(mid, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        this.pending.delete(mid);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async openTab(url: string): Promise<CdpTab> {
    const t = await this.cmd("Target.createTarget", { url });
    const a = await this.cmd("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    return { targetId: String(t.targetId), sessionId: String(a.sessionId) };
  }

  /** 页面内求值;页面抛错 → 抛错(不再静默返回 undefined) */
  async eval(expression: string, sessionId: string, awaitPromise = false): Promise<unknown> {
    const r = await this.cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, sessionId);
    const ex = r.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
    if (ex) {
      const detail = (ex.exception?.description ?? ex.text ?? "unknown").slice(0, ERROR_DETAIL_MAX);
      throw new Error(`页面内表达式抛错:${detail}`);
    }
    return (r.result as { value?: unknown } | undefined)?.value;
  }

  /** 在后台页 origin 里 fetch(credentials:'include')—— cookie 自动带上,响应原样交回调用方 */
  async fetchInPage(url: string, sessionId: string): Promise<PageFetchResponse> {
    const expr =
      `(async()=>{const r=await fetch(${JSON.stringify(url)},{credentials:'include'});` +
      `return{httpStatus:r.status,finalUrl:r.url,contentType:r.headers.get('content-type')||'',bodyText:await r.text()};})()`;
    const raw = (await this.eval(expr, sessionId, true)) as Partial<PageFetchResponse> | undefined;
    if (!raw || typeof raw.httpStatus !== "number" || typeof raw.bodyText !== "string") {
      throw new Error("页面内 fetch 返回形状异常(缺 httpStatus/bodyText)");
    }
    return {
      httpStatus: raw.httpStatus,
      finalUrl: String(raw.finalUrl ?? url),
      contentType: String(raw.contentType ?? ""),
      bodyText: raw.bodyText,
    };
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.cmd("Target.closeTarget", { targetId }).catch(() => {});
  }

  close(): void {
    this.dead = true;
    try {
      this.ws.close();
    } catch {
      /* 断开即弃 */
    }
    this.rejectAllPending(new Error("chrome-cdp 连接已主动关闭"));
  }
}

/** 标签页生命周期:异常路径也关(不留后台幽灵标签) */
export async function withCdpTab<T>(
  session: CdpSession,
  url: string,
  fn: (tab: CdpTab) => Promise<T>,
): Promise<T> {
  const tab = await session.openTab(url);
  try {
    return await fn(tab);
  } finally {
    await session.closeTarget(tab.targetId);
  }
}
