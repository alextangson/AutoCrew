/**
 * record 的第 2–6 步（spec §3）：全部只读核验，产出落位计划。任何一步不过就拒，什么都不写（E21）。
 *
 * 顺序：路径（禁链接 / iCloud 占位）→ 形状（封面比例 / 字幕）→ 完整性（10 秒不变 + 时长）→ 同条幂等
 * → A-roll 独占 → 搬入授权（项目内 / 可搬入根 / 其他路径只记候选）→ 被 ChatCut 引用不挪。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Content } from "../../storage/local-store.js";
import { contentRoot } from "../../storage/content-project.js";
import { readLibraryLocation } from "../../storage/storage-roots.js";
import type { Fact, ProductionDoc } from "../../storage/production-types.js";
import { l1Strong } from "./match/l1.js";
import { admittedGroupKey, retiredGroupOfLabel, groupsOfFact, groupOfVersion, MAX_COVER_GROUPS, nextCoverVersion, slotTaken, validCoverGroups, versionLabelOf, type GroupKey } from "./cover-groups.js";
import { matchDeps } from "./match/deps.js";
import { arollPool } from "./match/pool.js";
import { pendingElsewhere, pendingElsewhereText } from "./match/reservation.js";
import { chatcutHold, inUseEvidence } from "./chatcut-refs.js";
import { checkCover, checkDuration, resolveLocalFile, stableFingerprint, type FileIdentity } from "./files.js";
import type { Parsed, RecordArgs } from "./record-args.js";
import { classify, movableRoots, now, probe, type Location } from "./roots.js";
import { arollOwnerElsewhere } from "./sha-index.js";


export type Action = "existing" | "in_place" | "move" | "clone" | "candidate" | "pending";

export interface FilePlan {
  action: Action;
  kind: Fact["kind"];
  source: string;
  sha256: string;
  id: FileIdentity;
  projectRoot: string;
  location: Location;
  evidence: string;
  existing?: Fact;
  duration_ms?: number;
  ratio?: Fact["ratio"];
  version?: number;
  for_cut?: string;
  /** cover：记进哪一组（review-inbox §6.1） */
  group?: GroupKey;
}

const deny = <T>(code: string, error: string): Parsed<T> => ({ ok: false, code, error });

async function checkSrt(file: string): Promise<Parsed<void>> {
  if (![".srt", ".vtt"].includes(path.extname(file).toLowerCase())) return deny("srt_invalid", `字幕要是 .srt / .vtt：${file}`);
  const head = (await fs.readFile(file, "utf8").catch(() => "")).slice(0, 65_536);
  return head.includes("-->") ? { ok: true, value: undefined } : deny("srt_invalid", `字幕文件里没有时间轴（-->）：${file}`);
}

/** 形状 + 完整性（第 2–3 步）：返回真实路径、指纹、时长 / 比例 */
async function inspectFile(a: RecordArgs, bases: string[]): Promise<Parsed<Pick<FilePlan, "source" | "sha256" | "id" | "duration_ms" | "ratio">>> {
  if (!a.path) return deny("bad_param", `kind=${a.kind} 要带 path`);
  const at = await resolveLocalFile(a.path, "path", bases);
  if (!at.ok) return at;
  let ratio: Fact["ratio"];
  if (a.kind === "cover") {
    const c = await checkCover(at.value, a.ratio);
    if (!c.ok) return c;
    ratio = c.value;
  }
  if (a.kind === "srt") {
    const s = await checkSrt(at.value);
    if (!s.ok) return s;
  }
  const fp = await stableFingerprint(at.value, now());
  if (!fp.ok) return fp;
  let duration_ms: number | undefined;
  if (a.kind === "aroll" || a.kind === "cut") {
    const d = await checkDuration(at.value, probe);
    if (!d.ok) return d;
    duration_ms = d.value;
  }
  return { ok: true, value: { source: at.value, sha256: fp.value.sha256, id: fp.value.id, ...(duration_ms ? { duration_ms } : {}), ...(ratio ? { ratio } : {}) } };
}

