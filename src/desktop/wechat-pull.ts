/**
 * flywheel:wechat_pull —— 公众号后台一键拉数(GUI 数据回流页触发,有人值守低频只读)。
 * 旁听拉取(ego lite 登录态,只看不发)→ statsToImportRows → 既有 CSV 导入管线(校验/标题匹配/幂等全继承)。
 * 每种失败都给可见的人话:登录失效给扫码指引、风控说清今天别再碰、没等到数据说清页面没返回——都不静默。
 */
import { pullWechatMpStats, statsToImportRows } from "../adapters/browser/wechat-mp-stats.js";
import type { PullResult } from "../adapters/browser/pull-types.js";
import { rowsToCsvText } from "../modules/flywheel/csv-text.js";
import { importPerformanceCsv } from "../modules/flywheel/csv-import.js";
import { localDateStamp } from "../modules/analytics/quality-baseline.js";
import { emitEngineEvent } from "./event-hub.js";

type Payload = Record<string, unknown>;
type HandlerResult = Record<string, unknown>;

const LOGIN_HINT = "公众号登录态失效——在 ego lite 里登录公众号后台(mp.weixin.qq.com,扫码),登录后回来再点一次";
const BROWSER_HINT = "浏览器未连接（ego lite）——打开 ego lite 应用并保持运行，再点一次";

/** 失败状态 → 给人看的一句话 */
export function wechatFailureText(r: PullResult): string {
  switch (r.status) {
    case "needs_login":
      return LOGIN_HINT;
    case "risk_control":
      return "公众号后台出现验证/风控提示,已停手关页——今天别再抓,明天再试";
    case "browser_unreachable":
      return BROWSER_HINT;
    case "schema_changed":
      return `公众号后台页面数据结构变了(${r.errorCode ?? "schema"}),本次零写入`;
    case "timeout":
      return "公众号抓取超时,已关页,稍后重试";
    default:
      if (r.errorCode === "entry_ui_missing") return "公众号后台菜单里没找到「发表记录」,本次零写入";
      return r.errorCode === "no_data_response" ? "公众号发表记录页没返回文章数据,本次零写入" : `公众号拉数失败:${r.errorCode ?? "unknown"}`;
  }
}

/** 走既有 CSV 导入(与旧拉数口径一致)。source: "auto" —— 浏览器登录态自动拉取，不是人手导出的 CSV */
function importRows(rows: PullResult["rows"], dataDir?: string) {
  return importPerformanceCsv("wechat_mp", rowsToCsvText(statsToImportRows(rows)), localDateStamp(), dataDir, "auto");
}

/** ok 但不完整时的说明(只拿到第 1 页 / 中途出错) */
function partialText(r: PullResult): string {
  if (!r.errorCode) return "";
  if (r.errorCode === "only_first_page") return "(只拿到第 1 页)";
  if (r.errorCode.startsWith("incomplete:")) return `(没抓全:${r.errorCode},已拿到的页照常入账)`;
  return `(中途出错:${r.errorCode},已拿到的页照常入账)`;
}

export async function wechatPullHandler(
  payload: Payload,
  _ctx?: unknown,
  deps?: { pull?: () => Promise<PullResult> },
): Promise<HandlerResult> {
  const dataDir = (payload._dataDir as string) || undefined;
  const pull = deps?.pull ?? (() => pullWechatMpStats());
  const emit = (kind: "work" | "run_done" | "run_failed", label: string) =>
    void emitEngineEvent({ role: "analyst", kind, label }, dataDir).catch(() => {});

  emit("work", "分析师去公众号后台看近 30 天的文章数据…");
  const res = await pull();
  // 中途碰到登录/风控：已拿到的行照常入账，但结论仍是失败提示（要人去登录 / 今天别再碰）
  if ((res.status === "needs_login" || res.status === "risk_control") && res.rows.length > 0) {
    const kept = await importRows(res.rows, dataDir).catch(() => null);
    const text = `${wechatFailureText(res)}(此前已拿到的 ${res.rows.length} 条${kept ? `入账 ${kept.imported} 条` : "入账失败"})`;
    emit("run_failed", text.slice(0, 80));
    return { ok: false, error: text, status: res.status, ...(res.status === "needs_login" ? { needLogin: true } : {}) };
  }
  if (res.status !== "ok") {
    const text = wechatFailureText(res);
    emit("run_failed", text.slice(0, 80));
    return { ok: false, error: text, status: res.status, ...(res.status === "needs_login" ? { needLogin: true } : {}) };
  }
  const note = partialText(res);
  if (res.rows.length === 0) {
    emit("run_done", `公众号近 30 天没有已发表文章数据${note}`);
    return { ok: true, note, data: { total: 0, imported: 0, replaced: 0, matched: 0, historical: 0, needsReview: [], rejected: [] } };
  }
  try {
    const report = await importRows(res.rows, dataDir);
    emit("run_done", `公众号回填入账 ${report.imported} 条(匹配稿件 ${report.matched} · 历史 ${report.historical})${note}`);
    return { ok: true, note, data: report };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit("run_failed", `公众号回填导入失败:${msg.slice(0, 80)}`);
    return { ok: false, error: msg };
  }
}
