/**
 * 某平台的数据回流状态（发布台 spec 吸收 10）：按回流状态文件分类，不凭「24 小时没数据」猜。
 * 不支持（B站）/ 未开启 / 登录失效 / 抓取失败 / 正常。「抓到了但没对上这件作品」由调用方按作品匹配结果再判。
 */
import { isPullPlatform, PULL_PLATFORM_LABELS, type MetricsPullState } from "./pull-state.js";
import { platformLabel } from "../publish/review-gate/platforms.js";

export type BackflowKind = "unsupported" | "off" | "login" | "failed" | "ok" | "unreadable";
export interface Backflow { kind: BackflowKind; text: string; auto: boolean }

const FAIL_TEXT: Record<string, string> = {
  risk_control: "被平台风控拦了", browser_unreachable: "连不上 ego lite 浏览器", schema_changed: "平台页面改版了，抓取器要更新", timeout: "抓取超时",
};

/** state = null：回流状态文件读不出（IO 故障），如实说读不到 */
export function backflowOf(platform: string, state: MetricsPullState | null, readError?: string): Backflow {
  const name = platformLabel(platform);
  if (!isPullPlatform(platform)) return { kind: "unsupported", auto: false, text: `${name}不自动回流：在「手动工具」里填数据` };
  if (!state) return { kind: "unreadable", auto: false, text: `回流状态读不出来${readError ? `：${readError}` : ""}` };
  const s = state.platforms[platform];
  const label = PULL_PLATFORM_LABELS[platform] ?? name;
  if (!s.enabled) return { kind: "off", auto: false, text: `${label}数据回流没开：去数据页打开后自动接上` };
  if (s.lastStatus === "needs_login") return { kind: "login", auto: true, text: `${label}登录过期，去 ego lite 登录后自动接上` };
  if (s.lastStatus !== "ok" && s.lastStatus !== "never") {
    const why = FAIL_TEXT[s.lastStatus] ?? `抓取失败（${s.lastErrorCode ?? s.lastStatus}）`;
    return { kind: "failed", auto: true, text: `${label}数据回流${why.startsWith("抓取") ? why : `失败：${why}`}` };
  }
  return { kind: "ok", auto: true, text: s.lastSuccessAt ? `${label}回流正常` : `${label}回流已开，还没抓过` };
}
