/**
 * 对账的「看」（spec §4）：只读地收集一条内容在盘上有什么，产出观察结果；合并进 doc 是纯函数（`applyObservations`）。
 *
 * 项目内：02-aroll、04-edit（顶层）、05-cover/**（vNNN 按 cover-manifest；exports/ final/ review-* 等其余目录按像素比例）、
 * 07-delivery/**。旧存法：meta.assets 封面、execution.json 报到产物。它们都导入为 accepted（source=reconcile / legacy）。
 * 每条事实的 availability 按盘上现状更新；同一路径字节被覆盖 → 记 replaced_at（绑它的批准随之失效）。
 */
import { scanStoryboards } from "./storyboard.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { Content } from "../../storage/local-store.js";
import { projectFile } from "../../storage/content-project.js";
import type { Availability, Fact, ProductionDoc } from "../../storage/production-types.js";
import { newId, productionServiceDir } from "../../storage/production-store.js";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import { scanCoverFolder } from "../video/handoff/cover-scan.js";
import { COVER_ROLES, normalizeExecution } from "../video/handoff/execution-index.js";
import { sha256File } from "../video/handoff/manifest.js";
import { readProjectJson } from "../video/handoff/project-evidence.js";
import { coverRatioOf } from "./files.js";
import { addMember, admittedGroupKey, ensureGroup, retiredGroupOfLabel } from "./cover-groups.js";
import { strayCoverReason } from "./plain-reason.js";

export const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v"]);
const SRT_EXT = new Set([".srt", ".vtt"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"]);
const VERSION_DIR = /^v0*(\d+)$/i;

export type Seen = Omit<Fact, "id" | "round" | "at" | "state" | "availability"> & { state: Fact["state"] };
export interface Observations { warnings?: string[]; seen: Seen[]; availability: Map<string, { availability: Availability; replaced?: true; restored?: { size: number; mtime_ms: number }; moved?: { path: string; size: number; mtime_ms: number } }>;
  /** 封面组成员各自那份文件的状态（键：组 id + 事实 id） */
  members?: Map<string, "replaced" | "ok"> }

/**
 * 哈希缓存：按（dev, ino, 大小, 修改时间）认同一份字节。落盘到工作区服务目录的 hash-cache.json，
 * 重启后不必把每个 A-roll 重算一遍。它只是缓存：键对不上就重算，坏了当空。
 */
const hashCache = new Map<string, { key: string; sha: string }>();
let cacheDirty = false;

function cacheFile(dataDir: string): string {
  return productionServiceDir(dataDir, "hash-cache.json");
}

export async function loadHashCache(dataDir: string): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(cacheFile(dataDir), "utf8")) as Record<string, { key: string; sha: string }>;
    for (const [k, v] of Object.entries(raw)) if (!hashCache.has(k) && typeof v?.key === "string" && /^[a-f0-9]{64}$/.test(v.sha)) hashCache.set(k, v);
  } catch { /* 没有或坏了：当空缓存，照常重算 */ }
}

export async function saveHashCache(dataDir: string): Promise<void> {
  if (!cacheDirty) return;
  await writeJsonAtomicMkdir(cacheFile(dataDir), Object.fromEntries(hashCache));
  cacheDirty = false;
}

export async function cachedSha(file: string): Promise<{ sha256: string; size: number; mtime_ms: number }> {
  const st = await fs.stat(file);
  const key = `${st.dev}:${st.ino}:${st.size}:${Math.trunc(st.mtimeMs)}`;
  const hit = hashCache.get(file);
  const sha256 = hit?.key === key ? hit.sha : await sha256File(file);
  if (hit?.key !== key) { hashCache.set(file, { key, sha: sha256 }); cacheDirty = true; }
  return { sha256, size: st.size, mtime_ms: Math.trunc(st.mtimeMs) };
}

