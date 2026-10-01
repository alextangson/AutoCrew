/**
 * 对账的「自己去找」（1b §4 收件箱、§5 监视文件夹、§6 导出目录）：在归属锁**之外**扫描、算哈希、入队转写，
 * 产出每条稿的候选（交给 reconcileOne 走 applyObservations 去重——任何一轮记过同一份字节就不再建议，B10）
 * 与收件箱的自动挪清单（锁内由 auto-attach 按 §3-4 同一套检查复核后才搬）。
 *
 * - 收件箱按批判定（§14-5）：已发现的文件**全部**有结果（已判 / 失败）才统一判；同一目标多个文件 → 全部候选（多 take）。
 * - 监视文件夹只出建议，从不自动挪；对不上的静默跳过，不计入列头；没有「等 A-roll」的稿时不转写（B14）。
 * - 导出目录：先按标题前缀认，认不出再用转写（低优先级）；同目录同名 .srt → 字幕候选；其他文件忽略。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { listContents, type Content } from "../../storage/local-store.js";
import { isOntologyActive, readProductionDoc } from "../../storage/production-store.js";
import type { Fact } from "../../storage/production-types.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { getWorkspaceCacheDir } from "../../storage/storage-roots.js";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import { exportMatchesTitle } from "../video/unregistered-cut.js";
import { checkDuration, STABLE_MS } from "./files.js";
import { fileVerdict, type Found, type Verdict } from "./match/background.js";
import { decide, describeTop3, looksLike, type MatchDecision, type PoolEntry } from "./match/decide.js";
import { matchDeps } from "./match/deps.js";
import { arollPool, EXPORT_POOL_STATUS, exportPool } from "./match/pool.js";
import { cachedSha, VIDEO_EXT, type Seen } from "./observe.js";
import type { InboxStatus, WatchStatus } from "./reconcile.js";
import { movableRoots, now, probe } from "./roots.js";
import { folderProblem, readArollSources, type WatchFolder } from "./sources.js";

export const WATCH_MAX_AGE_MS = 14 * 24 * 3600_000;
export const WATCH_MAX_BYTES = 10 * 1024 ** 3;
export const WATCH_MAX_MS = 60 * 60_000;
export const PERMISSION_HINT = "读不了：去 系统设置 → 隐私与安全性 → 文件与文件夹，给运行 AutoCrew 的程序打开这个文件夹";

export interface AutoMove { content_id: string; file: Found; d: MatchDecision }
export interface Discovery { suggestions: Map<string, Seen[]>; autoMoves: AutoMove[]; inbox: InboxStatus; watch: WatchStatus[]; warnings: string[] }

const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : String(e));
const denied = (code: string) => code === "EPERM" || code === "EACCES";

/** 顶层、稳定（10 秒不变）的文件；读目录失败回错误码 */
async function listTop(dir: string, keep: (name: string) => boolean): Promise<{ files: Array<{ file: string; name: string; size: number; mtime: number }>; error?: string }> {
  let names: string[];
  try { names = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && !e.name.startsWith(".") && keep(e.name)).map((e) => e.name); }
  catch (e) { return { files: [], error: errCode(e) }; }
  const out = [];
  for (const name of names) {
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (st && now() - st.mtimeMs >= STABLE_MS) out.push({ file: path.join(dir, name), name, size: st.size, mtime: Math.trunc(st.mtimeMs) });
  }
  return { files: out };
}

async function found(f: { file: string; name: string }): Promise<Found> {
  const h = await cachedSha(f.file);
  return { file: f.file, name: f.name, sha256: h.sha256, size: h.size, mtime_ms: h.mtime_ms };
}

const isVideo = (n: string) => VIDEO_EXT.has(path.extname(n).toLowerCase());

function seen(f: Found, kind: Fact["kind"], evidence: string, extra: Partial<Seen> = {}): Seen {
  return { kind, state: "candidate", source: "reconcile", evidence, path: f.file, sha256: f.sha256, size: f.size, mtime_ms: f.mtime_ms, ...extra };
}

function suggest(out: Discovery, contentId: string, s: Seen): void {
  const list = out.suggestions.get(contentId) ?? [];
  if (!list.some((x) => x.kind === s.kind && x.sha256 === s.sha256)) list.push(s);
  out.suggestions.set(contentId, list);
}

/** 等 A-roll 的稿：在池里、按本体走、本轮还没有 accepted 原片 */
async function waitingSet(dataDir: string, pool: readonly PoolEntry[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const p of pool) {
    if (!(await isOntologyActive(dataDir, p.content_id))) continue;
    const doc = await readProductionDoc(p.content_id, dataDir).catch(() => null);
    if (!doc?.facts.some((f) => f.round === doc.round && f.kind === "aroll" && f.state === "accepted")) out.add(p.content_id);
  }
  return out;
}

