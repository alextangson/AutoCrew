/**
 * 纯函数：网址校验、字幕轨挑选、VTT 去重、重看强度高低点、评论裁剪、博主目录名。
 */

const ID = /^[A-Za-z0-9_-]{11}$/;

/** 只收明确的 YouTube 单条视频网址；返回视频 id 或 null（频道、播放列表、Shorts、直播页都不收） */
export function parseVideoUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "youtu.be") {
    const id = u.pathname.slice(1);
    return ID.test(id) ? id : null;
  }
  if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host) || u.pathname !== "/watch") return null;
  const id = u.searchParams.get("v") ?? "";
  return ID.test(id) ? id : null;
}

export const canonicalUrl = (id: string): string => `https://www.youtube.com/watch?v=${id}`;

export function slugify(name: string): string {
  return name.replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export interface SubtitleChoice { source: "manual" | "auto"; lang: string }

const MANUAL_EN = /^en(-[A-Za-z]{2,4})?$/;

/** 先人工英文字幕，再自动英文字幕；不取翻译轨（原视频不是英语时自动 en 就是翻译出来的） */
export function pickSubtitle(info: Record<string, unknown>): SubtitleChoice | null {
  const manual = Object.keys((info.subtitles as Record<string, unknown>) ?? {});
  const m = manual.find((k) => k === "en") ?? manual.find((k) => MANUAL_EN.test(k));
  if (m) return { source: "manual", lang: m };
  const auto = Object.keys((info.automatic_captions as Record<string, unknown>) ?? {});
  if (auto.includes("en-orig")) return { source: "auto", lang: "en-orig" };
  const language = typeof info.language === "string" ? info.language : "";
  // 没有 en-orig 时，只有元数据明确说原视频是英语才收自动 en；语言缺失可能是翻译轨
  if (auto.includes("en") && language.startsWith("en")) return { source: "auto", lang: "en" };
  return null;
}

export interface Cue { start: number; text: string }

function toSeconds(ts: string): number {
  const parts = ts.split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const stripTags = (line: string): string => line.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

/** VTT → 去重后的带时间文本行。YouTube 自动字幕是滚动的：每个 cue 重复上一行，只留第一次出现的那行 */
export function parseVtt(vtt: string): Cue[] {
  const out: Cue[] = [];
  const recent: string[] = [];
  for (const block of vtt.replace(/\r/g, "").split(/\n\n+/)) {
    const lines = block.split("\n");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const start = toSeconds(lines[ti].split("-->")[0].trim());
    for (const line of lines.slice(ti + 1).map(stripTags).filter(Boolean)) {
      if (recent.includes(line)) continue;
      out.push({ start, text: line });
      recent.push(line);
      if (recent.length > 3) recent.shift();
    }
  }
  return out;
}

export function fmtTime(sec: number): string {
  const s = Math.floor(sec);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return hh ? `${hh}:${two(mm)}:${two(ss)}` : `${two(mm)}:${two(ss)}`;
}

/** transcriptText 的逆：断点续抓时从缓存的 .txt 读回字幕 */
export function parseTranscript(txt: string): Cue[] {
  return txt.split("\n").map((l) => /^\[(\d+(?::\d+){1,2})\] (.*)$/.exec(l)).filter((m): m is RegExpExecArray => m !== null).map((m) => ({ start: toSeconds(m[1]), text: m[2] }));
}

export const transcriptText = (cues: Cue[]): string => cues.map((c) => `[${fmtTime(c.start)}] ${c.text}`).join("\n") + (cues.length ? "\n" : "");

export interface HeatPoint { start: number; end: number; value: number }

export function normalizeHeatmap(raw: unknown): HeatPoint[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const pts = raw
    .map((p) => ({ start: Number(p?.start_time), end: Number(p?.end_time), value: Number(p?.value) }))
    .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && Number.isFinite(p.value));
  return pts.length ? pts : null;
}

export interface Peak { time: string; seconds: number; value: number; excerpt: string | null }

const WINDOW = 20;
const MIN_GAP = 30;

function pick(sorted: HeatPoint[], n: number): HeatPoint[] {
  const chosen: HeatPoint[] = [];
  for (const p of sorted) {
    if (chosen.length >= n) break;
    if (chosen.every((c) => Math.abs(c.start - p.start) >= MIN_GAP)) chosen.push(p);
  }
  return chosen;
}

function toPeak(p: HeatPoint, cues: Cue[] | null): Peak {
  const t = (p.start + p.end) / 2;
  const near = cues?.filter((c) => c.start >= t - WINDOW && c.start <= t + WINDOW) ?? null;
  return { time: fmtTime(t), seconds: Math.round(t), value: Number(p.value.toFixed(4)), excerpt: near ? near.map((c) => c.text).join(" ") : null };
}

/** 重看强度最高 / 最低的点，各附前后 20 秒字幕。只描述「这里被反复回看」，不推断留存 */
export function replayPeaks(heat: HeatPoint[], cues: Cue[] | null, n = 5): { top: Peak[]; bottom: Peak[] } {
  const desc = [...heat].sort((a, b) => b.value - a.value);
  return { top: pick(desc, n).map((p) => toPeak(p, cues)), bottom: pick([...desc].reverse(), n).map((p) => toPeak(p, cues)) };
}

export interface Comment { text: string; likes: number | null }

/** 只留顶层评论的正文和点赞数（不留用户名、头像、楼中楼），按点赞排，最多 n 条 */
export function trimComments(raw: unknown, n: number): Comment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c.text === "string" && (c.parent === undefined || c.parent === "root"))
    .map((c) => ({ text: String(c.text), likes: typeof c.like_count === "number" ? c.like_count : null }))
    .sort((a, b) => (b.likes ?? -1) - (a.likes ?? -1))
    .slice(0, n);
}

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