async function listFiles(dir: string, recursive: boolean, skip: (rel: string) => boolean = () => false, base = dir): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.name.startsWith(".") || skip(rel)) continue;
    if (e.isFile()) out.push(full);
    else if (e.isDirectory() && recursive) out.push(...(await listFiles(full, true, skip, base)));
  }
  return out;
}

const ext = (f: string) => path.extname(f).toLowerCase();

async function fileSeen(root: string, file: string, kind: Fact["kind"], source: Fact["source"], evidence: string, extra: Partial<Seen> = {}): Promise<Seen> {
  const h = await cachedSha(file);
  const inside = !path.relative(root, file).startsWith("..");
  return { kind, state: "accepted", source, evidence, path: inside ? path.relative(root, file) : file, ...h, ...extra };
}

/** 视频 / 字幕目录：video → cut（或 aroll），srt → srt */
async function scanMedia(root: string, rel: string, recursive: boolean, videoKind: "cut" | "aroll"): Promise<Seen[]> {
  const skip = (r: string) => r.startsWith("_作废-") || r === "autocrew-video" || r.startsWith(`autocrew-video${path.sep}`);
  const out: Seen[] = [];
  for (const file of await listFiles(path.join(root, rel), recursive, skip)) {
    if (VIDEO_EXT.has(ext(file))) out.push(await fileSeen(root, file, videoKind, "reconcile", `项目 ${rel}`));
    else if (videoKind === "cut" && SRT_EXT.has(ext(file))) out.push(await fileSeen(root, file, "srt", "reconcile", `项目 ${rel}`));
  }
  return out;
}

/**
 * 05-cover（review-inbox §6.2 统一准入）：vNNN/（有清单按清单，清单坏了报错、不退回全目录扫描）与 final/ 收为正式组；
 * 其余目录与顶层按比例找到的只做候选。
 */
async function scanCovers(root: string, warnings: string[]): Promise<Seen[]> {
  const out: Seen[] = [];
  for (const a of await scanCoverFolder(root, 0, { strict: true, errors: warnings })) {
    const ratio = a.role === COVER_ROLES["3:4"] ? "3:4" : "4:3";
    out.push({ kind: "cover", state: "accepted", source: "reconcile", evidence: `项目 ${path.dirname(a.path)}`, path: a.path, sha256: a.sha256, size: a.size, mtime_ms: a.mtime_ms, ratio, ...(a.version ? { version: a.version } : {}) });
  }
  const skip = (r: string) => VERSION_DIR.test(r.split(path.sep)[0]);
  for (const file of await listFiles(path.join(root, "05-cover"), true, skip)) {
    if (!IMAGE_EXT.has(ext(file))) continue;
    const ratio = await coverRatioOf(file).catch(() => null);
    if (!ratio) continue;
    const rel = path.relative(root, file);
    const admitted = admittedGroupKey(rel);
    // 登记时拷出的「封面-3x4.*」在 05-cover 顶层：它们的字节就是已批的那张，按 sha 去重，不另记
    out.push(await fileSeen(root, file, "cover", "reconcile", admitted ? `项目 ${path.dirname(rel)}` : strayCoverReason(rel), { ratio, ...(admitted ? {} : { state: "candidate" as const }) }));
  }
  return out;
}

/** 其他来源（execution.json、meta.assets）的封面按同一条准入：路径不在 vNNN/ 或 final/ → 候选 */
function admitCover(s: Seen): Seen {
  if (s.kind !== "cover" || s.state !== "accepted" || admittedGroupKey(s.path)) return s;
  return { ...s, state: "candidate", evidence: s.path && !path.isAbsolute(s.path) ? strayCoverReason(s.path) : "放在 AutoCrew 不会自动收的文件夹里，要你确认" };
}

