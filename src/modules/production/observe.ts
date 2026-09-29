/**
 * 对账的「看」（spec §4）：只读地收集一条内容在盘上有什么，产出观察结果；合并进 doc 是纯函数（`applyObservations`）。
 *
 * 项目内：02-aroll、04-edit（顶层）、05-cover/**（vNNN 按 cover-manifest；exports/ final/ review-* 等其余目录按像素比例）、
 * 07-delivery/**。旧存法：meta.assets 封面、execution.json 报到产物。它们都导入为 accepted（source=reconcile / legacy）。
 * 每条事实的 availability 按盘上现状更新；同一路径字节被覆盖 → 记 replaced_at（绑它的批准随之失效）。
 */
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

export const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v"]);
const SRT_EXT = new Set([".srt", ".vtt"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"]);
const VERSION_DIR = /^v0*(\d+)$/i;

export type Seen = Omit<Fact, "id" | "round" | "at" | "state" | "availability"> & { state: Fact["state"] };
export interface Observations { seen: Seen[]; availability: Map<string, { availability: Availability; replaced?: true; restored?: { size: number; mtime_ms: number } }> }

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

/** 05-cover：vNNN 走 cover-manifest（沿用 cover-scan），其余子目录与顶层按像素比例认 */
async function scanCovers(root: string): Promise<Seen[]> {
  const out: Seen[] = [];
  for (const a of await scanCoverFolder(root, 0)) {
    const ratio = a.role === COVER_ROLES["3:4"] ? "3:4" : "4:3";
    out.push({ kind: "cover", state: "accepted", source: "reconcile", evidence: `项目 ${path.dirname(a.path)}`, path: a.path, sha256: a.sha256, size: a.size, mtime_ms: a.mtime_ms, ratio, ...(a.version ? { version: a.version } : {}) });
  }
  const skip = (r: string) => VERSION_DIR.test(r.split(path.sep)[0]);
  for (const file of await listFiles(path.join(root, "05-cover"), true, skip)) {
    if (!IMAGE_EXT.has(ext(file))) continue;
    const ratio = await coverRatioOf(file).catch(() => null);
    if (ratio) out.push(await fileSeen(root, file, "cover", "reconcile", `项目 ${path.relative(root, path.dirname(file))}`, { ratio }));
  }
  return out;
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
async function availabilityOf(doc: ProductionDoc, root: string, archived: boolean): Promise<Observations["availability"]> {
  const out: Observations["availability"] = new Map();
  for (const f of doc.facts.filter((x) => x.path && x.sha256 && x.state !== "rejected")) {
    const file = path.isAbsolute(f.path!) ? f.path! : path.join(root, f.path!);
    try {
      await fs.access(file, fs.constants.R_OK);
      const st = await fs.stat(file);
      const same = st.size === f.size && Math.trunc(st.mtimeMs) === f.mtime_ms;
      const now = same ? f.sha256 : (await cachedSha(file)).sha256;
      const replaced = !f.replaced_at && now !== f.sha256;
      // 覆盖后又改回原字节（ABA）：这条事实恢复可用，绑它的批准按原样有效
      const restored = f.replaced_at && now === f.sha256 ? { size: st.size, mtime_ms: Math.trunc(st.mtimeMs) } : undefined;
      out.set(f.id, { availability: "present", ...(replaced ? { replaced: true as const } : {}), ...(restored ? { restored } : {}) });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      out.set(f.id, { availability: code === "ENOENT" ? (archived ? "archived" : "missing") : "unreadable" });
    }
  }
  return out;
}

export async function observeProject(content: Content, doc: ProductionDoc, root: string, dataDir: string, archived: boolean): Promise<Observations> {
  const seen = [
    ...(await executionSeen(content, root, dataDir)),
    ...(await assetCoversSeen(content, root, dataDir)),
    ...(await scanMedia(root, "02-aroll", false, "aroll")),
    ...(await scanMedia(root, "04-edit", false, "cut")),
    ...(await scanMedia(root, "07-delivery", true, "cut")),
    ...(await scanCovers(root)),
  ];
  attachForCut(seen, doc);
  return { seen, availability: await availabilityOf(doc, root, archived) };
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
  }
  const added: Fact[] = [];
  for (const s of obs.seen) {
    // 任何一轮记过都算：重开文稿后旧轮的成片 / 封面还在盘上，它们属于历史，不再导进新一轮
    const dup = doc.facts.find((f) => f.kind === s.kind && f.sha256 === s.sha256);
    // 去重时不丢新信息（Codex 审 P2）：本轮已有字幕没绑成片，这次算出了绑定就补上
    if (dup && dup.kind === "srt" && dup.round === doc.round && !dup.for_cut && s.for_cut) { dup.for_cut = s.for_cut; changed++; }
    if (dup || added.some((f) => f.kind === s.kind && f.sha256 === s.sha256)) continue;
    const state = s.kind === "aroll" && s.state === "accepted" && arollOwned(s.sha256!) ? "candidate" : s.state;
    added.push({ ...s, state, id: newId("fact"), round: doc.round, at, availability: "present" });
  }
  doc.facts.push(...added);
  return { added, changed: changed + added.length };
}
