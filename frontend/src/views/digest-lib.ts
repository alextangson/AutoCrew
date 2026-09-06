/**
 * 「每日选题摘要」那一段的口径（摘要 spec §2.5）——一行话说清现在是什么状态。
 *
 * 一条纪律与 integrations-lib 同源：**没有记录 ≠ 一切正常**。没发过就说「还没发过」，
 * 不拿一个空字段冒充「一切正常」；失败有时间就报时间，没有就只报原因。
 */
import { relativeTime } from "./engine-lib";

/** `inbox:status.digest` 的形状 */
export interface DigestView {
  enabled: boolean;
  hour: number;
  nextAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  attemptsToday: number;
}

export const DIGEST_HOURS = Array.from({ length: 24 }, (_, h) => h);
export const DIGEST_MAX_ATTEMPTS = 3;

export function digestHourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export interface DigestLineInput {
  digest?: DigestView | null;
  /** bot token 配了没——没配这一段整体灰显 */
  configured: boolean;
  now: number;
}

/** 卡上那一行状态。顺序即优先级：没配 > 读不到 > 关了 > 失败 > 发过 > 没发过 */
export function digestStateLine(input: DigestLineInput): string {
  const d = input.digest;
  if (!input.configured) return "先配 bot——上面填好 bot token，这段才会生效";
  if (!d) return "状态读不到（server 可能刚起来）——刷新页面再看";
  if (!d.enabled) return `已关闭——打开后每天 ${digestHourLabel(d.hour)} 发一份到你的 Telegram`;
  if (d.lastError) {
    const when = d.lastErrorAt ? `（${relativeTime(d.lastErrorAt, input.now)}）` : "";
    const tries = d.attemptsToday > 0 ? `　今天已试 ${d.attemptsToday}/${DIGEST_MAX_ATTEMPTS} 次` : "";
    return `上次失败：${d.lastError}${when}${tries}`;
  }
  if (d.lastSentAt) return `上次发送 ${relativeTime(d.lastSentAt, input.now)}　每天 ${digestHourLabel(d.hour)}`;
  return `还没发过——每天 ${digestHourLabel(d.hour)} 到点自动发`;
}

/** 卡右上角的三态徽章文案（与 integrationStatus 同一套 tone） */
export function digestTone(input: DigestLineInput): "off" | "on" | "bad" {
  const d = input.digest;
  if (!input.configured || !d || !d.enabled) return "off";
  return d.lastError ? "bad" : "on";
}
