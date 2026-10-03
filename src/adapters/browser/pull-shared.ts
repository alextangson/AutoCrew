/**
 * 四平台旁听抓取器共享件 —— 信封判定 / 行校验 / 错误脱敏(spec §4.1 §4.2 §6)。
 *
 * 三条铁律都落在这个文件里,抓取器只负责各自的传输与字段映射:
 * 1. **零写入语义在抓取器层就是空 rows**:schema 不符 → `schema_changed` + `rows: []`;
 * 2. **errorCode 永不含响应原文**(codex #22):只由 HTTP 状态码、我们自己写死的 schema
 *    字段名、错误类别常量拼成,`sanitizeErrorCode` 再兜一道字符白名单;
 * 3. **行数上限 200**,超出只说 `hasMore: true`,不谎报精确丢弃数(codex #23)。
 */
import type { OutcomeMetrics } from "../../modules/flywheel/outcome-schema.js";
import type { PullResult, PullStatus, TypedRow } from "./pull-types.js";
import { EgoChannelError, type CapturedResponse } from "./ego-session.js";

/** 单次抓取入库上限(spec §4.2);超出即 hasMore */
export const PAGE_ROW_LIMIT = 200;
/** errorCode 长度上限——够定位,又不可能塞下一段响应 */
const ERROR_CODE_MAX = 64;

/**
 * 错误码字符白名单。调用方本就只传常量+数字,这里是「就算哪天有人手滑把 message
 * 拼进来,也漏不出中文标题/token/账号标识」的最后一道闸。
 */
export function sanitizeErrorCode(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_:.-]/g, "").slice(0, ERROR_CODE_MAX);
}

export function failure(status: Exclude<PullStatus, "ok">, errorCode: string): PullResult {
  return { status, rows: [], errorCode: sanitizeErrorCode(errorCode) };
}

/** 关键字段缺失 = 接口漂移的 canary。field 是我们写死的路径名,不是响应内容 */
export function schemaChanged(field: string): PullResult {
  return failure("schema_changed", `missing:${field}`);
}

/** HTTP 非 2xx 的通用归类:401/403 判登录,461/471 判风控(小红书),其余 error */
export function httpFailure(httpStatus: number): PullResult {
  if (httpStatus === 401 || httpStatus === 403) return failure("needs_login", `http:${httpStatus}`);
  if (httpStatus === 461 || httpStatus === 471) return failure("risk_control", `http:${httpStatus}`);
  return failure("error", `http:${httpStatus}`);
}

export function okResult(rows: TypedRow[], hasMore: boolean): PullResult {
  return { status: "ok", rows, hasMore };
}

/**
 * 抛出的异常 → 结构化状态码。通道层（EgoChannelError）在抛出处已定好状态与错误码，原样采信；
 * 其余异常**读 message 只为归类，绝不把 message 放进 errorCode**——异常文本里可能带页面内片段。
 */
export function classifyThrown(err: unknown): PullResult {
  if (err instanceof EgoChannelError) return failure(err.status, err.code);
  const msg = err instanceof Error ? err.message : String(err);
  if (/断开|关闭|ECONNREFUSED|fetch failed|连接失败|Target closed/i.test(msg)) {
    return failure("browser_unreachable", "ego_unreachable");
  }
  if (/无响应|timed? ?out|timeout/i.test(msg)) return failure("timeout", "page_timeout");
  return failure("error", "exception");
}