const matchOf = (d: MatchDecision): Partial<Seen> => ({ match: { winner: d.winner, reason: d.reason, top3: d.top3.map((r) => ({ ...r })) } });
const why = (d: MatchDecision) => `${d.reason}${d.top3.length ? `；前三名：${describeTop3(d.top3)}` : ""}`;

// ---- §4 收件箱 ----

/** 创始人对哪条稿点过「不是」的原片字节（稿件 id|sha） */
async function rejectedPairs(pool: readonly PoolEntry[], dataDir: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const p of pool) {
    const doc = await readProductionDoc(p.content_id, dataDir).catch(() => null);
    for (const f of doc?.facts ?? []) if (f.kind === "aroll" && f.state === "rejected" && f.sha256) out.add(`${p.content_id}|${f.sha256}`);
  }
  return out;
}

function judgeInbox(out: Discovery, decided: Array<{ f: Found; d: MatchDecision }>, waiting: ReadonlySet<string>, rejected: ReadonlySet<string> = new Set()): void {
  const byTarget = new Map<string, number>();
  for (const { d } of decided) if (d.winner) byTarget.set(d.winner, (byTarget.get(d.winner) ?? 0) + 1);
  for (const { f, d } of decided) {
    // 创始人对那条稿点过「不是」、被挪回收件箱的文件：不再往那条凑，算「没对上」列进列头（verifier 2a P3）
    const no = (id: string) => rejected.has(`${id}|${f.sha256}`);
    if (d.winner && no(d.winner)) {
      out.inbox.unmatched.push({ name: f.name, path: f.file, sha256: f.sha256, size: f.size, mtime_ms: f.mtime_ms, guess: d.top3.filter((r) => !no(r.content_id)).map((r) => r.title), reason: "你说过不是那条" });
      continue;
    }
    if (d.winner) {
      const many = byTarget.get(d.winner)! > 1;
      if (waiting.has(d.winner) && !many) { out.autoMoves.push({ content_id: d.winner, file: f, d }); continue; }
      const note = many ? `同一批有 ${byTarget.get(d.winner)} 个视频都像这条（多 take），不自动认` : "这条已经有本轮原片了，后来的只做候选";
      suggest(out, d.winner, seen(f, "aroll", `原片收件箱：${note}；${why(d)}`, matchOf(d)));
      continue;
    }
    const likes = d.top3.filter(looksLike).filter((r) => !no(r.content_id));
    for (const r of likes) suggest(out, r.content_id, seen(f, "aroll", `原片收件箱：${why(d)}`, matchOf(d)));
    if (!likes.length) out.inbox.unmatched.push({ name: f.name, path: f.file, sha256: f.sha256, size: f.size, mtime_ms: f.mtime_ms, guess: d.top3.map((r) => r.title), reason: d.reason });
  }
}

/**
 * 收件箱批次成员持久化（Codex 审 segB3 P2，spec §4 / §14-5）：一批 = 开批时收件箱里的文件（按 sha）。
 * 只等这批的都有结果（已判 / 失败）就提交；之后新到的文件进下一批，挡不住这一批。离开收件箱的成员自然出批。
 */
function batchFile(dataDir: string): string {
  return path.join(getWorkspaceCacheDir(dataDir), "inbox-batch.json");
}

async function readBatch(dataDir: string): Promise<string[]> {
  try { const v = JSON.parse(await fs.readFile(batchFile(dataDir), "utf8")) as { members?: unknown }; return Array.isArray(v.members) ? v.members.filter((x): x is string => typeof x === "string") : []; }
  catch { return []; }
}

async function writeBatch(dataDir: string, members: string[]): Promise<void> {
  await writeJsonAtomicMkdir(batchFile(dataDir), { members });
}

