/**
 * 英文发布包（全媒体 spec Phase 3，创始人 2026-10-24 定方案 (b)）：英文版不走中文的登记（3:4+4:3 封面对），
 * 而是一个由创始人在「等你拍板」里批一次的整包，和公众号文章的整包批准同一个形状。包绑住：
 *   - 英文版这条稿审过的成片（字节 sha）和它的登记字幕；
 *   - 16:9 缩略图（登记时按像素核过，这里核字节）——它的批准就是这次整包批准；
 *   - 批过的英文脚本指纹、配音清单指纹（approved.ts / kit-context.ts）；
 *   - 勾了的每个英文平台的发布包（标题 / 描述 / 帖子正文 / tags / 章节）。
 * 批准记在 `en-package.json`；之后任何一样变了，批准就失效，「等你拍板」里重新出现这件、写明原因；发布出口一律拒。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { contentRoot, projectFile } from "../../storage/content-project.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { getContent, type Content, type VideoKit } from "../../storage/local-store.js";
import { readProductionDocOrEmpty, scriptApprovalFor } from "../../storage/production-store.js";
import type { Fact, ProductionDoc } from "../../storage/production-types.js";
import { videoKitFor } from "../../storage/video-kits.js";
import { approveArtifact, artifactHash, checkArtifactApproval, type ApprovalCheck, type ArtifactApproval } from "../lineage/artifact-approval.js";
import { fileOf } from "../production/publish-gate.js";
import { srtFor, validCutApproval } from "../production/derive.js";
import { loadProfile } from "../profile/creator-profile.js";
import { enKitPlatforms } from "../profile/platform-lines.js";
import { missingAsNull } from "../publish/review-gate/plan.js";
import { enKitBinding } from "./kit-context.js";
import { readEnThumbnail, thumbnailProblem, type EnThumbnail } from "./thumbnail.js";

export const PACKAGE_ARTIFACT = "英文发布包";

export interface EnPackageFile { approval?: ArtifactApproval; revisions?: Array<{ note: string; at: string }> }
export interface EnCut { path: string; sha256: string; durationMs: number | null; srtPath: string; srtSha: string }
export interface EnPackageState {
  content: Content;
  file: EnPackageFile;
  platforms: string[];
  cut: EnCut | null;
  thumbnail: EnThumbnail | null;
  kits: Record<string, VideoKit>;
  problems: string[];
  hash: string;
  approval: ApprovalCheck;
}

const fileFor = (id: string, dataDir: string) => projectFile(contentRoot(id, dataDir), "en-package.json");

export async function readEnPackageFile(id: string, dataDir: string): Promise<EnPackageFile> {
  try { return JSON.parse(await fs.readFile(fileFor(id, dataDir), "utf8")) as EnPackageFile; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`英文发布包读不出来（${(e as Error).message}）`);
  }
}

async function writeEnPackageFile(id: string, f: EnPackageFile, dataDir: string): Promise<void> {
  await fs.mkdir(path.dirname(fileFor(id, dataDir)), { recursive: true });
  await writeJsonAtomic(fileFor(id, dataDir), f);
}

const acceptedFact = (doc: ProductionDoc, kind: Fact["kind"], sha?: string) =>
  doc.facts.find((f) => f.round === doc.round && f.kind === kind && f.state === "accepted" && f.sha256 === sha && !f.replaced_at);

/** 英文版这条稿自己审过的成片 + 它的字幕（字节现算） */
async function approvedCut(content: Content, dataDir: string): Promise<EnCut | string> {
  const doc = await readProductionDocOrEmpty(content.id, dataDir);
  // 认稿要现在仍有效：撤批 / 重开（回到待认稿）之后，哪怕各项指纹都没变也不能发
  if (!scriptApprovalFor(doc, content.body ?? "") || content.status === "draft_ready" || content.status === "revision") return "英文脚本的认稿现在不是有效的（被撤了或重开了）：重新认稿后再批发布包";
  const cut = validCutApproval(doc, content.body ?? "");
  if (!cut?.sha256) return "英文成片还没在「等你拍板」里审过（创始人要亲耳听）";
  const root = contentRoot(content.id, dataDir);
  const fact = acceptedFact(doc, "cut", cut.sha256);
  const video = await fileOf(root, fact, "英文成片", true);
  if (typeof video !== "string") return video.error;
  const srtFact = srtFor(doc, cut.sha256);
  if (!srtFact) return "审过的英文成片没有登记字幕：record kind:srt 绑这版成片";
  const srt = await fileOf(root, srtFact, "英文字幕", true);
  if (typeof srt !== "string") return srt.error;
  return { path: video, sha256: cut.sha256, durationMs: fact?.duration_ms ?? null, srtPath: srt, srtSha: srtFact.sha256! };
}

/** 勾了的每个平台都要有包，且包绑的脚本 / 配音就是现在批过的那份 */
function kitProblems(content: Content, platforms: string[], binding: { enScriptHash: string; enDubHash: string } | null): { kits: Record<string, VideoKit>; problems: string[] } {
  const kits: Record<string, VideoKit> = {};
  const problems: string[] = [];
  for (const p of platforms) {
    const k = videoKitFor(content, p);
    if (!k) { problems.push(`还没有 ${p} 的发布包：autocrew_pre_publish video_kit 交`); continue; }
    kits[p] = k;
    if (binding && (k.enScriptHash !== binding.enScriptHash || k.enDubHash !== binding.enDubHash)) problems.push(`${p} 的发布包是按旧的脚本 / 配音做的：重交`);
  }
  return { kits, problems };
}