const inRound = (doc: ProductionDoc) => doc.facts.filter((f) => f.round === doc.round);

/** 字幕的所属成片：sha 或 fact id；不传 = 本轮最新 accepted 成片 */
function resolveForCut(a: RecordArgs, doc: ProductionDoc): Parsed<string | undefined> {
  if (a.kind !== "srt") return { ok: true, value: undefined };
  const cuts = inRound(doc).filter((f) => f.kind === "cut" && f.state === "accepted" && f.sha256);
  if (!a.for_cut) {
    const latest = cuts.sort((x, y) => y.at.localeCompare(x.at))[0];
    return latest ? { ok: true, value: latest.sha256 } : deny("cut_required", "还没有成片：先 record kind=cut 报成片，再报它的字幕（for_cut 填成片的 sha 或 fact id）");
  }
  const hit = cuts.find((f) => f.sha256 === a.for_cut || f.id === a.for_cut);
  return hit ? { ok: true, value: hit.sha256 } : deny("cut_required", `for_cut 对不上本轮任何一版成片：${a.for_cut}`);
}

/**
 * 封面落到哪一组（review-inbox §6.1）：显式成对才同组——pair_with 进那条事实的组、带 version 进那一版；
 * 都没有 = 自成一组（新版本号），不再凭「最新一版缺哪个比例」猜。同组同比例已有活成员 → 拒。
 */
function coverTarget(a: RecordArgs, doc: ProductionDoc, ratio: Fact["ratio"]): Parsed<{ version: number; group: GroupKey } | undefined> {
  if (a.kind !== "cover") return { ok: true, value: undefined };
  const full = () => validCoverGroups(doc).length >= MAX_COVER_GROUPS
    ? deny<never>("cover_limit", `这条已经有 ${MAX_COVER_GROUPS} 组封面了，先让创始人挑一组或在「等你拍板」里点「这组不要了」`) : null;
  if (a.pair_with) {
    // 单张认组只在它恰好属于一组时成立：同一张图在几组里就说不清配哪组，不猜（Codex 审 2a-1 r3 P1）
    const hits = groupsOfFact(doc, a.pair_with);
    if (hits.length > 1) return deny("pair_ambiguous", "这张封面在几组里都有，说不清配哪一组：用 paths 一次记一对");
    const g = hits[0];
    if (!g) return deny("pair_not_found", `pair_with 对不上本轮任何一组有效封面：${a.pair_with}（用 record 回执里的封面 fact_id）`);
    if (!g.group.version) return deny("pair_not_found", "那一组在 05-cover/final/ 里：把另一张直接放进 final/ 让对账收");
    if (ratio && slotTaken(doc, g.group, ratio)) return deny("cover_slot_taken", `那一组已经有 ${ratio} 了：换一组，或不带 pair_with 自成一组`);
    return { ok: true, value: { version: g.group.version, group: { label: g.group.label, version: g.group.version } } };
  }
  if (a.version) {
    if (retiredGroupOfLabel(doc, versionLabelOf(a.version))) return deny("cover_group_retired", `${versionLabelOf(a.version)} 那组已作废（「这组不要了」）：不带 version 放新一组`);
    const g = groupOfVersion(doc, a.version);
    if (g && ratio && slotTaken(doc, g, ratio)) return deny("cover_slot_taken", `${versionLabelOf(a.version)} 已经有 ${ratio} 了：换一个版本号，或用 paths 一次记一组`);
    if (!g) { const f = full(); if (f) return f; }
    return { ok: true, value: { version: a.version, group: { label: versionLabelOf(a.version), version: a.version } } };
  }
  const f = full();
  if (f) return f;
  const version = nextCoverVersion(doc);
  return { ok: true, value: { version, group: { label: versionLabelOf(version), version } } };
}