async function discoverInbox(dataDir: string, dir: string, pool: PoolEntry[], waiting: Set<string>, out: Discovery): Promise<void> {
  const listed = await listTop(dir, isVideo);
  if (listed.error) { out.warnings.push(`读不了原片收件箱 ${dir}（${listed.error}）`); return; }
  const seen: Array<{ f: Found; v: Verdict }> = [];
  for (const raw of listed.files) {
    const f = await found(raw).catch(() => null);
    if (!f) { out.inbox.failed.push({ name: raw.name, path: raw.file, reason: "读不了这个文件" }); continue; }
    // 完整性与其他挂载入口一致（Codex 审 segB2 P1）：读不出时长 = 坏的或还没拷完，不判、不挪，列进「没核对成」
    const dur = await checkDuration(f.file, probe);
    if (!dur.ok) { out.inbox.failed.push({ name: f.name, path: f.file, reason: dur.error }); continue; }
    const v: Verdict = await fileVerdict(dataDir, f, pool);
    if (v.kind === "checking") out.inbox.checking += 1;
    else if (v.kind === "failed") out.inbox.failed.push({ name: f.name, path: f.file, reason: v.reason });
    else if (v.note) out.warnings.push(`收件箱里的 ${f.name} ${v.note}，这次只比了文件名（一小时后再试转写）`);
    seen.push({ f, v });
  }
  if (out.inbox.failed.length) out.warnings.push(`收件箱里 ${out.inbox.failed.length} 个视频没核对成：${out.inbox.failed.map((x) => `${x.name}（${x.reason}）`).join("；")}`);
  const present = new Set(seen.map((x) => x.f.sha256));
  let members = (await readBatch(dataDir)).filter((sha) => present.has(sha));
  if (!members.length) members = [...present];
  const batch = seen.filter((x) => members.includes(x.f.sha256));
  if (batch.some((x) => x.v.kind === "checking")) { await writeBatch(dataDir, members); return; }
  judgeInbox(out, batch.flatMap((x) => (x.v.kind === "decided" ? [{ f: x.f, d: x.v.d }] : [])), waiting, await rejectedPairs(pool, dataDir));
  await writeBatch(dataDir, []);
}

// ---- §5 监视文件夹 ----

type Raw = { file: string; name: string; size: number; mtime: number };
/** 监视文件夹里一个文件的处理结果：出建议（带已算好的哈希）、没核对成（带原因）、或安静跳过 */
type WatchOutcome = { kind: "suggest"; f: Found; d: MatchDecision; note?: string } | { kind: "failed"; reason: string } | { kind: "skip"; note?: string };

/**
 * 顺序（Codex 审 segB7 P2）：按 stat 的便宜过滤（14 天、10 GB，调用方已过）→ 有没有等原片的稿 → 文件名判 →
 * 读时长 → 最后才算完整哈希。只有要入队转写或要写候选的文件才读全文件；下载里的大视频不白读。
 */
async function watchFile(dataDir: string, raw: Raw, pool: PoolEntry[], waiting: Set<string>): Promise<WatchOutcome> {
  if (!waiting.size) return { kind: "skip" };
  const byName = decide({ fileName: raw.name, sha256: "", pool, heard: { text: null, why: "只比了文件名" } }, matchDeps().thresholds);
  if (byName.winner) return waiting.has(byName.winner) ? { kind: "suggest", f: await found(raw), d: byName } : { kind: "skip" };
  if (raw.size > WATCH_MAX_BYTES) return { kind: "skip" };
  const dur = await probe(raw.file);
  // 读不出时长 = 坏的或还没拷完：进「没核对成」并提示，不静默（Codex 审 segB7 P2）
  if ("error" in dur) return { kind: "failed", reason: `读不出时长（${dur.error}）` };
  if (dur.durationMs > WATCH_MAX_MS) return { kind: "skip" };
  const f = await found(raw);
  const v = await fileVerdict(dataDir, f, pool);
  if (v.kind === "failed") return v;
  const note = v.kind === "decided" ? v.note : undefined;
  return v.kind === "decided" && v.d.winner && waiting.has(v.d.winner) ? { kind: "suggest", f, d: v.d, ...(note ? { note } : {}) } : { kind: "skip", ...(note ? { note } : {}) };
}

async function discoverWatch(dataDir: string, folder: WatchFolder, pool: PoolEntry[], waiting: Set<string>, out: Discovery): Promise<void> {
  const status: WatchStatus = { path: folder.path, at: new Date(now()).toISOString(), files: 0, suggested: 0 };
  out.watch.push(status);
  const problem = await folderProblem(folder);
  const listed = problem ? { files: [], error: problem } : await listTop(folder.path, (n) => isVideo(n));
  if (listed.error) {
    status.error = denied(listed.error) || listed.error.includes("EPERM") || listed.error.includes("EACCES") ? PERMISSION_HINT : listed.error;
    out.warnings.push(`监视文件夹 ${folder.path}：${status.error}`);
    return;
  }
  const recent = listed.files.filter((x) => now() - x.mtime <= WATCH_MAX_AGE_MS);
  status.files = recent.length;
  const failed: string[] = [];
  for (const raw of recent) {
    const o = await watchFile(dataDir, raw, pool, waiting).catch((e: unknown): WatchOutcome => ({ kind: "failed", reason: errCode(e) }));
    // 没能比完（转写失败到头 / 读不了）与没对上分开：要看得见（Codex 审 segB P2，§14-14）
    if (o.kind === "failed") { failed.push(`${raw.name}（${o.reason}）`); continue; }
    if (o.note) out.warnings.push(`监视文件夹 ${folder.path} 里的 ${raw.name} ${o.note}，这次只比了文件名`);
    // 只出建议：对上等原片的稿才给候选；对不上静默跳过（下载里大量无关视频，不计入列头）
    if (o.kind !== "suggest") continue;
    suggest(out, o.d.winner!, seen(o.f, "aroll", `监视文件夹 ${path.basename(folder.path)}：${why(o.d)}`, matchOf(o.d)));
    status.suggested += 1;
  }
  if (failed.length) {
    status.error = `${failed.length} 个视频没核对成：${failed.join("；")}`;
    out.warnings.push(`监视文件夹 ${folder.path}：${status.error}`);
  }
}

