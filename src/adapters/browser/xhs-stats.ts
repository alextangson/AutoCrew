/**
 * 小红书创作者后台数据拉取 —— **in-page fetch + 可选页面内签名**(spec §4.2 传输策略总表)。
 *
 * 三条纪律(端点文档 §3):
 * 1. **登录判定必须用免签端点**(`/api/galaxy/user/info`,退 `creator/note/user/posted`)。
 *    签名端点上 `success:false` 分不清「未登录」和「签名失败」——用它判登录必然误报;
 * 2. 数据优先试 `datacenter/note/analyze/list`(可能免签,**未确认**),失败再走签名的
 *    `note_stats/new`。第一版以免签路线为主:能不签就不签,签名一次性不可重放,失败面更大;
 * 3. HTTP 461/471 = 验证码风控 → `risk_control`,立即停手,不换路重试(重试只会更糟)。
 *
 * `x-s-common` 本地拼 base64 JSON 那条腿**故意不做**:端点文档有拼法,但它是纯本地重实现,
 * 一旦平台改算法就静默失效。等真实抓包确认 `x-s`/`x-t` 不够用时再补,不预先造。
 */
import { CdpSession } from "./cdp-session.js";
import type { OutcomeMetrics } from "../../modules/flywheel/outcome-schema.js";
import type { PullResult, TypedRow } from "./pull-types.js";
import {
  PAGE_ROW_LIMIT,
  assign,
  classifyThrown,
  envelopeOf,
  failure,
  fetchInPageWithInit,
  firstString,
  idOf,
  isRecord,
  isoFromMillis,
  paginate,
  sleep,
  waitForPageHost,
  withTab,
  type PageEvaluator,
  type PageFetchOutcome,
  type PageStep,
  type TabHost,
} from "./pull-shared.js";

const ORIGIN = "https://creator.xiaohongshu.com";
const HOST_FRAGMENT = "creator.xiaohongshu.com";
/** 必带 Referer——in-page fetch 从这个页面发起,Referer 自动就是它 */
export const XHS_PAGE = `${ORIGIN}/new/note-manager`;
/** 免签登录 ping(主 + 退) */
const LOGIN_PATHS = ["/api/galaxy/user/info", "/api/galaxy/creator/note/user/posted?tab=0&page=1"];
const ANALYZE_PATH = "/api/galaxy/creator/datacenter/note/analyze/list";
const STATS_PATH = "/api/galaxy/creator/data/note_stats/new";
const DEFAULT_PAGE_SIZE = 20;
const SIGN_RETRY_MS = 1_000;

export interface XhsSignature {
  xs: string;
  xt: string;
}

/** 页面内一次签名调用;拿不到就是 null(调用方决定重试还是放弃) */
async function trySign(page: PageEvaluator, sessionId: string, uri: string): Promise<XhsSignature | null> {
  const expr =
    `(()=>{if(typeof window._webmsxyw!=='function')return{missing:true};` +
    `const r=window._webmsxyw(${JSON.stringify(uri)},"");` +
    `return{missing:false,xs:String((r&&(r['X-s']||r['x-s']))||''),xt:String((r&&(r['X-t']||r['x-t']))||'')};})()`;
  try {
    const raw = await page.eval(expr, sessionId);
    if (!isRecord(raw) || raw.missing === true) return null;
    const xs = String(raw.xs ?? "");
    const xt = String(raw.xt ?? "");
    return xs && xt ? { xs, xt } : null;
  } catch {
    // `_webmsxyw is not a function` 会以异常形态回来(cdp-session 把 exceptionDetails 转错误)
    return null;
  }
}

/** 首次调用常报 `_webmsxyw is not a function`(脚本还没注册完)→ sleep 后重试一次 */
export async function signUri(
  page: PageEvaluator,
  sessionId: string,
  uri: string,
  retryDelayMs = SIGN_RETRY_MS,
): Promise<XhsSignature | null> {
  const first = await trySign(page, sessionId, uri);
  if (first) return first;
  await sleep(retryDelayMs);
  return trySign(page, sessionId, uri);
}

