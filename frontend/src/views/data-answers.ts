/**
 * 数据页四张问答卡的纯计算（数据页规格 §H.47–52）：结论句全由数字按模板生成，不调模型、不编原因。
 * 口径：「平时」= 该平台全部作品播放中位数（样本 ≥3 才有）；「×」= 一条视频在各平台 播放/平时 的中位数。
 */
import { platformLabel } from "../lib";
import { MIN_SAMPLES, boldThresholds, latest, median, monthOf, viewsByPlatform, type DataRow, type Work } from "./data-lib";

/** 一段结论：hot = 用强调色（变差的部分） */
export interface Part { text: string; hot?: boolean }
export const UP = 1.05, DOWN = 0.9, SPECIAL = 1.5;
const DAY_MS = 86_400_000;
const CN = ["零", "一", "两", "三", "四", "五", "六", "七", "八", "九", "十"];
export const cnNum = (n: number): string => CN[n] ?? String(n);
const ORDER = ["douyin", "wechat_video", "xiaohongshu", "bilibili"];
const rank = (p: string): number => (ORDER.includes(p) ? ORDER.indexOf(p) : ORDER.length);
/** 平台名按固定顺序（抖音、视频号、小红书、B站）列 */
const names = (ps: string[]): string => [...ps].sort((a, b) => rank(a) - rank(b)).map(platformLabel).join("、");
/** 结论句里的标题太长就截短（完整标题在证据里） */
export const shortTitle = (t: string, max = 14): string => ([...t].length > max ? `${[...t].slice(0, max).join("")}…` : t);

/** 平时：各平台全部作品播放中位数（与表格加粗同一把尺子） */
export const baselines = (allRows: DataRow[]): Map<string, number> => boldThresholds(allRows);

const viewsOf = (w: Work): number | null => { const v = latest(w).metrics.views; return typeof v === "number" ? v : null; };
const workOn = (row: DataRow, platform: string): Work | undefined => row.works.find((w) => w.platform === platform);

/** 一行在各平台的 播放/平时（没数据或平台没有「平时」的不算） */
export function ratios(row: DataRow, base: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of row.works) {
    const v = viewsOf(w), b = base.get(w.platform);
    if (out.has(w.platform) || v === null || !b) continue;
    out.set(w.platform, v / b);
  }
  return out;
}

/** ×：各平台比值的中位数 */
export function multiplier(row: DataRow, base: Map<string, number>): number | null {
  return median([...ratios(row, base).values()]);
}

/** ×：≥1 保留一位小数；<1 保留两位，免得 0.87 四舍五入成 0.9 看着像「差不多」 */
export const fmtX = (x: number): string => `${x < 1 ? x.toFixed(2) : x.toFixed(1)}×`;

/** §49：比值 → 人话。0.9–1.05 = 和平时差不多 */
export function ratioText(r: number): { text: string; hot: boolean } {
  if (r < DOWN) return { text: `平时的 ${Math.round(r * 100)}%`, hot: true };
  if (r > UP) return { text: `平时的 ${r.toFixed(1)} 倍`, hot: false };
  return { text: "和平时差不多", hot: false };
}

// ── 卡 1：刚发的那条 ───────────────────────────────────────────────────────

/** 最近一条已有数据（任一平台有播放数）的视频 */
export function latestVideo(rows: DataRow[]): DataRow | null {
  const withData = rows.filter((r) => r.day && r.works.some((w) => viewsOf(w) !== null));
  return [...withData].sort((a, b) => b.day!.localeCompare(a.day!) || a.id.localeCompare(b.id))[0] ?? null;
}

export type PlatformLine =
  | { platform: string; kind: "data"; views: number; ratio: number | null; baseline: number | null }
  | { platform: string; kind: "pending" }; // 发布不满 24 小时 / 还没数据：不显示 0

/** 这条视频每个平台一行：发了的平台都列，数据没回来的写「数据还没回来」 */
export function platformLines(row: DataRow, columns: string[], base: Map<string, number>, now: number): PlatformLine[] {
  const platforms = columns.filter((p) => workOn(row, p) || row.publishedOn.includes(p));
  return platforms.map((platform) => {
    const w = workOn(row, platform);
    const v = w ? viewsOf(w) : null;
    const fresh = w?.publishedAt ? now - Date.parse(w.publishedAt) < DAY_MS : false;
    if (!w || v === null || fresh) return { platform, kind: "pending" };
    const b = base.get(platform) ?? null;
    return { platform, kind: "data", views: v, baseline: b, ratio: b ? v / b : null };
  });
}

