/**
 * record 的第 2–6 步（spec §3）：全部只读核验，产出落位计划。任何一步不过就拒，什么都不写（E21）。
 *
 * 顺序：路径（禁链接 / iCloud 占位）→ 形状（封面比例 / 字幕）→ 完整性（10 秒不变 + 时长）→ 同条幂等
 * → A-roll 独占 → 搬入授权（项目内 / 可搬入根 / 其他路径只记候选）→ 被 ChatCut 引用不挪。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { listContents, type Content } from "../../storage/local-store.js";
import { contentRoot } from "../../storage/content-project.js";
import type { Fact, ProductionDoc } from "../../storage/production-types.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { exportMatchesTitle } from "../video/unregistered-cut.js";
import { checkCover, checkDuration, resolveLocalFile, stableFingerprint, type FileIdentity } from "./files.js";
import type { Parsed, RecordArgs } from "./record-args.js";
import { classify, movableRoots, now, probe, type Location } from "./roots.js";
import { arollOwnerElsewhere } from "./sha-index.js";

export const MAX_COVER_VERSIONS = 30;

export type Action = "existing" | "in_place" | "move" | "clone" | "candidate";

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
}

const deny = <T>(code: string, error: string): Parsed<T> => ({ ok: false, code, error });

async function checkSrt(file: string): Promise<Parsed<void>> {
  if (![".srt", ".vtt"].includes(path.extname(file).toLowerCase())) return deny("srt_invalid", `字幕要是 .srt / .vtt：${file}`);
  const head = (await fs.readFile(file, "utf8").catch(() => "")).slice(0, 65_536);
  return head.includes("-->") ? { ok: true, value: undefined } : deny("srt_invalid", `字幕文件里没有时间轴（-->）：${file}`);
}

/** 形状 + 完整性（第 2–3 步）：返回真实路径、指纹、时长 / 比例 */
async function inspectFile(a: RecordArgs): Promise<Parsed<Pick<FilePlan, "source" | "sha256" | "id" | "duration_ms" | "ratio">>> {
  if (!a.path) return deny("bad_param", `kind=${a.kind} 要带 path`);
  const at = await resolveLocalFile(a.path, "path");
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

function coverVersion(a: RecordArgs, doc: ProductionDoc): Parsed<number | undefined> {
  if (a.kind !== "cover") return { ok: true, value: undefined };
  const versions = new Set(doc.facts.filter((f) => f.kind === "cover" && f.version).map((f) => f.version!));
  const version = a.version ?? Math.max(0, ...versions) + 1;
  if (!versions.has(version) && versions.size >= MAX_COVER_VERSIONS) return deny("cover_limit", `这条已经有 ${MAX_COVER_VERSIONS} 个封面版本了，先让创始人选或清掉旧版`);
  return { ok: true, value: version };
}

/** 被 ChatCut 工程引用的原片（显式 uses_aroll）不挪（§13-A） */
function referencedByChatcut(doc: ProductionDoc, fact: Fact | undefined): boolean {
  return Boolean(fact && inRound(doc).some((f) => f.kind === "chatcut_project" && f.uses_aroll?.includes(fact.id)));
}

/** A-roll 从可搬入根来：文件名前缀对上本条标题、且没对上别的在制视频稿（现有 L1 前缀规则） */
async function arollNameCheck(file: string, content: Content, dataDir: string): Promise<Parsed<void>> {
  const name = path.basename(file);
  if (!exportMatchesTitle(name, content.title)) {
    return deny("aroll_name_mismatch", `文件名「${name}」对不上这条的标题「${content.title}」：请按标题改名（标题-原片.mov）再报，或让创始人在卡片上挂载。后台转写比对还没上线。`);
  }
  const others = (await listContents(dataDir)).filter((c) => c.id !== content.id && isVideoPlatform(c.platform) && !c.deletedAt
    && c.status !== "archived" && c.status !== "published" && exportMatchesTitle(name, c.title));
  if (others.length) return deny("aroll_ambiguous", `文件名「${name}」同时对得上《${others.map((c) => c.title).join("》《")}》：请按完整标题改名，或让创始人挂载`);
  return { ok: true, value: undefined };
}

async function decideAction(a: RecordArgs, content: Content, doc: ProductionDoc, file: string, location: Location, existing: Fact | undefined, dataDir: string): Promise<Parsed<{ action: Action; evidence: string }>> {
  if (location === "project") return { ok: true, value: { action: "in_place", evidence: "已在本条项目里" } };
  if (a.kind === "aroll" && referencedByChatcut(doc, existing)) return { ok: true, value: { action: "in_place", evidence: "被 ChatCut 工程引用，留原位不挪" } };
  const movable = location === "inbox" || (location === "export" && a.kind !== "aroll");
  if (!movable) return { ok: true, value: { action: "candidate", evidence: `在可搬入目录之外（${path.dirname(file)}），等创始人确认` } };
  if (a.kind === "aroll") {
    const named = await arollNameCheck(file, content, dataDir);
    if (!named.ok) return named;
    return { ok: true, value: { action: "move", evidence: "收件箱里的原片，文件名对上标题" } };
  }
  return { ok: true, value: { action: "clone", evidence: location === "inbox" ? "收件箱" : "剪辑软件导出目录" } };
}

export async function planFileRecord(a: RecordArgs, content: Content, doc: ProductionDoc, dataDir: string): Promise<Parsed<FilePlan>> {
  const file = await inspectFile(a);
  if (!file.ok) return file;
  const existing = inRound(doc).find((f) => f.kind === a.kind && f.sha256 === file.value.sha256);
  if (existing?.state === "rejected") return deny("rejected_before", "创始人已经说过这个文件「不是这条」，不再收");
  const forCut = resolveForCut(a, doc);
  if (!forCut.ok) return forCut;
  const version = coverVersion(a, doc);
  if (!version.ok) return version;
  const projectRoot = await fs.realpath(contentRoot(content.id, dataDir));
  const base = { ...file.value, kind: a.kind, projectRoot, existing, ...(forCut.value ? { for_cut: forCut.value } : {}), ...(version.value ? { version: version.value } : {}) };
  if (a.kind === "aroll") {
    const owner = await arollOwnerElsewhere(dataDir, file.value.sha256, content.id);
    if (owner) return deny("aroll_conflict", `这个原片已经是另一条稿（${owner}）的 A-roll，一个原片只能属于一条稿`);
  }
  const location = classify(file.value.source, projectRoot, await movableRoots(dataDir));
  if (existing?.state === "accepted") return { ok: true, value: { ...base, location, action: "existing", evidence: "同一文件已经记过" } };
  const decided = await decideAction(a, content, doc, file.value.source, location, existing, dataDir);
  if (!decided.ok) return decided;
  return { ok: true, value: { ...base, location, ...decided.value } };
}
