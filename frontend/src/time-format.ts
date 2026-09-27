/**
 * 看得懂的时间与时长：一律按用户本地时区（服务端给的是 UTC ISO，直接截字符串会慢 8 小时）。
 * 今天/昨天/几月几日 + 近期的相对说法；时长用「8 分 43 秒」，不用有歧义的「8:43」。
 */
const pad = (n: number) => String(n).padStart(2, "0");
const parse = (iso?: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? new Date(t) : null; };
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** 「9月26日」；跨年带年份 */
export function dateLabel(iso?: string | null, now: number = Date.now()): string {
  const d = parse(iso);
  if (!d) return "—";
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

/** 「今天 17:50」「昨天 09:05」「9月26日 16:46」 */
export function clockLabel(iso?: string | null, now: number = Date.now()): string {
  const d = parse(iso);
  if (!d) return "—";
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = Math.round((dayStart(new Date(now)) - dayStart(d)) / 86_400_000);
  if (days === 0) return `今天 ${hm}`;
  if (days === 1) return `昨天 ${hm}`;
  return `${dateLabel(iso, now)} ${hm}`;
}

/** 近期用相对说法（刚刚 / 3 分钟前 / 2 小时前），再早的落回 clockLabel；未来时间（时钟偏差）当刚刚 */
export function relativeLabel(iso?: string | null, now: number = Date.now()): string {
  const d = parse(iso);
  if (!d) return "—";
  const min = Math.floor((now - d.getTime()) / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} 小时前`;
  return clockLabel(iso, now);
}

/** 「20 秒」「8 分 43 秒」「1 小时 2 分」；读不出就明说 */
export function durationText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "时长读不出";
  const total = Math.round(ms / 1000), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  if (h) return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  if (m) return s ? `${m} 分 ${s} 秒` : `${m} 分`;
  return `${s} 秒`;
}