/** 旧存法一：execution.json 报到的产物 */
async function executionSeen(content: Content, root: string, dataDir: string): Promise<Seen[]> {
  const exec = normalizeExecution(await readProjectJson<unknown>(content.id, "execution.json", dataDir).catch(() => null));
  const out: Seen[] = [];
  for (const a of exec?.artifacts ?? []) {
    const kind = a.role === "final-cut" || a.role === "final-cut-candidate" ? "cut" : a.role.startsWith("cover:") ? "cover" : /srt|subtitle/i.test(a.role) ? "srt" : null;
    if (!kind) continue;
    const file = path.isAbsolute(a.path) ? a.path : path.join(root, a.path);
    if (!(await fs.stat(file).then((s) => s.isFile(), () => false))) continue;
    const external = path.isAbsolute(a.path) && path.relative(root, file).startsWith("..");
    const ratio = a.role === COVER_ROLES["3:4"] ? "3:4" : a.role === COVER_ROLES["4:3"] ? "4:3" : undefined;
    out.push(await fileSeen(root, file, kind, "legacy", `execution.json 报到（${a.role}）`, { ...(ratio ? { ratio } : {}), ...(a.version ? { version: a.version } : {}), state: external ? "candidate" : "accepted" }));
  }
  return out;
}

/** 旧存法二：autocrew_asset add 挂的封面（只进了 meta.assets） */
async function assetCoversSeen(content: Content, root: string, dataDir: string): Promise<Seen[]> {
  const out: Seen[] = [];
  for (const a of (content.assets ?? []).filter((x) => x.type === "cover")) {
    const file = a.projectPath ? path.join(root, a.projectPath)
      : a.libraryPath ? path.join(dataDir, a.libraryPath) : projectFile(root, "assets", "covers", a.filename);
    if (!(await fs.stat(file).then((s) => s.isFile(), () => false))) continue;
    const ratio = await coverRatioOf(file).catch(() => null);
    if (ratio) out.push(await fileSeen(root, file, "cover", "legacy", "meta.assets 里的封面附件", { ratio }));
  }
  return out;
}

/** 字幕没说属于哪版成片：同目录同名的成片，否则全项目只有一版成片时就是它 */
function attachForCut(seen: Seen[], doc: ProductionDoc): void {
  const cuts = [...doc.facts.filter((f) => f.round === doc.round && f.kind === "cut" && f.state === "accepted"), ...seen.filter((s) => s.kind === "cut" && s.state === "accepted")];
  const stem = (p?: string) => (p ? p.slice(0, p.length - path.extname(p).length) : "");
  for (const s of seen.filter((x) => x.kind === "srt" && !x.for_cut)) {
    const twin = cuts.find((c) => stem(c.path) === stem(s.path));
    const only = new Set(cuts.map((c) => c.sha256)).size === 1 ? cuts[0] : undefined;
    const cut = twin ?? only;
    if (cut?.sha256) s.for_cut = cut.sha256;
  }
}

/** availability：缺失 / 读不了 / 已归档；字节被覆盖记 replaced */
/** 封面在别的组文件夹里还有一份字节没变的：事实改指那一份，不算被覆盖（同一张图在几个组里，整分支审 4 P2） */
async function intactCopy(doc: ProductionDoc, f: Fact, root: string): Promise<{ path: string; size: number; mtime_ms: number } | null> {
  if (f.kind !== "cover") return null;
  for (const m of (doc.cover_members ?? []).filter((x) => x.fact_id === f.id && x.path && x.path !== f.path)) {
    const h = await cachedSha(path.join(root, m.path!)).catch(() => null);
    if (h && h.sha256 === f.sha256) return { path: m.path!, size: h.size, mtime_ms: h.mtime_ms };
  }
  return null;
}

/** 每个封面组成员自己那份文件：字节变了 → replaced；改回原字节 → ok */
async function memberStates(doc: ProductionDoc, root: string): Promise<Map<string, "replaced" | "ok">> {
  const out = new Map<string, "replaced" | "ok">();
  for (const m of (doc.cover_members ?? []).filter((x) => x.path && !path.isAbsolute(x.path))) {
    const h = await cachedSha(path.join(root, m.path!)).catch(() => null);
    out.set(`${m.group_id}\u0000${m.fact_id}`, h?.sha256 === m.sha256 ? "ok" : "replaced");
  }
  return out;
}