/** JSON 解析成功与否是判定输入,不能吞成空数组(spec §4.1) */
export function parseJsonSafe(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** HTML 伪装 200:登录墙/风控页最常见的形态,一律当接口漂移处理 */
export function looksLikeHtml(contentType: string, body: string): boolean {
  if (/text\/html/i.test(contentType)) return true;
  const head = body.trimStart().slice(0, 20).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html");
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 精度保护:平台作品 id 常是 19 位 JSON number,`JSON.parse` 会把 7412345678901234567
 * 变成 7412345678901234000 —— 一个**错的作品 id** 比没有 id 更坏(会绑错稿件)。
 * 解析之前在文本层把 15 位以上的目标字段包成字符串,不引 BigInt 也不丢位。
 */
export function protectLongNumbers(text: string, keys: string[]): string {
  const pattern = new RegExp(`"(${keys.join("|")})"\\s*:\\s*(\\d{15,})`, "g");
  return text.replace(pattern, '"$1":"$2"');
}

/** id 取值:字符串直接用,数字转字符串(已被 protectLongNumbers 提前保护过的除外) */
export function idOf(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
  }
  return "";
}

/**
 * 计数类指标取值:平台常把数字发成字符串(抖音 metrics 全字符串),空串/null/"-"/NaN
 * 一律当没有这个指标——**不补 0**,0 和「没数据」在复盘里是两回事。
 */
export function toCount(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  if (typeof raw === "boolean") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 率类指标归一到 outcome-schema 的 RATE_METRICS 约定(百分比 0-100)。
 * 平台发 0.32 还是 32 各家不一(**待真实抓包校准**):≤1 一律当比例乘 100,
 * 归一后越界直接丢弃该指标——宁可少一个指标,也不喂给 validateOutcome 一个必拒的值。
 */
export function normalizeRate(raw: unknown): number | undefined {
  const n = toCount(raw);
  if (n === undefined || n < 0) return undefined;
  const pct = n <= 1 ? n * 100 : n;
  return pct > 100 ? undefined : pct;
}

/** 只在有值时落键:Partial<OutcomeMetrics> 里 undefined 键与不存在等价,但别写进去 */
export function assign(metrics: Partial<OutcomeMetrics>, key: keyof OutcomeMetrics, raw: unknown): void {
  const v = key === "completionRate" || key === "completion5s" || key === "coverClickRate" ? normalizeRate(raw) : toCount(raw);
  if (v !== undefined) metrics[key] = v;
}

export function hasAnyMetric(metrics: Partial<OutcomeMetrics>): boolean {
  return Object.values(metrics).some((v) => typeof v === "number" && Number.isFinite(v));
}

/** 行级校验(spec §6):标题非空 + 至少一个数值指标;不合格丢弃并计数,不拖累整批 */
export function keepValidRows(rows: TypedRow[]): { rows: TypedRow[]; rejected: number } {
  const kept: TypedRow[] = [];
  let rejected = 0;
  for (const r of rows) {
    if (r.title.trim() && hasAnyMetric(r.metrics)) kept.push(r);
    else rejected += 1;
  }
  return { rows: kept, rejected };
}

/**
 * 页面收到的响应 → JSON 对象的统一前置守卫:HTTP 状态 / HTML 伪装 / JSON 解析 三道闸。
 * 2xx 都算正常(视频号后台的列表接口恒回 201)。过不去就是 `schema_changed` 或对应状态码,绝不进入字段映射。
 */
export function envelopeOf(
  res: CapturedResponse,
  label: string,
  protectKeys?: string[],
): { ok: true; json: Record<string, unknown> } | { ok: false; result: PullResult } {
  if (res.status < 200 || res.status >= 300) return { ok: false, result: httpFailure(res.status) };
  if (looksLikeHtml("", res.body)) return { ok: false, result: failure("schema_changed", `html_response:${label}`) };
  const text = protectKeys?.length ? protectLongNumbers(res.body, protectKeys) : res.body;
  const parsed = parseJsonSafe(text);
  if (!parsed.ok) return { ok: false, result: failure("schema_changed", `json_parse:${label}`) };
  if (!isRecord(parsed.value)) return { ok: false, result: schemaChanged(`${label}.envelope`) };
  return { ok: true, json: parsed.value };
}

/** Unix 秒 → ISO;0/负数/非数当「拿不到」,返回 null(不猜时间) */
export function isoFromSeconds(raw: unknown): string | null {
  const n = toCount(raw);
  if (n === undefined || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/** 毫秒时间戳 → ISO(小红书 post_time / 部分接口用毫秒) */
export function isoFromMillis(raw: unknown): string | null {
  const n = toCount(raw);
  if (n === undefined || n <= 0) return null;
  return new Date(n).toISOString();
}

export function firstString(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}