/** 被 ChatCut 工程引用的原片（显式 uses_aroll）不挪（§13-A） */
export function referencedByChatcut(doc: ProductionDoc, fact: Fact | undefined): boolean {
  return Boolean(fact && inRound(doc).some((f) => f.kind === "chatcut_project" && f.uses_aroll?.includes(fact.id)));
}

/**
 * A-roll 从收件箱来（1b §3-1）：统一 L1 强命中（1a 前缀规则或 matchL1 强命中）对上本条、且比对池里没有别条也强命中，
 * 才算授权直接搬入；否则 null 以外返回原因（交给转写核对或候选）。
 */
async function arollNameMiss(file: string, content: Content, dataDir: string): Promise<string | null> {
  const name = path.basename(file);
  const strong = (await arollPool(dataDir, content.id)).filter((p) => l1Strong(name, p.title));
  if (!strong.some((p) => p.content_id === content.id)) return `文件名「${name}」对不上标题`;
  const others = strong.filter((p) => p.content_id !== content.id);
  return others.length ? `文件名同时对得上《${others.map((p) => p.title).join("》《")}》` : null;
}

/** 收件箱原片名字没对上：转写就绪 → pending_match 后台核对；没就绪 → 只记候选并说原因（1b §3-2/3，E29） */
async function arollNotByName(miss: string, dataDir: string, from: string): Promise<{ action: Action; evidence: string }> {
  const t = matchDeps().transcriber;
  const notReady = t.notReady ? await t.notReady(dataDir).catch((e: unknown) => `检查转写环境失败：${e instanceof Error ? e.message : String(e)}`) : null;
  if (notReady) return { action: "candidate", evidence: `${from}：${miss}；转写环境没装好（${notReady}），只比了文件名，等创始人在卡片上确认是不是这条` };
  return { action: "pending", evidence: `${from}：${miss}，正在核对开头转写` };
}

/**
 * 搬入授权（§3-5/6）。被 ChatCut 引用只改变「已授权文件的落位方式」（留原位不挪），**不赋予归属**（Codex 审 P1）：
 * 不可搬入的路径、对不上标题的收件箱原片一律只记候选，等创始人确认。
 */
async function decideAction(a: RecordArgs, content: Content, doc: ProductionDoc, file: string, location: Location, existing: Fact | undefined, dataDir: string): Promise<Parsed<{ action: Action; evidence: string }>> {
  // 封面统一准入（review-inbox §6.2）：项目里不在 vNNN/ 或 final/ 的图克隆进新一组，不原地收
  if (location === "project" && a.kind === "cover" && !admittedGroupKey(path.relative(await fs.realpath(contentRoot(content.id, dataDir)), file))) return { ok: true, value: { action: "clone", evidence: "项目里其他目录的封面，克隆进这一组" } };
  if (location === "project") return { ok: true, value: { action: "in_place", evidence: "已在本条项目里" } };
  const movable = location === "inbox" || (location === "export" && a.kind !== "aroll") || (location === "watch" && a.kind === "aroll");
  if (!movable) return { ok: true, value: { action: "candidate", evidence: `在可搬入目录之外（${path.dirname(file)}），等创始人确认` } };
  if (a.kind === "aroll") {
    const miss = await arollNameMiss(file, content, dataDir);
    const from = location === "watch" ? "监视文件夹（允许直接搬入）" : "原片收件箱";
    if (miss) return { ok: true, value: await arollNotByName(miss, dataDir, from) };
    if (referencedByChatcut(doc, existing)) return { ok: true, value: { action: "in_place", evidence: "收件箱原片对上标题；已被 ChatCut 工程引用，留原位不挪" } };
    const hold = await chatcutHold(file);
    if (hold.project) return { ok: true, value: { action: "in_place", evidence: inUseEvidence(hold.project) } };
    // 核不了 ChatCut 引用（Codex 审 segB18 P2）：不挪，记候选并写原因
    if (hold.unverified) return { ok: true, value: { action: "candidate", evidence: `${from}：文件名对上标题，但${hold.unverified}` } };
    return { ok: true, value: { action: "move", evidence: "收件箱里的原片，文件名对上标题" } };
  }
  return { ok: true, value: { action: "clone", evidence: location === "inbox" ? "收件箱" : "剪辑软件导出目录" } };
}

