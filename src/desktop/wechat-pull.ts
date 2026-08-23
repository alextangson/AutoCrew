/**
 * flywheel:wechat_pull —— 公众号后台一键拉数(GUI 数据回流页触发,有人值守低频只读)。
 * 拉取(chrome-cdp 登录态)→ statsToImportRows → 既有导入管线(校验/标题匹配/幂等全继承)。
 * 登录态失效给明确扫码指引;瞬时超时说清可重试——都不静默(channel-poller 卡死教训)。
 */
import { pullWechatMpStats, statsToImportRows } from "../adapters/browser/wechat-mp-stats.js";
import { rowsToCsvText } from "../bridge/ingest.js";
import { importPerformanceCsv } from "../modules/flywheel/csv-import.js";
import { localDateStamp } from "../modules/analytics/quality-baseline.js";
import { emitEngineEvent } from "./event-hub.js";

type Payload = Record<string, unknown>;
type HandlerResult = Record<string, unknown>;

const LOGIN_HINT =
  "公众号登录态失效——扫码续期:uv run --with websocket-client " +
  "~/.openclaw/workspace-muse-gzh/scripts/pull_wechat_stats.py --login(扫完重点一次)";

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
    const msg = err instanceof Error ? err.message : String(err);
    emit("run_failed", `公众号拉数失败:${msg.slice(0, 80)}`);
    return { ok: false, error: `连不上 chrome-cdp 或拉取异常:${msg}` };
  }

  if (res.status === "out") {
    emit("run_failed", "公众号登录态失效,需扫码续期");
    return { ok: false, needLogin: true, error: LOGIN_HINT };
  }
  if (res.status === "timeout") {
    emit("run_failed", "后台页导航超时(Chrome 忙,瞬时)");
    return { ok: false, error: "后台页导航没起来(Chrome 忙?已自动重试 3 次)——非登录问题,稍后重试即可" };
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