/** 卡 1 结论：「09-24「标题」比平时差：抖音持平，小红书只有平时的 19%」 */
export function latestAnswer(row: DataRow, lines: PlatformLine[]): Part[] {
  const head = `${row.day?.slice(5) ?? ""}「${shortTitle(row.title)}」`;
  const rated = lines.filter((l): l is Extract<PlatformLine, { kind: "data" }> & { ratio: number } => l.kind === "data" && l.ratio !== null);
  if (!rated.length) return [{ text: `${head}数据还没回来` }];
  const m = median(rated.map((l) => l.ratio))!;
  const verdict = m >= UP ? "比平时好" : m < DOWN ? "比平时差" : "和平时差不多";
  const parts: Part[] = [{ text: `${head}${verdict}：` }];
  rated.slice(0, 4).forEach((l, i) => {
    const t = ratioText(l.ratio);
    const text = t.text === "和平时差不多" ? `${platformLabel(l.platform)}持平` : `${platformLabel(l.platform)}是${t.text}`;
    parts.push({ text: (i ? "，" : "") + text, hot: t.hot });
  });
  return parts;
}

/** 数据截至发布后第几天 */
export function daysAfter(row: DataRow): number | null {
  const dates = row.works.map((w) => latest(w).metricDate).sort();
  const last = dates[dates.length - 1];
  if (!row.day || !last) return null;
  return Math.max(0, Math.round((Date.parse(last) - Date.parse(row.day)) / DAY_MS));
}

// ── 卡 2：整体变好变差 ─────────────────────────────────────────────────────

export function prevMonth(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
}

export type MonthLine =
  | { platform: string; kind: "ok"; prev: number; cur: number; pct: number }
  | { platform: string; kind: "thin" }; // 任一月份 <3 条：不出百分比

export function monthCompare(rows: DataRow[], columns: string[], month: string): MonthLine[] {
  const cur = viewsByPlatform(rows.filter((r) => monthOf(r) === month));
  const prev = viewsByPlatform(rows.filter((r) => monthOf(r) === prevMonth(month)));
  return columns.flatMap((platform): MonthLine[] => {
    const a = prev.get(platform) ?? [], b = cur.get(platform) ?? [];
    if (!a.length && !b.length) return [];
    if (a.length < MIN_SAMPLES || b.length < MIN_SAMPLES) return [{ platform, kind: "thin" }];
    const p = median(a)!, c = median(b)!;
    return [{ platform, kind: "ok", prev: p, cur: c, pct: p ? Math.round(((c - p) / p) * 100) : 0 }];
  });
}

const monthNum = (m: string): number => Number(m.slice(5, 7));

/** 卡 2 结论：只概括够样本的平台；±5% 以内算稳住 */
export function trendAnswer(lines: MonthLine[], month: string): Part[] {
  const ok = lines.filter((l): l is Extract<MonthLine, { kind: "ok" }> => l.kind === "ok");
  if (!ok.length) return [{ text: "样本太少，暂不比较" }];
  const down = ok.filter((l) => l.pct < -5).sort((a, b) => a.pct - b.pct);
  const up = ok.filter((l) => l.pct > 5).sort((a, b) => b.pct - a.pct);
  const flat = ok.filter((l) => l.pct >= -5 && l.pct <= 5);
  const head = `${monthNum(month)} 月比 ${monthNum(prevMonth(month))} 月`;
  const top = (l: { platform: string }) => platformLabel(l.platform);
  if (down.length === ok.length && ok.length > 1) return [{ text: `${head}都在降，` }, { text: `${top(down[0])}降得最多（${down[0].pct}%）`, hot: true }];
  if (up.length === ok.length && ok.length > 1) return [{ text: `${head}都在涨，${top(up[0])}涨得最多（+${up[0].pct}%）` }];
  const clauses: Part[] = [];
  if (down.length) clauses.push({ hot: true, text: down.length > 1 ? `${names(down.map((l) => l.platform))}在降，${top(down[0])}最多（${down[0].pct}%）` : `${top(down[0])}降了 ${-down[0].pct}%` });
  if (up.length) clauses.push({ text: up.length > 1 ? `${names(up.map((l) => l.platform))}在涨，${top(up[0])}最多（+${up[0].pct}%）` : `${top(up[0])}涨了 ${up[0].pct}%` });
  if (flat.length) clauses.push({ text: `${names(flat.map((l) => l.platform))}基本稳住` });
  return [{ text: `${head}：` }, ...clauses.map((c, i) => ({ ...c, text: (i ? "，" : "") + c.text }))];
}

export interface Streak { platform: string; from: string; values: number[] }