/** 落位目标目录（项目内相对） */
export function targetDirOf(kind: Fact["kind"], version?: number): string {
  if (kind === "aroll") return "02-aroll";
  if (kind === "cover") return `05-cover/v${String(version).padStart(3, "0")}`;
  return "04-edit";
}

/**
 * 目标目录每一级都不能是符号链接、真实路径不能出项目（Codex 审 P1：02-aroll 指向库外时会搬到库外还报项目内路径）。
 * 只读检查，落位时（mkdir 之后）再核一次。
 */
export async function checkTargetDir(projectRoot: string, rel: string): Promise<Parsed<void>> {
  let current = projectRoot;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    const st = await fs.lstat(current).catch(() => null);
    if (!st) break;
    if (st.isSymbolicLink() || !st.isDirectory()) return deny("target_unsafe", `项目里的 ${path.relative(projectRoot, current)} 是符号链接或不是目录，不往那里放：请先改回普通文件夹`);
  }
  return { ok: true, value: undefined };
}

export async function planFileRecord(a: RecordArgs, content: Content, doc: ProductionDoc, dataDir: string): Promise<Parsed<FilePlan>> {
  const library = readLibraryLocation()?.root;
  const file = await inspectFile(a, [contentRoot(content.id, dataDir), ...(library ? [library] : [])]);
  if (!file.ok) return file;
  const existing = inRound(doc).find((f) => f.kind === a.kind && f.sha256 === file.value.sha256);
  if (existing?.state === "rejected") return deny("rejected_before", "创始人已经说过这个文件「不是这条」，不再收");
  const forCut = resolveForCut(a, doc);
  if (!forCut.ok) return forCut;
  const target = coverTarget(a, doc, file.value.ratio);
  if (!target.ok) return target;
  const version = { value: target.value?.version };
  const projectRoot = await fs.realpath(contentRoot(content.id, dataDir));
  const base = { ...file.value, kind: a.kind, projectRoot, existing, ...(forCut.value ? { for_cut: forCut.value } : {}), ...(version.value ? { version: version.value } : {}), ...(target.value ? { group: target.value.group } : {}) };
  if (a.kind === "aroll") {
    const owner = await arollOwnerElsewhere(dataDir, file.value.sha256, content.id);
    if (owner) return deny("aroll_conflict", `这个原片已经是另一条稿（${owner}）的 A-roll，一个原片只能属于一条稿；要改挂只能创始人在卡片上确认`);
    const pending = await pendingElsewhere(dataDir, file.value.sha256, content.id);
    if (pending) return deny("aroll_pending_elsewhere", `${pendingElsewhereText(pending.title)}：等那边核对完，对不上会转成候选`);
  }
  const location = classify(file.value.source, projectRoot, await movableRoots(dataDir), a.kind);
  if (existing?.state === "accepted") return { ok: true, value: { ...base, location, action: "existing", evidence: "同一文件已经记过" } };
  if (existing?.state === "pending_match") return { ok: true, value: { ...base, location, action: "existing", evidence: "这个原片正在核对，返回当前状态" } };
  const decided = await decideAction(a, content, doc, file.value.source, location, existing, dataDir);
  if (!decided.ok) return decided;
  if (decided.value.action === "move" || decided.value.action === "clone" || decided.value.action === "pending") {
    const safe = await checkTargetDir(projectRoot, targetDirOf(a.kind, version.value));
    if (!safe.ok) return safe;
  }
  return { ok: true, value: { ...base, location, ...decided.value } };
}
