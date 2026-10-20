/**
 * 活动窗口时间解析：海报抄来的写法五花八门。
 * - 只有日期（2026-11-15 / 2026/11/15 / 2026.11.15）→ 日历日，不补 23:59
 * - 带时区偏移或 Z 的时刻 → 绝对时刻
 * - 不带偏移的时刻（2026-11-15 23:59）→ 按 window.timezone 理解
 * - 别的 → null（调用方按保守处理）
 */
export type When = { kind: "date"; date: string } | { kind: "instant"; ms: number };

const DATE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
const LOCAL_TIME = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
export const HAS_OFFSET = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;
const pad = (n: string) => n.padStart(2, "0");

/** 某时刻在 timeZone 下的日历日期 YYYY-MM-DD；时区名无效时按 Asia/Shanghai */
export function dateIn(ms: number, timeZone: string): string {
  const fmt = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  try { return fmt(timeZone); } catch { return fmt("Asia/Shanghai"); }
}

/** timeZone 在 utcMs 这一刻相对 UTC 的偏移（毫秒） */
function tzOffset(utcMs: number, timeZone: string): number {
  const parts = (tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs));
  let p; try { p = parts(timeZone); } catch { p = parts("Asia/Shanghai"); }
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - utcMs;
}

export function parseWhen(raw: string, timeZone: string): When | null {
  const s = raw.trim();
  const d = DATE.exec(s);
  if (d) return { kind: "date", date: `${d[1]}-${pad(d[2])}-${pad(d[3])}` };
  const l = LOCAL_TIME.exec(s);
  if (l) {
    const wall = Date.UTC(+l[1], +l[2] - 1, +l[3], +l[4], +l[5], +(l[6] ?? 0));
    return { kind: "instant", ms: wall - tzOffset(wall - tzOffset(wall, timeZone), timeZone) };
  }
  if (HAS_OFFSET.test(s)) { const ms = Date.parse(s); if (!Number.isNaN(ms)) return { kind: "instant", ms }; }
  return null;
}