/** 「某平台连续 N（≥3）条走低」：按发布日期排，最近几条播放一条比一条低 */
export function declineStreak(rows: DataRow[], columns: string[]): Streak | null {
  let best: Streak | null = null;
  for (const platform of columns) {
    const pts = rows.flatMap((r) => { const w = workOn(r, platform); const v = w ? viewsOf(w) : null; return r.day && v !== null ? [{ day: r.day, v }] : []; })
      .sort((a, b) => a.day.localeCompare(b.day));
    let i = pts.length - 1;
    while (i > 0 && pts[i].v < pts[i - 1].v) i -= 1;
    const drops = pts.length - 1 - i;
    if (drops >= 3 && (!best || drops > best.values.length - 1)) best = { platform, from: pts[i].day, values: pts.slice(i).map((p) => p.v) };
  }
  return best;
}

// ── 卡 3：下一条该写什么 ───────────────────────────────────────────────────

export interface Pick { row: DataRow; x: number; note: string }

/** 每条一句确定性说明 */
export function pickNote(r: Map<string, number>, good: boolean): string {
  const vals = [...r.entries()];
  const n = vals.length;
  if (vals.every(([, v]) => v > 1)) return `${n === 2 ? "两" : cnNum(n)}个平台都高于平时`;
  if (vals.every(([, v]) => v < 1)) return `${n === 2 ? "两" : cnNum(n)}个平台都低于平时`;
  if (good) {
    const special = vals.filter(([, v]) => v >= SPECIAL).map(([p]) => p);
    if (special.length) return `${names(special)}特别好（≥1.5×）`;
    const [p, v] = [...vals].sort((a, b) => b[1] - a[1])[0];
    return `${platformLabel(p)}最好（${ratioText(v).text}）`;
  }
  const [p, v] = [...vals].sort((a, b) => a[1] - b[1])[0];
  return `${platformLabel(p)}最差（${ratioText(v).text}）`;
}

/** §51：只看 ≥2 个平台有数据的；好 = ×≥1.05 前 3，差 = ×<0.9 后 2 */
export function bestWorst(rows: DataRow[], base: Map<string, number>): { eligible: number; good: Pick[]; bad: Pick[] } {
  const scored = rows.flatMap((row) => {
    const r = ratios(row, base);
    return r.size >= 2 ? [{ row, r, x: median([...r.values()])! }] : [];
  });
  const good = scored.filter((s) => s.x >= UP).sort((a, b) => b.x - a.x).slice(0, 3);
  const bad = scored.filter((s) => s.x < DOWN).sort((a, b) => a.x - b.x).slice(0, 2);
  const pick = (good_: boolean) => (s: (typeof scored)[number]): Pick => ({ row: s.row, x: s.x, note: pickNote(s.r, good_) });
  return { eligible: scored.length, good: good.map(pick(true)), bad: bad.map(pick(false)) };
}

export function nextAnswer(b: { eligible: number; good: Pick[]; bad: Pick[] }): string {
  if (!b.eligible) return "作品还太少";
  const g = b.good.length, d = b.bad.length;
  if (g && d) return `比平时好的是这${cnNum(g)}条，差的是这${cnNum(d)}条`;
  if (g) return `比平时好的是这${cnNum(g)}条，没有明显比平时差的`;
  if (d) return `没有明显比平时好的，差的是这${cnNum(d)}条`;
  return "都和平时差不多";
}

// ── 卡 4：写法实验 ─────────────────────────────────────────────────────────

export interface HypLike { status: string; evidence?: { relDiff: number | null } | null }
export type HypState = "untested" | "better" | "worse" | "unclear";
export const HYP_STATE_TEXT: Record<HypState, string> = {
  untested: "还没有新稿检验", better: "已检验：变好", worse: "已检验：变差", unclear: "已检验：看不出",
};

/** §52 状态：还没判 = 还没有新稿检验；判过的按实际差值的正负说变好 / 变差，没差值或证据不足 = 看不出 */
export function hypState(h: HypLike): HypState {
  if (h.status === "open") return "untested";
  if (h.status === "inconclusive") return "unclear";
  const d = h.evidence?.relDiff;
  if (typeof d !== "number" || d === 0) return "unclear";
  return d > 0 ? "better" : "worse";
}

export function hypAnswer(hs: HypLike[]): Part[] {
  if (!hs.length) return [{ text: "复盘还没提出要验证的写法" }];
  const count = (s: HypState) => hs.filter((h) => hypState(h) === s).length;
  if (count("untested") === hs.length) return [{ text: `${hs.length} 个写法都还在等新稿检验，` }, { text: "暂时没有结论", hot: true }];
  const bits = ([["better", "变好"], ["worse", "变差"], ["unclear", "看不出"], ["untested", "还没检验"]] as const)
    .filter(([s]) => count(s) > 0).map(([s, t]) => `${count(s)} 个${t}`);
  return [{ text: `${hs.length} 个写法：${bits.join("、")}` }];
}
