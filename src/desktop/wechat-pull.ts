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
import { pullPlatformNow } from "./metrics-pull-cycle.js";
import { pullAccountStats } from "../adapters/browser/account-stats.js";
import type { ImportReport } from "../modules/flywheel/row-import.js";

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

/**
 * 手动按钮走和定时回流同一个入口（pullPlatformNow）：吃同一把单飞锁、同一道勾选闸；
 * 入库仍走 CSV 导入管线（与旧按钮口径一致），报告形状不变。
 */
export async function wechatPullHandler(
  payload: Payload,
  _ctx?: unknown,
  deps?: { pull?: () => Promise<PullResult> },
): Promise<HandlerResult> {
  const dataDir = (payload._dataDir as string) || undefined;
  let report: ImportReport | null = null;
  let raw: PullResult | null = null;
  const fetcher = deps?.pull ?? (() => pullWechatMpStats());
  const attempt = await pullPlatformNow("wechat_mp", {
    dataDir,
    trigger: "manual",
    registry: { wechat_mp: async () => (raw = await fetcher()) },
    importRows: async (_p, rows) => (report = await importRows(rows, dataDir)),
    // 注入了 registry 时共用入口不会自己去开账号首页：生产路径显式给真账号抓取器，测试给空的
    accountRegistry: deps?.pull ? {} : { wechat_mp: () => pullAccountStats("wechat_mp") },
  });
  if (attempt.status === "in_flight") return { ok: false, error: "公众号正在抓（定时回流或上一次点击），这一轮跑完会自己刷新" };
  if (attempt.status === "not_picked") return { ok: false, error: "公众号没勾在运营平台里，不抓——要抓先去设置勾上公众号" };
  const res: PullResult = raw ?? { status: attempt.status, rows: [], ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}) };
  const needLogin = attempt.status === "needs_login" ? { needLogin: true } : {};
  if (attempt.status === "needs_login" || attempt.status === "risk_control") {
    const kept = res.rows.length > 0 ? `(此前已拿到的 ${res.rows.length} 条${attempt.importError ? "入账失败" : `入账 ${attempt.imported ?? 0} 条`})` : "";
    return { ok: false, error: `${wechatFailureText(res)}${kept}`, status: attempt.status, ...needLogin };
  }
  if (attempt.status !== "ok") {
    const text = attempt.errorCode === "import_failed" || attempt.errorCode?.startsWith("library_") ? `公众号回填导入失败:${attempt.errorCode}` : wechatFailureText(res);
    return { ok: false, error: text, status: attempt.status };
  }
  const note = partialText(res);
  const empty: ImportReport = { total: 0, imported: 0, replaced: 0, matched: 0, historical: 0, needsReview: [], rejected: [] };
  return { ok: true, note, data: report ?? empty };
}
