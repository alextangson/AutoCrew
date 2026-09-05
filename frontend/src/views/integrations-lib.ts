/**
 * 「接入更多」每张卡的状态口径（P2 spec §5.3）——固定三态：
 * 未配置 / 已配置 / 上次失败：原因 + 时间。
 *
 * 一条纪律：**没有失败记录 ≠ 一切正常**，但也不许编。后端通道里没有 lastError 字段的
 * 接入（搜索、情报源、公众号、生图），这里只说「未配置 / 已配置」，绝不拿一个
 * 不存在的字段假装自己知道上次跑没跑成。要补的字段列在 P2b 报告里。
 */
import { relativeTime } from "./engine-lib";

export type IntegrationTone = "off" | "on" | "bad";

export interface IntegrationStatus {
  tone: IntegrationTone;
  text: string;
}

export interface IntegrationInput {
  configured: boolean;
  /** 上次失败原因（通道里有才传；没有就别传，不许拿空串冒充「没失败」） */
  lastError?: string | null;
  /** 上次失败时间；没有就只报原因不报时间 */
  lastErrorAt?: string | null;
  /** 已配置时的补充说明，如「已配置 博查」 */
  okLabel?: string;
}

export function integrationStatus(input: IntegrationInput, now = Date.now()): IntegrationStatus {
  const err = input.lastError?.trim();
  if (err) {
    const when = input.lastErrorAt ? `（${relativeTime(input.lastErrorAt, now)}）` : "";
    return { tone: "bad", text: `上次失败：${err}${when}` };
  }
  if (input.configured) return { tone: "on", text: input.okLabel?.trim() || "已配置" };
  return { tone: "off", text: "未配置" };
}
