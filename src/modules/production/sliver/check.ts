/**
 * 抽帧检查的编排（spec §5、§7、§8、§12-2 / §12-3）。调用方持有文件归属事务（record / 对账 / 创始人决定）。
 *
 * - 快照：本轮有 chatcut_project 事实时，把时间线和所引素材元数据冻结进 `04-edit/chatcut-snapshots/<cut_sha8>/`；
 *   时间线文件在成片导出之后又保存过 → 不拍快照，未检查「导出后时间线改过」。
 * - 指纹 = 检查器版本 + 轮次 + 成片 sha + 工程记录 + 快照 sha + A-roll 事实 id。同指纹的确定结果只算一次；
 *   没有快照或读文件出错的结果标 transient，不缓存，下次触发重跑。
 * - 写入按轮次、成片、工程记录、A-roll 条件落：跑的途中这些变了，结果作废不写。
 * - 任何异常都落成 unchecked + 原因，绝不当 clean（§8、E14）。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { contentRoot } from "../../../storage/content-project.js";
import { writeJsonAtomicMkdir } from "../../../storage/json-atomic.js";
import { getContent, type Content } from "../../../storage/local-store.js";
import { isOntologyActive, newId, readProductionDocOrEmpty } from "../../../storage/production-store.js";
import type { Fact, ProductionDoc, SliverCheck } from "../../../storage/production-types.js";
import { isVideoPlatform } from "../../../storage/stage-guard.js";
import { publishReceipts, srtFor, validCutApproval } from "../derive.js";
import { checkTargetDir } from "../record-plan.js";
import { isWithin } from "../../../storage/storage-roots.js";
import { mutateProduction } from "../service.js";
import { buildSnapshot, probePixFmt, readTimeline, videoTiming, type Read } from "./chatcut-read.js";
import { detectSlivers, type DetectOutcome } from "./detect.js";
import { CHECKER_VERSION, type ArollIdentity, type Fps, type Snapshot } from "./snapshot-types.js";
import { withSuggestions } from "./suggest.js";

const KEEP = 30;
const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
const inRound = (doc: ProductionDoc) => doc.facts.filter((f) => f.round === doc.round && f.state === "accepted");

/** 本轮当前成片：最新一条 accepted、没被覆盖的 cut */
export function currentCut(doc: ProductionDoc): Fact | null {
  return inRound(doc).filter((f) => f.kind === "cut" && f.sha256 && !f.replaced_at).reduce<Fact | null>((b, f) => (!b || f.at >= b.at ? f : b), null);
}
const chatcutFact = (doc: ProductionDoc) => inRound(doc).filter((f) => f.kind === "chatcut_project").reduce<Fact | null>((b, f) => (!b || f.at >= b.at ? f : b), null);
const arollFacts = (doc: ProductionDoc) => inRound(doc).filter((f) => f.kind === "aroll" && !f.released_to && f.sha256);

const abs = (root: string, p: string) => (path.isAbsolute(p) ? p : path.join(root, p));
export const snapshotRel = (cutSha: string) => path.join("04-edit", "chatcut-snapshots", cutSha.slice(0, 8), "snapshot.json");

interface SnapshotFile { meta: { cut_sha: string; project_id: string; timeline_id: string; timeline_mtime_ms: number; taken_at: string }; snapshot: Snapshot }

interface Snap { snap: Snapshot; sha: string; /** 还有素材探针临时失败：结果不缓存，下次重试 */ retry: boolean }

/**
 * 写快照：目录逐段不许是符号链接、最终位置必须仍在项目里，快照文件本身不许是链接（Codex 审 sliver P2，同 record 落位的防线）。
 */
async function writeSnapshot(root: string, rel: string, body: SnapshotFile): Promise<Read<string>> {
  const realRoot = await fs.realpath(root);
  const dirRel = path.dirname(rel);
  const bad = { ok: false as const, reason: "项目里的快照目录是符号链接或不是目录，快照不写：请先改回普通文件夹" };
  if (!(await checkTargetDir(realRoot, dirRel)).ok) return bad;
  const dir = path.join(realRoot, dirRel);
  await fs.mkdir(dir, { recursive: true });
  if (!isWithin(realRoot, await fs.realpath(dir)) || !(await checkTargetDir(realRoot, dirRel)).ok) return bad;
  const file = path.join(dir, path.basename(rel));
  if ((await fs.lstat(file).catch(() => null))?.isSymbolicLink()) return bad;
  await writeJsonAtomicMkdir(file, body);
  return { ok: true, value: sha256(await fs.readFile(file)) };
}

async function readSnapshot(root: string, rel: string): Promise<{ raw: Buffer; j: SnapshotFile } | null> {
  const file = path.join(root, rel);
  const st = await fs.lstat(file).catch(() => null);
  if (!st?.isFile()) return null; // 符号链接 / 不存在：当没有
  const raw = await fs.readFile(file).catch(() => null);
  try { return raw ? { raw, j: JSON.parse(raw.toString("utf8")) as SnapshotFile } : null; } catch { return null; }
}