async function availabilityOf(doc: ProductionDoc, root: string, archived: boolean): Promise<Observations["availability"]> {
  const out: Observations["availability"] = new Map();
  for (const f of doc.facts.filter((x) => x.path && x.sha256 && x.state !== "rejected")) {
    const file = path.isAbsolute(f.path!) ? f.path! : path.join(root, f.path!);
    const other = await intactCopy(doc, f, root);
    try {
      await fs.access(file, fs.constants.R_OK);
      const st = await fs.stat(file);
      const same = st.size === f.size && Math.trunc(st.mtimeMs) === f.mtime_ms;
      const now = same ? f.sha256 : (await cachedSha(file)).sha256;
      if (now !== f.sha256 && other) { out.set(f.id, { availability: "present", moved: other }); continue; }
      const replaced = !f.replaced_at && now !== f.sha256;
      // 覆盖后又改回原字节（ABA）：这条事实恢复可用，绑它的批准按原样有效
      const restored = f.replaced_at && now === f.sha256 ? { size: st.size, mtime_ms: Math.trunc(st.mtimeMs) } : undefined;
      out.set(f.id, { availability: "present", ...(replaced ? { replaced: true as const } : {}), ...(restored ? { restored } : {}) });
    } catch (e) {
      if (other) { out.set(f.id, { availability: "present", moved: other }); continue; }
      const code = (e as NodeJS.ErrnoException).code;
      out.set(f.id, { availability: code === "ENOENT" ? (archived ? "archived" : "missing") : "unreadable" });
    }
  }
  return out;
}

export async function observeProject(content: Content, doc: ProductionDoc, root: string, dataDir: string, archived: boolean): Promise<Observations> {
  const warnings: string[] = [];
  const seen = [
    ...(await executionSeen(content, root, dataDir)).map(admitCover),
    ...(await assetCoversSeen(content, root, dataDir)).map(admitCover),
    ...(await scanMedia(root, "02-aroll", false, "aroll")),
    ...(await scanMedia(root, "04-edit", false, "cut")),
    ...(await scanMedia(root, "07-delivery", true, "cut")),
    ...(await scanCovers(root, warnings)),
    // 分镜审阅页：只导入核验通过的（历史目录里大量中间文件，不合规的静默跳过，E11）
    ...(await scanStoryboards(root)).map((s): Seen => ({ kind: "storyboard", state: "accepted", source: "reconcile", evidence: `项目 ${path.dirname(s.rel)}`,
      path: s.rel, sha256: s.sha256, size: s.size, mtime_ms: s.mtime_ms, version: s.version, receipt_sha256: s.receipt_sha256 })),
  ];
  attachForCut(seen, doc);
  return { seen, warnings, availability: await availabilityOf(doc, root, archived), members: await memberStates(doc, root) };
}

/**
 * 把观察合并进 doc（就地改）：同条同 (sha, kind) 幂等（含历史轮与被拒的）；accepted 的 A-roll
 * 若已归别条稿则只记候选。返回新增 / 变更的条数。
 */
