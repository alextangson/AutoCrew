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
import { exportMatchesTitle } from "../video/unregistered-cut.js";
import { checkDuration, STABLE_MS } from "./files.js";
import { fileVerdict, type Found, type Verdict } from "./match/background.js";
import { describeTop3, looksLike, type MatchDecision, type PoolEntry } from "./match/decide.js";
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

function judgeInbox(out: Discovery, decided: Array<{ f: Found; d: MatchDecision }>, waiting: ReadonlySet<string>): void {
  const byTarget = new Map<string, number>();
  for (const { d } of decided) if (d.winner) byTarget.set(d.winner, (byTarget.get(d.winner) ?? 0) + 1);
  for (const { f, d } of decided) {
    if (d.winner) {
      const many = byTarget.get(d.winner)! > 1;
      if (waiting.has(d.winner) && !many) { out.autoMoves.push({ content_id: d.winner, file: f, d }); continue; }
      const note = many ? `同一批有 ${byTarget.get(d.winner)} 个视频都像这条（多 take），不自动认` : "这条已经有本轮原片了，后来的只做候选";
      suggest(out, d.winner, seen(f, "aroll", `原片收件箱：${note}；${why(d)}`, matchOf(d)));
      continue;
    }
    const likes = d.top3.filter(looksLike);
    for (const r of likes) suggest(out, r.content_id, seen(f, "aroll", `原片收件箱：${why(d)}`, matchOf(d)));
    if (!likes.length) out.inbox.unmatched.push({ name: f.name, path: f.file, size: f.size, mtime_ms: f.mtime_ms, guess: d.top3.map((r) => r.title) });
  }
}

async function discoverInbox(dataDir: string, dir: string, pool: PoolEntry[], waiting: Set<string>, out: Discovery): Promise<void> {
  const listed = await listTop(dir, isVideo);
  if (listed.error) { out.warnings.push(`读不了原片收件箱 ${dir}（${listed.error}）`); return; }
  const decided: Array<{ f: Found; d: MatchDecision }> = [];
  for (const raw of listed.files) {
    const f = await found(raw).catch(() => null);
    if (!f) { out.inbox.failed.push({ name: raw.name, path: raw.file, reason: "读不了这个文件" }); continue; }
    // 完整性与其他挂载入口一致（Codex 审 segB2 P1）：读不出时长 = 坏的或还没拷完，不判、不挪，列进「没核对成」
    const dur = await checkDuration(f.file, probe);
    if (!dur.ok) { out.inbox.failed.push({ name: f.name, path: f.file, reason: dur.error }); continue; }
    const v: Verdict = await fileVerdict(dataDir, f, pool);
    if (v.kind === "checking") out.inbox.checking += 1;
    else if (v.kind === "failed") out.inbox.failed.push({ name: f.name, path: f.file, reason: v.reason });
    else decided.push({ f, d: v.d });
  }
  if (out.inbox.failed.length) out.warnings.push(`收件箱里 ${out.inbox.failed.length} 个视频没核对成：${out.inbox.failed.map((x) => `${x.name}（${x.reason}）`).join("；")}`);
  // 按批判定：还有在核对的就整批等下一轮（之后新到的文件进下一批）
  if (out.inbox.checking === 0) judgeInbox(out, decided, waiting);
}

// ---- §5 监视文件夹 ----

async function watchFile(dataDir: string, raw: { file: string; name: string; size: number; mtime: number }, pool: PoolEntry[], waiting: Set<string>): Promise<Verdict> {
  const f = await found(raw);
  if (!waiting.size) return fileVerdict(dataDir, f, pool, { transcribe: false, why: "没有等原片的稿，不转写" });
  if (raw.size > WATCH_MAX_BYTES) return fileVerdict(dataDir, f, pool, { transcribe: false, why: "超过 10 GB，只比了文件名" });
  const dur = await probe(raw.file);
  if ("error" in dur) return fileVerdict(dataDir, f, pool, { transcribe: false, why: `读不出时长（${dur.error}），只比了文件名` });
  if (dur.durationMs > WATCH_MAX_MS) return fileVerdict(dataDir, f, pool, { transcribe: false, why: "超过 60 分钟，只比了文件名" });
  return fileVerdict(dataDir, f, pool);
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
    const v = await watchFile(dataDir, raw, pool, waiting).catch((e: unknown) => ({ kind: "failed" as const, reason: errCode(e) }));
    // 没能比完（转写失败到头 / 读不了）与没对上分开：要看得见（Codex 审 segB P2，§14-14）
    if (v.kind === "failed") { failed.push(`${raw.name}（${v.reason}）`); continue; }
    // 只出建议：对上等原片的稿才给候选；对不上静默跳过（下载里大量无关视频，不计入列头）
    if (v.kind !== "decided" || !v.d.winner || !waiting.has(v.d.winner)) continue;
    const f = await found(raw);
    suggest(out, v.d.winner, seen(f, "aroll", `监视文件夹 ${path.basename(folder.path)}：${why(v.d)}`, matchOf(v.d)));
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