const retryable = (s: Snapshot) => Object.values(s.assets).some((a) => a.probe_failed);

/** 已有快照（且对应当前工程记录）→ 用它，上次探针失败的素材再探一次；否则拍一张 */
async function snapshotFor(root: string, cut: Fact, cc: Fact): Promise<Read<Snap>> {
  const rel = snapshotRel(cut.sha256!);
  const old = await readSnapshot(root, rel);
  if (old && old.j.meta?.cut_sha === cut.sha256 && old.j.meta.project_id === cc.project_id && (!cc.timeline_id || cc.timeline_id === old.j.meta.timeline_id)) {
    if (!retryable(old.j.snapshot)) return { ok: true, value: { snap: old.j.snapshot, sha: sha256(old.raw), retry: false } };
    for (const a of Object.values(old.j.snapshot.assets)) if (a.probe_failed) await probePixFmt(a);
    const w = await writeSnapshot(root, rel, old.j);
    return w.ok ? { ok: true, value: { snap: old.j.snapshot, sha: w.value, retry: retryable(old.j.snapshot) } } : w;
  }
  const live = await readTimeline(cc.project_id!, cc.timeline_id);
  if (!live.ok) return live;
  const cutMtime = cut.export_mtime_ms ?? cut.mtime_ms;
  if (cutMtime !== undefined && live.value.mtime_ms > cutMtime) return { ok: false, reason: "导出后时间线又保存过：请重新导出再报这版成片" };
  const snap = await buildSnapshot(live.value, cc.project_id!);
  if (!snap.ok) return snap;
  const body: SnapshotFile = { meta: { cut_sha: cut.sha256!, project_id: cc.project_id!, timeline_id: live.value.timeline_id, timeline_mtime_ms: live.value.mtime_ms, taken_at: new Date().toISOString() }, snapshot: snap.value };
  const w = await writeSnapshot(root, rel, body);
  return w.ok ? { ok: true, value: { snap: snap.value, sha: w.value, retry: retryable(snap.value) } } : w;
}

const realOr = async (p: string) => fs.realpath(p).catch(() => path.resolve(p));

/** 逐份原片的路径身份：项目里那份文件的真实路径 + 记录 / 挪入前的原始路径（创始人 09-30：只按路径认） */
export async function arollIdentity(root: string, facts: Fact[]): Promise<ArollIdentity> {
  const out: ArollIdentity = { facts: [] };
  for (const f of facts) {
    const paths = new Set<string>();
    if (f.path) { const a = abs(root, f.path); paths.add(a); paths.add(await realOr(a)); }
    if (f.source_path) { paths.add(f.source_path); paths.add(await realOr(f.source_path)); }
    out.facts.push({ id: f.id, label: f.path ? path.basename(f.path) : f.id, paths: [...paths] });
  }
  return out;
}

interface Inputs { fingerprint: string; snapshotSha: string | null; arollIds: string[]; ccId: string | null; outcome: DetectOutcome; transient: boolean; fps: Fps | null }

async function evaluate(content: Content, doc: ProductionDoc, cut: Fact, dataDir: string): Promise<Inputs> {
  const root = contentRoot(content.id, dataDir);
  const cc = chatcutFact(doc), arolls = arollFacts(doc);
  const arollIds = arolls.map((f) => f.id).sort();
  const fp = (snapSha: string | null) => sha256(JSON.stringify([CHECKER_VERSION, doc.round, cut.sha256, cc ? [cc.project_id, cc.timeline_id ?? null] : null, snapSha, arollIds]));
  const early = (reason: string, transient = true, snapSha: string | null = null): Inputs =>
    ({ fingerprint: fp(snapSha), snapshotSha: snapSha, arollIds, ccId: cc?.id ?? null, outcome: { status: "unchecked", slivers: [], reason }, transient, fps: null });
  if (!cc?.project_id) return early("没有 ChatCut 工程记录（剪辑没报 chatcut_project，或不是 ChatCut 剪的）");
  if (!arolls.length) return early("认不出哪条是原片：本轮没有确认的原片");
  const snap = await snapshotFor(root, cut, cc);
  if (!snap.ok) return early(snap.reason);
  const timing = await videoTiming(abs(root, cut.path!));
  if (!timing.ok) return early(timing.reason, true, snap.value.sha);
  const outcome = detectSlivers({ snap: snap.value.snap, fps: timing.value.fps, aroll: await arollIdentity(root, arolls), cutFrames: timing.value.frames });
  return { fingerprint: fp(snap.value.sha), snapshotSha: snap.value.sha, arollIds, ccId: cc.id, outcome, transient: snap.value.retry, fps: timing.value.fps };
}

async function srtText(content: Content, doc: ProductionDoc, cutSha: string, dataDir: string): Promise<string | null> {
  const srt = srtFor(doc, cutSha);
  return srt?.path ? fs.readFile(abs(contentRoot(content.id, dataDir), srt.path), "utf8").catch(() => null) : null;
}

