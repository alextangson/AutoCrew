/**
 * 公众号后台运营数据拉取 —— musegzh pull_wechat_stats.py 的 TS 移植(PRD §9 收编已验证路径)。
 *
 * 机制:常驻 chrome-cdp(launchd ai.openclaw.chrome-cdp,默认 127.0.0.1:18792)的 profile
 * 持久化着 mp.weixin.qq.com 登录态 → 开后台标签 → 在页面 origin 内 fetch 后台自己的
 * appmsgpublish JSON 接口(credentials:'include' 自动带 cookie)→ 阅读/分享/在看/送达数/群发时刻。
 * 只读、低频、有人值守(GUI 一键触发)——合规口径与 PRD §6 红线同构。个人主体订阅号无
 * datacube 权限(实测 48001),这条是公众号回填的主路。
 *
 * 为什么裸 CDP 不用 playwright:connect_over_cdp 在 Chrome 149+ 握手发
 * Browser.setDownloadBehavior 直接崩(musegzh 实测);裸 WebSocket 只发需要的命令,版本无关。
 * 登录态三分法(in/out/timeout)原样保留:后台标签导航慢是瞬时态,绝不误报"请扫码"。
 */

export interface WechatStatRow {
  title: string;
  /** 阅读次数(read_num) */
  read: number;
  /** 分享次数(share_num) */
  share: number;
  /** 在看(old_like_num) */
  like: number;
  /** 群发那刻送达粉丝数(sent_status.total,打开率分母) */
  fans: number;
  /** 群发时刻(unix 秒) */
  sentTime: number;
}

export type PullStatus = "in" | "out" | "timeout";

const CDP_HTTP = process.env.AUTOCREW_CHROME_CDP ?? "http://127.0.0.1:18792";
const BACKEND = "https://mp.weixin.qq.com/";

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

/** 裸 CDP over WebSocket(Node ≥22 全局 WebSocket,零依赖)。只发需要的命令,事件全忽略。 */
class Cdp {
  private id = 0;
  private pending = new Map<number, Pending>();

  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      let msg: { id?: number; error?: { message?: string }; result?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof msg.id !== "number") return; // 事件,忽略
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
      else p.resolve(msg.result ?? {});
    });
  }

  static async connect(httpBase = CDP_HTTP): Promise<Cdp> {
    const ver = (await (await fetch(`${httpBase}/json/version`, { signal: AbortSignal.timeout(15_000) })).json()) as {
      webSocketDebuggerUrl: string;
    };
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`chrome-cdp WebSocket 连接失败(${httpBase})`)), { once: true });
    });
    return new Cdp(ws);
  }

  cmd(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
    this.id += 1;
    const mid = this.id;
    const msg: Record<string, unknown> = { id: mid, method, params: params ?? {} };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(mid, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.pending.delete(mid)) reject(new Error(`CDP ${method} 30s 无响应`));
      }, 30_000).unref?.();
    });
  }

  async openTab(url: string): Promise<{ targetId: string; sessionId: string }> {
    const t = await this.cmd("Target.createTarget", { url });
    const a = await this.cmd("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    return { targetId: String(t.targetId), sessionId: String(a.sessionId) };
  }

  async eval(expr: string, sessionId: string, awaitPromise = false): Promise<unknown> {
    const r = await this.cmd("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise }, sessionId);
    return (r.result as { value?: unknown } | undefined)?.value;
  }

  /** 在后台页 origin 里 fetch(credentials:'include')—— cookie 自动带上 */
  fetchText(url: string, sessionId: string): Promise<unknown> {
    const expr = `(async()=>{const r=await fetch(${JSON.stringify(url)},{credentials:'include'});return await r.text();})()`;
    return this.eval(expr, sessionId, true);
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.cmd("Target.closeTarget", { targetId }).catch(() => {});
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* 断开即弃 */
    }
  }
}

