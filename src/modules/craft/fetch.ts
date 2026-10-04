/**
 * craft:fetch 抓取编排（传播方法规格 §7/§8/§12/§13）：明确视频网址 → 串行逐条取元数据、重看强度、英文字幕、
 * 可选热门评论，写进本机缓存。整次运行共用 3 次退避重试；连续 2 次 429 整体停下，已完成的照样写盘，下次跳过已完成的接着抓。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic, writeTextAtomic } from "../../storage/json-atomic.js";
import {
  canonicalUrl, normalizeHeatmap, num, parseVideoUrl, parseVtt, pickSubtitle, replayPeaks, slugify, transcriptText, trimComments,
  type Comment, type Cue,
} from "./parse.js";
import { YtdlpError, type YtdlpExec } from "./ytdlp.js";

export const CRAFT_ROOT = path.join(os.homedir(), ".cache", "autocrew-yt", "craft");
export const MAX_COMMENTS = 100;
const RETRY_BUDGET = 3;

export interface FetchOptions {
  urls: string[];
  exec: YtdlpExec;
  outDir?: string;
  craftRoot?: string;
  comments?: number;
  sleep?: (ms: number) => Promise<void>;
  pauseMs?: () => number;
  backoffMs?: (attempt: number) => number;
  timeouts?: { info: number; subs: number; comments: number };
  log?: (line: string) => void;
}

export interface IndexEntry {
  id: string; url: string; status: "ok" | "failed" | "not_attempted"; reason?: string; title?: string | null;
  subtitles?: string; heatmap?: boolean; heatmap_reason?: string; comments?: string; resumed?: boolean;
}

export interface FetchSummary {
  ok: boolean; error?: string; outDir?: string; done: number; failed: number; notAttempted: number; stopped: string | null;
}

class StopRun extends Error {}

interface Ctx {
  opts: Required<Pick<FetchOptions, "exec" | "sleep" | "backoffMs" | "log">> & { timeouts: NonNullable<FetchOptions["timeouts"]>; comments: number };
  budget: number;
  consecutive429: number;
  stopped: string | null;
}

const STOP_REASON = "连续 2 次被 YouTube 限流（HTTP 429），整批停下；已完成的已写盘，过一阵重跑同一条命令会跳过已完成的接着抓";

/** 一次 yt-dlp 调用，带整次运行共用的重试预算和连续 429 熔断 */
async function call(ctx: Ctx, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  for (;;) {
    try {
      const r = await ctx.opts.exec(args, timeoutMs);
      ctx.consecutive429 = 0;
      return r;
    } catch (e) {
      if (!(e instanceof YtdlpError)) throw e;
      if (e.kind === "rate_limited" && ++ctx.consecutive429 >= 2) {
        ctx.stopped = STOP_REASON;
        throw new StopRun(STOP_REASON);
      }
      if (e.kind !== "rate_limited") ctx.consecutive429 = 0;
      const retriable = e.kind === "rate_limited" || e.kind === "timeout";
      if (!retriable || ctx.budget <= 0) throw e;
      ctx.budget--;
      const wait = ctx.opts.backoffMs(RETRY_BUDGET - ctx.budget);
      ctx.opts.log(`  ${e.message}；${Math.round(wait / 1000)} 秒后重试（本次运行还剩 ${ctx.budget} 次重试）`);
      await ctx.opts.sleep(wait);
    }
  }
}

export const MWEB_ARGS = ["--extractor-args", "youtube:player_client=mweb"];

/** 默认客户端带字幕轨但不带热度条；mweb 客户端带热度条但不带字幕轨——所以元数据分两次取 */
async function fetchInfo(ctx: Ctx, id: string, mweb = false): Promise<Record<string, unknown>> {
  const { stdout } = await call(ctx, [...(mweb ? MWEB_ARGS : []), "-J", canonicalUrl(id)], ctx.opts.timeouts.info);
  try { return JSON.parse(stdout) as Record<string, unknown>; } catch { throw new YtdlpError("failed", "yt-dlp 输出的元数据不是合法 JSON"); }
}

interface SubResult { status: "ok" | "none" | "failed"; source?: string; lang?: string; reason?: string; cues: Cue[] | null }

