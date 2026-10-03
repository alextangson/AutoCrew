/**
 * flywheel:wechat_pull —— 公众号后台一键拉数(GUI 数据回流页触发,有人值守低频只读)。
 * 拉取(ego lite 登录态)→ statsToImportRows → 既有导入管线(校验/标题匹配/幂等全继承)。
 * 登录态失效给明确扫码指引;瞬时超时说清可重试——都不静默(channel-poller 卡死教训)。
 */
import { pullWechatMpStats, statsToImportRows } from "../adapters/browser/wechat-mp-stats.js";
import { rowsToCsvText } from "../bridge/ingest.js";
import { importPerformanceCsv } from "../modules/flywheel/csv-import.js";
import { localDateStamp } from "../modules/analytics/quality-baseline.js";
import { emitEngineEvent } from "./event-hub.js";
import { EgoChannelError } from "../adapters/browser/ego-session.js";

type Payload = Record<string, unknown>;
type HandlerResult = Record<string, unknown>;

const LOGIN_HINT = "公众号登录态失效——在 ego lite 里登录公众号后台(mp.weixin.qq.com,扫码),登录后回来再点一次";
const BROWSER_HINT = "浏览器未连接（ego lite）——打开 ego lite 应用并保持运行，再点一次";

export async function wechatPullHandler(
  payload: Payload,
  _ctx?: unknown,
  deps?: { pull?: typeof pullWechatMpStats },
): Promise<HandlerResult> {
  const dataDir = (payload._dataDir as string) || undefined;
  const pull = deps?.pull ?? pullWechatMpStats;
  const emit = (kind: "work" | "run_done" | "run_failed", label: string) =>
    void emitEngineEvent({ role: "analyst", kind, label }, dataDir).catch(() => {});

  emit("work", "分析师去公众号后台拉运营数据…");
  let res: Awaited<ReturnType<typeof pullWechatMpStats>>;
  try {
    res = await pull();
  } catch (err) {
    if (err instanceof EgoChannelError && err.status === "browser_unreachable") {
      emit("run_failed", "公众号拉数失败:浏览器未连接（ego lite）");
      return { ok: false, error: BROWSER_HINT };
    }
    const msg = err instanceof Error ? err.message : String(err);
    emit("run_failed", `公众号拉数失败:${msg.slice(0, 80)}`);
    return { ok: false, error: `公众号拉数异常(ego lite 通道):${msg}` };
  }

  if (res.status === "out") {
    emit("run_failed", "公众号登录态失效,需扫码续期");
    return { ok: false, needLogin: true, error: LOGIN_HINT };
  }
  if (res.status === "timeout") {
    emit("run_failed", "后台页导航超时(ego lite 忙,瞬时)");
    return { ok: false, error: "后台页导航没起来(ego lite 忙?已自动重试 3 次)——非登录问题,稍后重试即可" };
  }
  if (res.rows.length === 0) {
    emit("run_done", "公众号后台没有已群发文章数据");
    return { ok: true, data: { total: 0, imported: 0, replaced: 0, matched: 0, historical: 0, needsReview: [], rejected: [] } };
  }

  const csv = rowsToCsvText(statsToImportRows(res.rows));
  try {
    // source: "auto" —— 这条是浏览器登录态自动拉取，不是人手导出的 CSV（口径要分得清）
    const report = await importPerformanceCsv("wechat_mp", csv, localDateStamp(), dataDir, "auto");
    emit("run_done", `公众号回填入账 ${report.imported} 条(匹配稿件 ${report.matched} · 历史 ${report.historical})`);
    return { ok: true, data: report };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit("run_failed", `公众号回填导入失败:${msg.slice(0, 80)}`);
    return { ok: false, error: msg };
  }
}