const sameResult = (a: SliverCheck, b: Omit<SliverCheck, "id" | "checked_at">) =>
  a.fingerprint === b.fingerprint && a.status === b.status && (a.reason ?? "") === (b.reason ?? "") && JSON.stringify(a.slivers) === JSON.stringify(b.slivers);

/** 这条稿现在该不该查：未启用 / 图文 / 已发布 / 当前成片已通过 → 不查（E16） */
/** 本轮某一版成片（accepted、字节没被替换）：创始人可以挑任一版审（review-inbox §7-2） */
export function cutOf(doc: ProductionDoc, sha: string): Fact | null {
  return inRound(doc).find((f) => f.kind === "cut" && f.sha256 === sha && !f.replaced_at) ?? null;
}

async function eligible(contentId: string, dataDir: string, cutSha?: string): Promise<{ content: Content; doc: ProductionDoc; cut: Fact } | null> {
  if (!(await isOntologyActive(dataDir, contentId))) return null;
  const content = await getContent(contentId, dataDir);
  if (!content || content.deletedAt || !isVideoPlatform(content.platform)) return null;
  const doc = await readProductionDocOrEmpty(contentId, dataDir);
  const cut = cutSha ? cutOf(doc, cutSha) : currentCut(doc);
  if (!cut || publishReceipts(doc).live.length || content.status === "published") return null;
  if (validCutApproval(doc, content.body)?.sha256 === cut.sha256) return null;
  return { content, doc, cut };
}

export interface CheckRun { check: SliverCheck; fingerprint: string }

/**
 * 跑一次（有同指纹的确定结果就直接用）。返回当前指纹与对应结果；不该查返回 null。
 * 结果写入按条件落：轮次、成片、工程记录、A-roll 在跑的途中变了就丢掉。
 */
export async function runSliverCheck(contentId: string, dataDir: string, cutSha?: string): Promise<CheckRun | null> {
  const ctx = await eligible(contentId, dataDir, cutSha);
  if (!ctx) return null;
  const { content, doc, cut } = ctx;
  let inputs: Inputs;
  try { inputs = await evaluate(content, doc, cut, dataDir); }
  catch { inputs = { fingerprint: sha256(`${CHECKER_VERSION}:${cut.sha256}:error:${Date.now()}`), snapshotSha: null, arollIds: [], ccId: null, outcome: { status: "unchecked", slivers: [], reason: "检查时读文件出错" }, transient: true, fps: null }; }
  const prev = [...(doc.sliver_checks ?? [])].reverse().find((c) => c.round === doc.round && c.cut_sha === cut.sha256);
  const slivers = inputs.outcome.status === "slivers" ? withSuggestions(inputs.outcome.slivers, inputs.fps, await srtText(content, doc, cut.sha256!, dataDir)) : [];
  const next: Omit<SliverCheck, "id" | "checked_at"> = { round: doc.round, cut_sha: cut.sha256!, fingerprint: inputs.fingerprint, snapshot_sha: inputs.snapshotSha, aroll_ids: inputs.arollIds,
    version: CHECKER_VERSION, status: inputs.outcome.status, slivers, ...(inputs.outcome.reason ? { reason: inputs.outcome.reason } : {}), ...(inputs.transient ? { transient: true as const } : {}) };
  if (prev && sameResult(prev, next)) return { check: prev, fingerprint: inputs.fingerprint };
  // 同指纹的确定结果：结论不重算，只刷新修法建议（字幕后到时，§12-9）
  const refresh = prev && !prev.transient && prev.fingerprint === inputs.fingerprint && prev.status === next.status ? prev.id : null;
  const r = await mutateProduction(contentId, dataDir, (d) => {
    const stale = d.round !== doc.round || !cutOf(d, cut.sha256!) || (chatcutFact(d)?.id ?? null) !== (chatcutFact(doc)?.id ?? null)
      || arollFacts(d).map((f) => f.id).sort().join() !== arollFacts(doc).map((f) => f.id).sort().join();
    if (stale) return { value: null, events: [] };
    const kept = refresh ? d.sliver_checks?.find((c) => c.id === refresh) : undefined;
    if (kept) { kept.slivers = next.slivers; return { value: kept, events: [] }; }
    const check: SliverCheck = { id: newId("slv"), checked_at: new Date().toISOString(), ...next };
    d.sliver_checks = [...(d.sliver_checks ?? []), check].slice(-KEEP);
    return { value: check, events: [{ type: "sliver_checked", detail: { check_id: check.id, cut_sha: check.cut_sha, status: check.status, slivers: check.slivers.length, ...(check.reason ? { reason: check.reason } : {}) } }] };
  });
  return r.value ? { check: r.value, fingerprint: inputs.fingerprint } : null;
}

/** 触发点用：检查自己的异常已落成 unchecked；这里只兜写盘失败，回一句人话 */
export async function triggerSliverCheck(contentId: string, dataDir: string): Promise<string | null> {
  try { await runSliverCheck(contentId, dataDir); return null; } catch (e) { return `抽帧检查结果没写上：${e instanceof Error ? e.message : String(e)}`; }
}