/** 解析 appmsgpublish 响应(纯函数,单测锚定):publish_page 与 publish_info 都可能是 JSON 字符串 */
export function parsePublishPage(body: string): WechatStatRow[] {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return [];
  }
  let pp = (j as { publish_page?: unknown }).publish_page;
  if (typeof pp === "string") {
    try {
      pp = JSON.parse(pp);
    } catch {
      return [];
    }
  }
  const list = ((pp as { publish_list?: unknown[] } | undefined)?.publish_list ?? []) as Array<Record<string, unknown>>;
  const out: WechatStatRow[] = [];
  for (const entry of list) {
    let pi = entry.publish_info;
    if (typeof pi === "string") {
      try {
        pi = JSON.parse(pi);
      } catch {
        continue;
      }
    }
    const info = pi as
      | { sent_status?: { total?: number }; sent_info?: { time?: number }; appmsg_info?: Array<Record<string, unknown>> }
      | undefined;
    const fans = Number(info?.sent_status?.total ?? 0) || 0;
    const sentTime = Number(info?.sent_info?.time ?? 0) || 0;
    for (const a of info?.appmsg_info ?? []) {
      const title = String(a.title ?? "");
      if (!title) continue;
      out.push({
        title,
        read: Number(a.read_num ?? 0) || 0,
        share: Number(a.share_num ?? 0) || 0,
        like: Number(a.old_like_num ?? 0) || 0,
        fans,
        sentTime,
      });
    }
  }
  return out;
}

function fmtSentTime(ts: number): string {
  if (!ts) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ts * 1000));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
}

/** 行 → 导入管线列(键名对齐 PLATFORM_MAPPINGS.wechat_mp 别名;fans 不入指标,仅留在标题匹配之外) */
export function statsToImportRows(rows: WechatStatRow[]): Array<Record<string, string>> {
  return rows.map((r) => ({
    标题: r.title,
    发表时间: fmtSentTime(r.sentTime),
    阅读次数: String(r.read),
    分享次数: String(r.share),
    在看次数: String(r.like),
  }));
}

const normTitle = (t: string): string => (t || "").toLowerCase().replace(/[^\w一-鿿]/g, "");

async function openBackend(cdp: Cdp, secs = 25): Promise<{ targetId: string; sessionId: string; status: PullStatus; token: string | null }> {
  const { targetId, sessionId } = await cdp.openTab(BACKEND);
  await cdp.cmd("Page.navigate", { url: BACKEND }, sessionId).catch(() => {}); // 强推导航,别赖被降级的后台标签
  let href = "";
  for (let i = 0; i < secs * 2; i += 1) {
    href = String((await cdp.eval("location.href", sessionId)) ?? "");
    if (href.includes("token=")) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const m = /token=(\d+)/.exec(href);
  if (href.includes("token=") && href.includes("/cgi-bin/home")) return { targetId, sessionId, status: "in", token: m?.[1] ?? null };
  if (href.includes("mp.weixin.qq.com")) return { targetId, sessionId, status: "out", token: null }; // 真落到登录页
  return { targetId, sessionId, status: "timeout", token: null }; // 还卡 about:blank,瞬时
}

/** 拉全量已发文数据。timeout 自动重开标签重试;out 明确返回(调用方给扫码指引)。 */
export async function pullWechatMpStats(
  opts: { total?: number; pageSize?: number; attempts?: number } = {},
): Promise<{ status: PullStatus; rows: WechatStatRow[] }> {
  const { total = 100, pageSize = 20, attempts = 3 } = opts;
  const cdp = await Cdp.connect();
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const { targetId, sessionId, status, token } = await openBackend(cdp);
      if (status === "in" && token) {
        const byTitle = new Map<string, WechatStatRow>();
        for (let begin = 0; begin < total; begin += pageSize) {
          const url =
            `${BACKEND}cgi-bin/appmsgpublish?sub=list&begin=${begin}&count=${pageSize}` +
            `&token=${token}&lang=zh_CN&f=json&ajax=1`;
          const body = await cdp.fetchText(url, sessionId);
          const rows = typeof body === "string" ? parsePublishPage(body) : [];
          if (rows.length === 0) break; // 拉到底
          for (const r of rows) byTitle.set(normTitle(r.title), r);
        }
        await cdp.closeTarget(targetId);
        return { status: "in", rows: [...byTitle.values()] };
      }
      await cdp.closeTarget(targetId);
      if (status === "out") return { status: "out", rows: [] };
      await new Promise((r) => setTimeout(r, 1000)); // timeout → 重开标签再试
    }
    return { status: "timeout", rows: [] };
  } finally {
    cdp.close();
  }
}