const kitView = (k: VideoKit) => ({ postTitle: k.postTitle, caption: k.caption, tags: k.tags ?? [], chapters: k.chapters ?? [], enScriptHash: k.enScriptHash ?? null, enDubHash: k.enDubHash ?? null });

export async function enPackageState(id: string, dataDir: string): Promise<EnPackageState | { code: string; error: string }> {
  const content = await getContent(id, dataDir).catch(missingAsNull);
  if (!content || content.derivedFrom?.kind !== "en_edition") return { code: "not_en_edition", error: "这条不是由视频派生的英文版" };
  const [file, thumbnail, profile] = await Promise.all([readEnPackageFile(id, dataDir), readEnThumbnail(id, dataDir), loadProfile(dataDir)]);
  const platforms = enKitPlatforms(profile) as string[];
  const b = await enKitBinding(id, dataDir);
  const binding = "no" in b ? null : b.binding;
  const cut = await approvedCut(content, dataDir);
  const thumb = await thumbnailProblem(thumbnail);
  const k = kitProblems(content, platforms, binding);
  const problems = [...("no" in b ? [b.no.error] : []), ...(typeof cut === "string" ? [cut] : []), ...(thumb ? [thumb] : []), ...k.problems];
  const hash = artifactHash({
    cut: typeof cut === "string" ? null : { sha: cut.sha256, srt: cut.srtSha }, thumbnail: thumbnail?.sha256 ?? null, binding,
    kits: Object.fromEntries(Object.entries(k.kits).map(([p, x]) => [p, kitView(x)])),
  });
  const approval = problems.length ? ({ ok: false, code: "artifact_changed", reason: problems[0] } as ApprovalCheck) : checkArtifactApproval(file.approval, hash);
  return { content, file, platforms, cut: typeof cut === "string" ? null : cut, thumbnail, kits: k.kits, problems, hash, approval };
}

/** 批过、但现在对不上了：重新出现在「等你拍板」时说的原因；没批过 / 仍有效 = null */
export function reopenReason(s: EnPackageState): string | null {
  if (s.approval.ok || !s.file.approval) return null;
  return s.approval.reason;
}

export type Gate = { ok: true; hash: string } | { ok: false; code: string; error: string };

export async function enPackageApproveGate(id: string, dataDir: string, expected: string | undefined): Promise<Gate> {
  const s = await enPackageState(id, dataDir);
  if ("error" in s) return { ok: false, code: s.code, error: s.error };
  if (!expected || expected !== s.hash) return { ok: false, code: "stale", error: "英文发布包在给你看之后变了：重新看一眼预览再批" };
  if (s.problems.length) return { ok: false, code: "en_package_not_ready", error: `英文发布包还不能批：\n${s.problems.map((p, i) => `${i + 1}) ${p}`).join("\n")}` };
  return { ok: true, hash: s.hash };
}

export async function approveEnPackage(id: string, expected: string | undefined, dataDir: string): Promise<Record<string, unknown>> {
  const g = await enPackageApproveGate(id, dataDir, expected);
  if (!g.ok) return g;
  const file = await readEnPackageFile(id, dataDir);
  await writeEnPackageFile(id, { ...file, approval: approveArtifact(PACKAGE_ARTIFACT, g.hash) }, dataDir);
  return { ok: true, package_hash: g.hash };
}

/** 「还要改」：记下他的话，批准（若有）撤掉，等改完重看 */
export async function reviseEnPackage(id: string, note: string, dataDir: string): Promise<Record<string, unknown>> {
  const file = await readEnPackageFile(id, dataDir);
  const { approval: _drop, ...rest } = file;
  void _drop;
  await writeEnPackageFile(id, { ...rest, revisions: [...(file.revisions ?? []), { note, at: new Date().toISOString() }] }, dataDir);
  return { ok: true, note };
}

/** 发布出口的唯一核对：整包批准有效（含源没过期之外的一切） */
type NotApproved = { code: "en_package_not_approved"; error: string };

/**
 * 发布出口拿包的唯一入口：现算一次，必须已批、没有缺项、指纹就是批的那一份——三样都满足才交出这份状态。
 * 出口只用这里交出的这一份读文件和文案，不再另读第二次（两次之间变了就会拿旧指纹放行）。
 */
export async function approvedEnPackage(id: string, dataDir: string): Promise<{ s: EnPackageState } | { no: NotApproved }> {
  const no = (error: string) => ({ no: { code: "en_package_not_approved" as const, error } });
  const s = await enPackageState(id, dataDir);
  if ("error" in s) return no(s.error);
  if (!s.file.approval) return no("英文版要先批整个英文发布包（等你拍板里的那件：缩略图、各平台文案、章节、成片），批过才能发");
  if (s.problems.length) return no(`英文发布包的批准已失效（${s.problems[0]}）：重新批过再发`);
  if (!s.approval.ok || s.hash !== s.file.approval.hash) return no(`英文发布包的批准已失效（${s.approval.ok ? "包变了" : s.approval.reason}）：重新批过再发`);
  return { s };
}

export async function enPublishRefusal(id: string, dataDir: string): Promise<NotApproved | null> {
  const r = await approvedEnPackage(id, dataDir);
  return "no" in r ? r.no : null;
}