export function mapNoteRow(entry: unknown): TypedRow {
  const note = isRecord(entry) ? entry : {};
  const metrics: Partial<OutcomeMetrics> = {};
  assign(metrics, "views", note.read_count);
  assign(metrics, "likes", note.like_count);
  assign(metrics, "favorites", note.fav_count);
  assign(metrics, "comments", note.comment_count);
  // 曝光(impressions)三平台初版均无可靠来源,端点文档明说 xhs 曝光字段未确认 → 不映射
  const id = idOf(note.id, note.note_id);
  return {
    title: firstString(note.title, note.display_title, note.desc),
    publishedAt: isoFromMillis(note.post_time),
    ...(id ? { platformItemId: id } : {}),
    metrics,
  };
}

export type XhsParse =
  | { kind: "ok"; rows: TypedRow[] }
  | { kind: "stop"; result: PullResult };

/**
 * 笔记列表解析(纯函数,fixture 单测锚定)。信封 `{success, code, msg, data}`;
 * 列表主字段 `data.note_infos`,`data.list` 作为兼容形态(**待校准**)。
 */
export function parseNoteList(res: PageFetchOutcome, label: string): XhsParse {
  const env = envelopeOf(res, label);
  if (!env.ok) return { kind: "stop", result: env.result };
  if (env.json.success === false) {
    const code = typeof env.json.code === "number" ? env.json.code : "unknown";
    return { kind: "stop", result: failure("error", `${label}_code:${code}`) };
  }
  const data = isRecord(env.json.data) ? env.json.data : null;
  const list = data && (Array.isArray(data.note_infos) ? data.note_infos : Array.isArray(data.list) ? data.list : null);
  if (!list) return { kind: "stop", result: failure("schema_changed", `missing:${label}.data.note_infos`) };
  return { kind: "ok", rows: list.map(mapNoteRow) };
}

/** 登录判定:只用免签端点,`success === true` 才算在线(spec §4.1 正向证据) */
export function judgeLogin(res: PageFetchOutcome): PullResult | "logged_in" {
  const env = envelopeOf(res, "login_ping");
  if (!env.ok) return env.result;
  if (env.json.success === true) return "logged_in";
  if (env.json.success === false) return failure("needs_login", "login_ping_success_false");
  // 免签端点连 success 字段都没有 = 接口换了形状,不是没登录
  return failure("schema_changed", "missing:login_ping.success");
}

export interface XhsCdp extends PageEvaluator, TabHost {
  close(): void;
}

export interface PullXhsOptions {
  pageSize?: number;
  limit?: number;
  delayMs?: number;
  navTimeoutMs?: number;
  signRetryMs?: number;
  /** 测试注入点:默认连常驻 chrome-cdp */
  connect?: () => Promise<{ session: XhsCdp }>;
}

const getJson = (page: PageEvaluator, sessionId: string, path: string, headers?: Record<string, string>) =>
  fetchInPageWithInit(page, `${ORIGIN}${path}`, { method: "GET", headers }, sessionId);

/** 依次打免签登录端点,第一条给出明确结论就采信;两条都没结论时返回最后一条的结论 */
async function probeLogin(page: PageEvaluator, sessionId: string): Promise<PullResult | "logged_in"> {
  let last: PullResult | "logged_in" = failure("schema_changed", "missing:login_ping.success");
  for (const path of LOGIN_PATHS) {
    last = judgeLogin(await getJson(page, sessionId, path));
    if (last === "logged_in") return "logged_in";
    if (last.status === "risk_control" || last.status === "needs_login") return last;
  }
  return last;
}

function analyzeUri(pageNum: number, pageSize: number): string {
  return `${ANALYZE_PATH}?type=0&page_size=${pageSize}&page_num=${pageNum}`;
}

function statsUri(pageNum: number, pageSize: number): string {
  return `${STATS_PATH}?page=${pageNum}&page_size=${pageSize}&sort_by=time&note_type=0&time=30`;
}

/** 签名路线:签不出来就是 `sign_fn_missing`,不静默降级成「没数据」 */
async function fetchSignedPage(
  page: PageEvaluator,
  sessionId: string,
  pageNum: number,
  pageSize: number,
  signRetryMs: number,
): Promise<XhsParse> {
  const uri = statsUri(pageNum, pageSize);
  const sig = await signUri(page, sessionId, uri, signRetryMs);
  if (!sig) return { kind: "stop", result: failure("error", "sign_fn_missing") };
  return parseNoteList(await getJson(page, sessionId, uri, { "x-s": sig.xs, "x-t": sig.xt }), "note_stats");
}

