/**
 * 自动回流状态区与假设区的视图模型（回流 spec §4.4 / §5.3）——纯函数 + 类型，
 * 与后端 `flywheel:pull_status` / `flywheel:hypotheses_list` 的返回形状一一对应。
 * 单独成文件是因为 lib.ts 已经很厚；这里的映射有确定性用例锁着（pull-lib.test.ts）。
 */

export interface PullPlatformStatus {
  platform: string;
  label: string;
  consoleUrl: string;
  inFlight: boolean;
  enabled: boolean;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  nextEligibleAt: string | null;
  failureCount: number;
  lastStatus: string;
  lastErrorCode?: string;
  lastRowCount?: number;
  lastBatchId?: string;
}

export type PullTone = "ok" | "warn" | "bad" | "idle";

/** 状态徽标：一格一个词，别的解释放行内那句话里（spec §4.4 的七种态 + 未启用/从未运行） */
export function pullBadge(row: PullPlatformStatus): { text: string; tone: PullTone } {
  if (!row.enabled) return { text: "未启用", tone: "idle" };
  switch (row.lastStatus) {
    case "never":
      return { text: "从未运行", tone: "idle" };
    case "ok":
      return { text: "已连接", tone: "ok" };
    case "needs_login":
      return { text: "需扫码", tone: "warn" };
    case "risk_control":
      return { text: "风控暂停", tone: "warn" };
    case "schema_changed":
      return { text: "接口变更", tone: "bad" };
    case "browser_unreachable":
      return { text: "浏览器未连接", tone: "bad" };
    default:
      return { text: "抓取失败", tone: "bad" };
  }
}

/** 时间只给「几月几号几点」——秒级精度对人没用，反而看着累 */
export function formatPullTime(iso: string | null | undefined): string {
  if (!iso) return "从未成功";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 行内那句话：这一行现在到底在等什么。null = 没什么要说的 */
export function pullHint(row: PullPlatformStatus): string | null {
  if (!row.enabled) return "打开开关后，AutoCrew 会定期从创作者后台把数据接回来。";
  // 刚开开关最容易以为「没反应」：说清最多等多久，想立刻看就有按钮
  if (row.lastStatus === "never") return "已开启——最多 30 分钟内自动抓一次；想立刻看结果就点「立即抓取」。";
  switch (row.lastStatus) {
    case "needs_login":
      return "登录态过期——去后台扫码，之后数据继续自己回来。";
    case "risk_control":
      return "平台触发了风控，今天不再自动抓取，明早再试。";
    case "schema_changed":
      return `后台接口变了（${row.lastErrorCode ?? "schema"}），本次零写入，等适配。`;
    case "timeout":
    case "error":
      return `上次没抓成${row.lastErrorCode ? `（${row.lastErrorCode}）` : ""}，已连续失败 ${row.failureCount} 次，会自动重试。`;
    default:
      return null;
  }
}

/** chrome-cdp 连不上是环境问题：三行合并成一条提示，不逐平台重复报错（spec §4.4） */
export function browserUnreachable(rows: PullPlatformStatus[]): boolean {
  return rows.some((r) => r.enabled && r.lastStatus === "browser_unreachable");
}

export interface PullAttemptView {
  platform: string;
  status: string;
  rowCount: number;
  imported?: number;
  errorCode?: string;
  /** 抓到分页上限：只说「还有更多」，不谎报精确丢弃数 */
  hasMore?: boolean;
  persistError?: string;
}

/** 「立即抓取」按完的那条 toast：每种结局都有一句人话，绝不只说「失败」 */
export function attemptMessage(label: string, attempt: PullAttemptView): string {
  const persistTail = attempt.persistError ? "（状态没写住，下轮会重抓，重复导入无害）" : "";
  switch (attempt.status) {
    case "in_flight":
      return `${label}正在抓——这一轮跑完会自己刷新`;
    case "ok":
      return `${label}：抓回 ${attempt.rowCount} 条，入账 ${attempt.imported ?? 0} 条${
        attempt.hasMore ? "（作品数到上限，还有更多没抓完）" : ""
      }${persistTail}`;
    case "needs_login":
      return `${label}登录态过期——去创作者后台扫码后再抓一次`;
    case "risk_control":
      return `${label}触发风控，今天先停，明早自动再试`;
    case "browser_unreachable":
      return "浏览器未连接：先启动常驻 Chrome（chrome-cdp）再试";
    case "schema_changed":
      return `${label}后台接口变了（${attempt.errorCode ?? "schema"}），这次一行都没写入`;
    case "timeout":
      return `${label}抓取超时，稍后再试`;
    default:
      return `${label}抓取失败：${attempt.errorCode ?? "unknown"}`;
  }
}

// ── 假设台账 ─────────────────────────────────────────────────────────────────

export interface HypothesisEvidenceView {
  metricFocus: string;
  ageDays: number;
  platforms: string[];
  sampleSize: number;
  baselineSampleSize: number;
  testValue: number | null;
  baselineValue: number | null;
  relDiff: number | null;
  reason: string;
  note: string;
}

export interface HypothesisView {
  id: string;
  statement: string;
  metricFocus: string;
  direction: "up" | "down";
  scope: { platform?: string; tag?: string };
  contentIds: string[];
  proposedAt: string;
  status: string;
  verdictAt?: string;
  evidence?: HypothesisEvidenceView;
  nextAction?: string;
}

export const METRIC_FOCUS_LABELS: Record<string, string> = {
  views: "播放/阅读",
  impressions: "曝光",
  completionRate: "完播率",
  completion5s: "5s 完播",
  likes: "点赞",
  comments: "评论",
  shares: "分享",
  favorites: "收藏",
  follows: "涨粉",
  engagementRate: "互动率",
};

export const HYPOTHESIS_STATUS_LABELS: Record<string, string> = {
  open: "待验证",
  supported: "支持",
  refuted: "推翻",
  inconclusive: "证据不足",
};

const round2 = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** 证据摘要：样本数 / 对照值 / 差值——全是代码算出来的数，模型不参与 */
export function evidenceSummary(evidence?: HypothesisEvidenceView): string | null {
  if (!evidence) return null;
  const parts = [`样本 ${evidence.sampleSize} 篇`, `对照 ${evidence.baselineSampleSize} 篇`];
  if (evidence.testValue !== null) parts.push(`试验 ${round2(evidence.testValue)}`);
  if (evidence.baselineValue !== null) parts.push(`基线 ${round2(evidence.baselineValue)}`);
  if (evidence.relDiff !== null) parts.push(`差 ${(evidence.relDiff * 100).toFixed(0)}%`);
  parts.push(`D+${evidence.ageDays} 定龄`);
  return parts.join(" · ");
}
