/**
 * 公众号后台运营数据拉取 —— musegzh pull_wechat_stats.py 的 TS 移植(PRD §9 收编已验证路径)。
 *
 * 机制:CDP 会话基座(cdp-session.ts)开后台标签到 mp.weixin.qq.com → 在页面 origin 内 fetch
 * 后台自己的 appmsgpublish JSON 接口(credentials:'include' 自动带 cookie)→ 阅读/分享/在看/
 * 送达数/群发时刻。只读、低频、有人值守(GUI 一键触发)——合规口径与 PRD §6 红线同构。
 * 个人主体订阅号无 datacube 权限(实测 48001),这条是公众号回填的主路。
 *
 * 登录态三分法(in/out/timeout)原样保留:后台标签导航慢是瞬时态,绝不误报"请扫码"。
 * 新抓取器统一用 pull-types 的 7 值状态码,三态映射见 wechatStatusToPullStatus。
 */
import { CdpSession, withCdpTab, type CdpTab } from "./cdp-session.js";
import type { PullStatus } from "./pull-types.js";

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

/** 公众号后台登录态三分法(历史契约,pullWechatMpStats 的返回语义) */
export type WechatSessionStatus = "in" | "out" | "timeout";

const BACKEND = "https://mp.weixin.qq.com/";

/** 三态 → 结构化状态码(spec §4.1:公众号通道行为不变,只在状态语言上并轨) */
export function wechatStatusToPullStatus(status: WechatSessionStatus): PullStatus {
  if (status === "in") return "ok";
  if (status === "out") return "needs_login";
  return "timeout";
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

/** 后台页导航探测:token= 落到 /cgi-bin/home = 已登录;真落到登录页 = out;还卡 about:blank = 瞬时 */
async function probeBackend(
  cdp: CdpSession,
  tab: CdpTab,
  secs = 25,
): Promise<{ status: WechatSessionStatus; token: string | null }> {
  await cdp.cmd("Page.navigate", { url: BACKEND }, tab.sessionId).catch(() => {}); // 强推导航,别赖被降级的后台标签
  let href = "";
  for (let i = 0; i < secs * 2; i += 1) {
    href = String((await cdp.eval("location.href", tab.sessionId)) ?? "");
    if (href.includes("token=")) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const m = /token=(\d+)/.exec(href);
  if (href.includes("token=") && href.includes("/cgi-bin/home")) return { status: "in", token: m?.[1] ?? null };
  if (href.includes("mp.weixin.qq.com")) return { status: "out", token: null };
  return { status: "timeout", token: null };
}

async function fetchAllPages(
  cdp: CdpSession,
  tab: CdpTab,
  token: string,
  total: number,
  pageSize: number,
): Promise<WechatStatRow[]> {
  const byTitle = new Map<string, WechatStatRow>();
  for (let begin = 0; begin < total; begin += pageSize) {
    const url =
      `${BACKEND}cgi-bin/appmsgpublish?sub=list&begin=${begin}&count=${pageSize}` +
      `&token=${token}&lang=zh_CN&f=json&ajax=1`;
    const res = await cdp.fetchInPage(url, tab.sessionId);
    if (res.httpStatus !== 200) break;
    const rows = parsePublishPage(res.bodyText);
    if (rows.length === 0) break; // 拉到底
    for (const r of rows) byTitle.set(normTitle(r.title), r);
  }
  return [...byTitle.values()];
}

/** 拉全量已发文数据。timeout 自动重开标签重试;out 明确返回(调用方给扫码指引)。 */
export async function pullWechatMpStats(
  opts: { total?: number; pageSize?: number; attempts?: number } = {},
): Promise<{ status: WechatSessionStatus; rows: WechatStatRow[] }> {
  const { total = 100, pageSize = 20, attempts = 3 } = opts;
  const cdp = await CdpSession.connect();
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const res = await withCdpTab(cdp, BACKEND, async (tab) => {
        const probe = await probeBackend(cdp, tab);
        if (probe.status === "in" && probe.token) {
          return { status: "in" as WechatSessionStatus, rows: await fetchAllPages(cdp, tab, probe.token, total, pageSize) };
        }
        // 拿不到 token 的"已登录"当瞬时态处理:重开标签再试,不冒充登录失效
        return { status: probe.status === "in" ? "timeout" : probe.status, rows: [] as WechatStatRow[] };
      });
      if (res.status === "in") return res;
      if (res.status === "out") return { status: "out", rows: [] };
      await new Promise((r) => setTimeout(r, 1000)); // timeout → 重开标签再试
    }
    return { status: "timeout", rows: [] };
  } finally {
    cdp.close();
  }
}