function toStep(parse: XhsParse, pageNum: number, pageSize: number): PageStep<number> {
  if (parse.kind === "stop") return { kind: "stop", result: parse.result };
  return { kind: "page", rows: parse.rows, hasMore: parse.rows.length >= pageSize, next: pageNum + 1 };
}

/**
 * 选路:先探一页免签 analyze/list。风控立即停手;成功就走免签路线(第一页结果复用,不重打);
 * 其余情况(success:false / schema 不认)换签名路线——免签是否可用本就「未确认」。
 */
async function pickRoute(
  page: PageEvaluator,
  sessionId: string,
  pageSize: number,
  signRetryMs: number,
): Promise<{ mode: "analyze" | "signed"; first: XhsParse } | { mode: "stop"; result: PullResult }> {
  const probe = parseNoteList(await getJson(page, sessionId, analyzeUri(1, pageSize)), "analyze_list");
  if (probe.kind === "ok") return { mode: "analyze", first: probe };
  if (probe.result.status === "risk_control") return { mode: "stop", result: probe.result };
  const signedProbe = await fetchSignedPage(page, sessionId, 1, pageSize, signRetryMs);
  if (signedProbe.kind === "stop") return { mode: "stop", result: signedProbe.result };
  return { mode: "signed", first: signedProbe };
}

/**
 * 抓取小红书笔记数据。状态判定矩阵:
 *
 * | 输入 | 状态 |
 * |---|---|
 * | 免签 ping `success:true`,列表 `data.note_infos` 合法 | `ok`(超 200 行 → `hasMore:true`) |
 * | 免签 ping `success:false` | `needs_login` |
 * | 任一请求 HTTP 461/471 | `risk_control`(立即停,不换路) |
 * | 任一请求 HTTP 401/403 | `needs_login` |
 * | 任一请求 HTTP 其他非 200 | `error`(`http:<状态>`) |
 * | HTML 伪装 200 / JSON 解析失败 / 免签 ping 无 `success` / 列表缺 `data.note_infos` | `schema_changed` + 空 rows |
 * | 免签 analyze/list 不可用,且 `window._webmsxyw` 重试后仍缺失 | `error`(`sign_fn_missing`) |
 * | 签名端点信封 `success:false` | `error`(`note_stats_code:<码>`) |
 * | 标签页超时未落到 creator.xiaohongshu.com | `timeout` |
 * | chrome-cdp 连不上/连接断开 | `browser_unreachable` |
 */
export async function pullXhsStats(opts: PullXhsOptions = {}): Promise<PullResult> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const signRetryMs = opts.signRetryMs ?? SIGN_RETRY_MS;
  let session: XhsCdp;
  try {
    session = opts.connect ? (await opts.connect()).session : await CdpSession.connect();
  } catch (err) {
    return classifyThrown(err);
  }
  try {
    return await withTab(session, XHS_PAGE, async (tab) => {
      const ready = await waitForPageHost(session, tab.sessionId, HOST_FRAGMENT, opts.navTimeoutMs ?? 20_000);
      if (!ready) return failure("timeout", "page_not_ready");

      const login = await probeLogin(session, tab.sessionId);
      if (login !== "logged_in") return login;

      const route = await pickRoute(session, tab.sessionId, pageSize, signRetryMs);
      if (route.mode === "stop") return route.result;
      // 探路那一页的结果复用,不为选路多打一次请求(签名路线上尤其贵)
      let firstPage: XhsParse | null = route.first;

      return await paginate<number>(
        async (cursor) => {
          const pageNum = cursor ?? 1;
          if (firstPage) {
            const cached = firstPage;
            firstPage = null;
            return toStep(cached, pageNum, pageSize);
          }
          const parse =
            route.mode === "analyze"
              ? parseNoteList(await getJson(session, tab.sessionId, analyzeUri(pageNum, pageSize)), "analyze_list")
              : await fetchSignedPage(session, tab.sessionId, pageNum, pageSize, signRetryMs);
          return toStep(parse, pageNum, pageSize);
        },
        { firstCursor: 1, limit: opts.limit ?? PAGE_ROW_LIMIT, delayMs: opts.delayMs ?? 500 },
      );
    });
  } catch (err) {
    return classifyThrown(err);
  } finally {
    session.close();
  }
}