export function applyObservations(doc: ProductionDoc, obs: Observations, arollOwned: (sha: string) => boolean, at = new Date().toISOString()): { added: Fact[]; changed: number } {
  let changed = 0;
  for (const f of doc.facts) {
    const a = obs.availability.get(f.id);
    if (!a) continue;
    if (a.availability !== f.availability) { f.availability = a.availability; changed++; }
    if (a.replaced && !f.replaced_at) { f.replaced_at = at; changed++; }
    if (a.restored && f.replaced_at) { delete f.replaced_at; f.size = a.restored.size; f.mtime_ms = a.restored.mtime_ms; changed++; }
    if (a.moved) { f.path = a.moved.path; f.size = a.moved.size; f.mtime_ms = a.moved.mtime_ms; if (f.replaced_at) delete f.replaced_at; changed++; }
  }
  for (const m of doc.cover_members ?? []) {
    const st = obs.members?.get(`${m.group_id}\u0000${m.fact_id}`);
    if (st === "replaced" && !m.replaced_at) { m.replaced_at = at; changed++; }
    if (st === "ok" && m.replaced_at) { delete m.replaced_at; changed++; }
  }
  const added: Fact[] = [];
  const formal: Array<{ fact: Fact; path: string; first?: boolean }> = [];
  for (const s of obs.seen) {
    // 任何一轮记过都算：重开文稿后旧轮的成片 / 封面还在盘上，它们属于历史，不再导进新一轮
    const dup = doc.facts.find((f) => f.kind === s.kind && f.sha256 === s.sha256);
    // 去重时不丢新信息（Codex 审 P2）：本轮已有字幕没绑成片，这次算出了绑定就补上
    if (dup && dup.kind === "srt" && dup.round === doc.round && !dup.for_cut && s.for_cut) { dup.for_cut = s.for_cut; changed++; }
    const prior = dup ?? added.find((f) => f.kind === s.kind && f.sha256 === s.sha256);
    // 封面：事实按 sha 去重，但每一处正式目录（vNNN/ final/）的观察都要记成员关系——本批里后见到的、盘上已有的都算（Codex 审 2a-1 r3 P2）
    if (prior && s.kind === "cover" && s.state === "accepted" && admittedGroupKey(s.path) && prior.round === doc.round) formal.push({ fact: prior, path: s.path! });
    if (prior) continue;
    const state = s.kind === "aroll" && s.state === "accepted" && arollOwned(s.sha256!) ? "candidate" : s.state;
    const fact: Fact = { ...s, state, id: newId("fact"), round: doc.round, at, availability: "present" };
    added.push(fact);
    if (fact.kind === "cover" && fact.state === "accepted") formal.push({ fact, path: fact.path!, first: true });
  }
  doc.facts.push(...added);
  for (const o of formal) {
    const key = admittedGroupKey(o.path)!;
    // 先只做候选的图，之后在正式目录里见到同样字节 → 按 §6.2 收进那一组（只因正式目录，不因别处有同 sha 的 accepted）
    if (o.fact.state === "candidate" && o.fact.kind === "cover" && !retiredGroupOfLabel(doc, key.label)) {
      o.fact.state = "accepted";
      o.fact.path = o.path;
      o.fact.evidence = `项目 05-cover/${key.label}（先前只做候选，现在在正式目录里见到同样的图）`;
      changed++;
    }
    if (o.fact.state === "accepted") changed += groupSeenCover(doc, o.fact, o.path, at, o.first === true);
  }
  return { added, changed: changed + added.length };
}

/** 对账收下的正式封面按所在目录记进组；返回新加成员数 */
/**
 * 作废过的组所在目录：文件留在盘上，对账不按目录复活那组（成员关系历史还在，不另起新组）；
 * 之后新放进这个目录的图不自动成组，只做候选，等创始人确认（确认后自成新一组）。
 */
function groupSeenCover(doc: ProductionDoc, fact: Fact, rel: string | undefined, at: string, isNew = false): number {
  const key = admittedGroupKey(rel);
  if (!key) return 0;
  if (retiredGroupOfLabel(doc, key.label)) {
    if (isNew) { fact.state = "candidate"; fact.evidence = `${fact.evidence ?? ""}（05-cover/${key.label} 那组已点过「这组不要了」，新放进来的图只做候选）`; }
    return 0;
  }
  return addMember(doc, ensureGroup(doc, key, { source: "reconcile", evidence: `项目 05-cover/${key.label}` }, at), fact, at, rel) ? 1 : 0;
}