async function fetchSubtitles(ctx: Ctx, id: string, info: Record<string, unknown>, dir: string): Promise<SubResult> {
  const choice = pickSubtitle(info);
  if (!choice) return { status: "none", reason: "没有英文字幕（人工和自动都没有；不取翻译轨）", cues: null };
  const tmp = await fs.mkdtemp(path.join(dir, `.tmp-${id}-`));
  try {
    const infoFile = path.join(tmp, "info.json");
    await fs.writeFile(infoFile, JSON.stringify(info));
    const flag = choice.source === "manual" ? "--write-subs" : "--write-auto-subs";
    await call(ctx, ["--load-info-json", infoFile, flag, "--sub-langs", choice.lang, "--sub-format", "vtt", "-o", path.join(tmp, "%(id)s.%(ext)s")], ctx.opts.timeouts.subs);
    const vtt = await fs.readFile(path.join(tmp, `${id}.${choice.lang}.vtt`), "utf8").catch(() => null);
    if (vtt === null) return { status: "failed", ...choice, reason: "yt-dlp 没写出字幕文件", cues: null };
    const cues = parseVtt(vtt);
    return cues.length ? { status: "ok", ...choice, cues } : { status: "failed", ...choice, reason: "字幕文件是空的", cues: null };
  } catch (e) {
    if (e instanceof StopRun || (e instanceof YtdlpError && e.kind === "missing")) throw e;
    return { status: "failed", ...choice, reason: e instanceof Error ? e.message : String(e), cues: null };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

interface CommentResult { status: "ok" | "disabled" | "failed" | "not_requested"; reason?: string; items: Comment[] }

async function fetchComments(ctx: Ctx, id: string): Promise<CommentResult> {
  const n = ctx.opts.comments;
  if (n <= 0) return { status: "not_requested", items: [] };
  try {
    const args = ["-J", "--write-comments", "--extractor-args", `youtube:max_comments=${n},${n},0,0;comment_sort=top`, canonicalUrl(id)];
    const { stdout, stderr } = await call(ctx, args, ctx.opts.timeouts.comments);
    const info = JSON.parse(stdout) as Record<string, unknown>;
    const items = trimComments(info.comments, n);
    if (items.length) return { status: "ok", items };
    if (/comments? (are|is) (turned off|disabled)/i.test(stderr) || !num(info.comment_count)) return { status: "disabled", reason: "评论已关闭或没有评论", items: [] };
    return { status: "failed", reason: "yt-dlp 没返回评论", items: [] };
  } catch (e) {
    if (e instanceof StopRun) return { status: "failed", reason: "抓评论时被限流，评论没抓到（字幕已保留）", items: [] };
    if (e instanceof YtdlpError && e.kind === "missing") throw e;
    return { status: "failed", reason: e instanceof Error ? e.message : String(e), items: [] };
  }
}

interface HeatInfo { meta: Record<string, unknown>; reason: string | null }

/** mweb 取元数据和热度条；失败就用默认客户端的元数据，热度条记为取不到并写原因 */
async function fetchMweb(ctx: Ctx, id: string, fallback: Record<string, unknown>): Promise<HeatInfo> {
  try {
    const meta = await fetchInfo(ctx, id, true);
    return { meta, reason: normalizeHeatmap(meta.heatmap) ? null : "这条视频没有热度条（新视频或播放量小）" };
  } catch (e) {
    if (e instanceof StopRun || (e instanceof YtdlpError && e.kind === "missing")) throw e;
    return { meta: { ...fallback, heatmap: null }, reason: `mweb 客户端取热度条失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

function videoRecord(id: string, info: Record<string, unknown>, subs: SubResult, comments: CommentResult) {
  return {
    id, url: canonicalUrl(id),
    title: typeof info.title === "string" ? info.title : null,
    channel: typeof info.channel === "string" ? info.channel : null,
    view_count: num(info.view_count), like_count: num(info.like_count), comment_count: num(info.comment_count),
    duration: num(info.duration), upload_date: typeof info.upload_date === "string" ? info.upload_date : null,
    heatmap: normalizeHeatmap(info.heatmap),
    subtitles: { status: subs.status, source: subs.source ?? null, lang: subs.lang ?? null, reason: subs.reason ?? null },
    comments: { status: comments.status, reason: comments.reason ?? null, items: comments.items },
    fetched_at: new Date().toISOString(),
  };
}

async function fetchOne(ctx: Ctx, id: string, dir: string, preInfo?: Record<string, unknown>): Promise<IndexEntry> {
  const info = preInfo ?? await fetchInfo(ctx, id);
  const heat = await fetchMweb(ctx, id, info);
  const subs = await fetchSubtitles(ctx, id, info, dir);
  const comments = ctx.stopped ? { status: "failed" as const, reason: "整批已停下，评论没抓", items: [] } : await fetchComments(ctx, id);
  const rec = { ...videoRecord(id, { ...info, ...pickMeta(heat.meta) }, subs, comments), heatmap_reason: heat.reason };
  if (subs.cues) await writeTextAtomic(path.join(dir, `${id}.txt`), transcriptText(subs.cues));
  const peaks = rec.heatmap
    ? { metric: "replay_intensity", note: "重看强度：观众在这里反复回看的程度，不是留存率，不推断谁留下谁流失", ...replayPeaks(rec.heatmap, subs.cues) }
    : { metric: "replay_intensity", note: `没有重看强度数据：${heat.reason}`, top: [], bottom: [] };
  await writeJsonAtomic(path.join(dir, `${id}.peaks.json`), peaks);
  await writeJsonAtomic(path.join(dir, `${id}.json`), rec);
  return {
    id, url: rec.url, status: "ok", title: rec.title, heatmap: Boolean(rec.heatmap), comments: comments.status,
    subtitles: subs.status === "ok" ? `${subs.source}:${subs.lang}` : subs.status,
    ...(heat.reason ? { heatmap_reason: heat.reason } : {}),
    ...(subs.reason || comments.reason ? { reason: [subs.reason, comments.reason].filter(Boolean).join("；") } : {}),
  };
}

/** mweb 那次的数字和热度条优先；缺的字段保留默认客户端的值 */
function pickMeta(m: Record<string, unknown>): Record<string, unknown> {
  const keys = ["title", "channel", "view_count", "like_count", "comment_count", "duration", "upload_date", "heatmap"];
  return Object.fromEntries(keys.filter((k) => m[k] !== undefined && m[k] !== null || k === "heatmap").map((k) => [k, m[k]]));
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { return null; }
}

/** 已完成 = 有 <id>.json；要评论而上次评论失败的不算完成 */
async function completed(dir: string, id: string, wantComments: boolean): Promise<boolean> {
  const rec = await readJson<{ comments?: { status?: string } }>(path.join(dir, `${id}.json`));
  if (!rec) return false;
  return !wantComments || rec.comments?.status === "ok" || rec.comments?.status === "disabled";
}

async function writeIndex(dir: string, entries: Map<string, IndexEntry>, stopped: string | null): Promise<void> {
  await writeJsonAtomic(path.join(dir, "index.json"), { updated_at: new Date().toISOString(), stopped, videos: [...entries.values()] });
}

function makeCtx(o: FetchOptions): Ctx {
  return {
    opts: {
      exec: o.exec, log: o.log ?? (() => {}),
      sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      backoffMs: o.backoffMs ?? ((attempt) => 30_000 * 2 ** (attempt - 1)),
      timeouts: o.timeouts ?? { info: 90_000, subs: 90_000, comments: 180_000 },
      comments: Math.min(Math.max(0, Math.floor(o.comments ?? 0)), MAX_COMMENTS),
    },
    budget: RETRY_BUDGET, consecutive429: 0, stopped: null,
  };
}

export function validateUrls(urls: string[]): { ids: string[]; bad: string[] } {
  const bad = urls.filter((u) => !parseVideoUrl(u));
  const ids = [...new Set(urls.map(parseVideoUrl).filter((x): x is string => Boolean(x)))];
  return { ids, bad };
}

/** 没给 --out：用第一条视频的频道 id 定博主目录（这次取到的元数据留给第一条复用） */
async function resolveDir(ctx: Ctx, o: FetchOptions, firstId: string): Promise<{ dir: string; info?: Record<string, unknown> }> {
  if (o.outDir) return { dir: path.resolve(o.outDir) };
  const info = await fetchInfo(ctx, firstId);
  const slug = slugify(String(info.uploader_id ?? info.channel ?? info.uploader ?? ""));
  if (!slug) throw new YtdlpError("failed", "第一条视频的元数据里没有频道名，没法定博主目录；请加 --out <目录>");
  return { dir: path.join(o.craftRoot ?? CRAFT_ROOT, slug), info };
}

async function step(ctx: Ctx, id: string, dir: string, preInfo?: Record<string, unknown>): Promise<IndexEntry> {
  try {
    return await fetchOne(ctx, id, dir, preInfo);
  } catch (e) {
    if (e instanceof YtdlpError && e.kind === "missing") throw e;
    return { id, url: canonicalUrl(id), status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}

async function loop(ctx: Ctx, o: FetchOptions, ids: string[], dir: string, first?: Record<string, unknown>): Promise<Map<string, IndexEntry>> {
  const prev = await readJson<{ videos?: IndexEntry[] }>(path.join(dir, "index.json"));
  const entries = new Map((prev?.videos ?? []).map((v) => [v.id, v]));
  let fetched = Boolean(first);
  for (const id of ids) {
    if (ctx.stopped) {
      entries.set(id, { id, url: canonicalUrl(id), status: "not_attempted", reason: "整批因限流停下，这条没抓；重跑同一条命令会接着抓" });
      continue;
    }
    const preInfo = id === ids[0] ? first : undefined;
    if (await completed(dir, id, ctx.opts.comments > 0)) {
      const old = entries.get(id);
      entries.set(id, { ...(old ?? { id, url: canonicalUrl(id), status: "ok" }), status: "ok", resumed: true });
      ctx.opts.log(`- ${id} 上次已抓完，跳过`);
      continue;
    }
    if (fetched && !preInfo) await ctx.opts.sleep((o.pauseMs ?? (() => 5_000 + Math.random() * 5_000))());
    fetched = true;
    const entry = await step(ctx, id, dir, preInfo);
    entries.set(id, entry);
    ctx.opts.log(`- ${id} ${entry.status === "ok" ? "完成" : "失败"}${entry.reason ? `（${entry.reason}）` : ""}`);
    await writeIndex(dir, entries, ctx.stopped);
  }
  return entries;
}

export async function runCraftFetch(o: FetchOptions): Promise<FetchSummary> {
  const empty = { done: 0, failed: 0, notAttempted: 0, stopped: null };
  const { ids, bad } = validateUrls(o.urls);
  if (bad.length) return { ok: false, error: `只收 YouTube 单条视频网址（youtube.com/watch?v=… 或 youtu.be/…），这些不收：${bad.join(" ")}`, ...empty };
  if (!ids.length) return { ok: false, error: "没给视频网址", ...empty };
  const ctx = makeCtx(o);
  let resolved: { dir: string; info?: Record<string, unknown> };
  try { resolved = await resolveDir(ctx, o, ids[0]); } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), ...empty, stopped: ctx.stopped };
  }
  await fs.mkdir(resolved.dir, { recursive: true });
  let entries: Map<string, IndexEntry>;
  try { entries = await loop(ctx, o, ids, resolved.dir, resolved.info); } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), outDir: resolved.dir, ...empty };
  }
  await writeIndex(resolved.dir, entries, ctx.stopped);
  const mine = ids.map((id) => entries.get(id)!);
  const count = (s: IndexEntry["status"]) => mine.filter((e) => e.status === s).length;
  return { ok: !ctx.stopped && count("failed") === 0, outDir: resolved.dir, done: count("ok"), failed: count("failed"), notAttempted: count("not_attempted"), stopped: ctx.stopped };
}

/** --clean <博主>：删掉本机缓存里这个博主的整个目录。只删 craftRoot 下一层 */
export async function cleanCreator(creator: string, craftRoot = CRAFT_ROOT): Promise<{ removed: boolean; dir: string }> {
  const slug = slugify(creator);
  if (!slug) throw new Error(`博主名不合法：${creator}`);
  const dir = path.join(craftRoot, slug);
  if (path.dirname(dir) !== path.resolve(craftRoot)) throw new Error(`拒绝删除：${dir}`);
  const existed = await fs.stat(dir).then(() => true, () => false);
  await fs.rm(dir, { recursive: true, force: true });
  return { removed: existed, dir };
}