// ---- §6 导出目录 ----

function exportTargets(name: string, contents: readonly Content[]): Content[] {
  return contents.filter((c) => exportMatchesTitle(name, c.title));
}

async function srtNextTo(file: string, srts: ReadonlyMap<string, { file: string; name: string; size: number; mtime: number }>): Promise<Found | null> {
  const hit = srts.get(path.basename(file, path.extname(file)));
  return hit ? found(hit).catch(() => null) : null;
}

async function discoverExport(dataDir: string, dir: string, contents: Content[], pool: PoolEntry[], out: Discovery): Promise<void> {
  const listed = await listTop(dir, (n) => isVideo(n) || path.extname(n).toLowerCase() === ".srt");
  if (listed.error) { if (listed.error !== "ENOENT") out.warnings.push(`读不了剪辑软件导出目录 ${dir}（${listed.error}）`); return; }
  const srts = new Map(listed.files.filter((x) => x.name.toLowerCase().endsWith(".srt")).map((x) => [path.basename(x.name, path.extname(x.name)), x]));
  for (const raw of listed.files.filter((x) => isVideo(x.name))) {
    const f = await found(raw);
    const byName = exportTargets(f.name, contents);
    let targets: Array<{ id: string; evidence: string; match?: MatchDecision }> = byName.map((c) => ({ id: c.id, evidence: "文件名前缀对上标题（剪辑软件导出）" }));
    if (!targets.length) {
      const v = await fileVerdict(dataDir, f, pool);
      if (v.kind === "failed") { out.warnings.push(`剪辑软件导出 ${f.name} 没核对成：${v.reason}`); continue; }
      if (v.kind === "decided" && v.note) out.warnings.push(`剪辑软件导出 ${f.name} ${v.note}，这次只比了文件名`);
      if (v.kind !== "decided") continue;
      const ids = v.d.winner ? [v.d.winner] : v.d.top3.filter((r) => looksLike(r)).map((r) => r.content_id);
      targets = ids.map((id) => ({ id, evidence: `剪辑软件导出：${why(v.d)}`, match: v.d }));
    }
    const srt = targets.length ? await srtNextTo(f.file, srts) : null;
    for (const t of targets) {
      const published = contents.find((c) => c.id === t.id)?.status === "published";
      suggest(out, t.id, seen(f, "cut", t.evidence, { ...(published ? { post_publish: true as const } : {}), ...(t.match ? matchOf(t.match) : {}) }));
      if (srt) suggest(out, t.id, seen(srt, "srt", "和成片同名的字幕（剪辑软件导出）", { for_cut: f.sha256, ...(published ? { post_publish: true } : {}) }));
    }
  }
}

/** 一轮发现；每个来源各自隔离，失败进 warnings */
export async function discoverExternal(dataDir: string): Promise<Discovery> {
  const out: Discovery = { suggestions: new Map(), autoMoves: [], inbox: { unmatched: [], failed: [], checking: 0 }, watch: [], warnings: [] };
  const roots = await movableRoots(dataDir);
  const pool = await arollPool(dataDir);
  const waiting = await waitingSet(dataDir, pool);
  const guard = async (label: string, fn: () => Promise<void>) => fn().catch((e: unknown) => { out.warnings.push(`${label}：${e instanceof Error ? e.message : String(e)}`); });
  if (roots.inbox) await guard("收件箱没扫成", () => discoverInbox(dataDir, roots.inbox!, pool, waiting, out));
  const sources = await readArollSources(dataDir).catch((e: unknown) => { out.warnings.push(`读不了原片监视文件夹设置：${errCode(e)}`); return null; });
  for (const folder of (sources?.folders ?? []).filter((x) => x.scan)) await guard(`监视文件夹 ${folder.path} 没扫成`, () => discoverWatch(dataDir, folder, pool, waiting, out));
  const contents = (await listContents(dataDir)).filter((c) => isVideoPlatform(c.platform) && !c.deletedAt && EXPORT_POOL_STATUS.has(c.status));
  const xpool = await exportPool(dataDir);
  for (const dir of [roots.chatcut, roots.jianying]) if (dir) await guard(`导出目录 ${dir} 没扫成`, () => discoverExport(dataDir, dir, contents, xpool, out));
  return out;
}
