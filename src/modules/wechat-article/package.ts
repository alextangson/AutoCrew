/**
 * 公众号文章的发布包（全媒体 spec §3.2、Phase 2a/2b）：标题候选与选定、创作来源声明、篇幅放行、封面（一张主图 + 两个裁切）、批准。
 *
 * 落在内容项目里的 `article-package.json`。批准 = 整包指纹（正文 + 选定标题 + 每张配图的文件和来源 +
 * 封面主图与两个裁切 + 创作来源），用 Phase 1 的 artifact-approval；批准之后任何一样变了，批准就失效，原因说得出是哪一包。
 * 只管由视频派生的公众号文章（derivedFrom.kind = wechat_article）；普通公众号稿不读这个文件。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { contentRoot, projectFile } from "../../storage/content-project.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { bodyHash } from "../../storage/production-store.js";
import type { Content } from "../../storage/local-store.js";
import { approveArtifact, artifactHash, checkArtifactApproval, type ApprovalCheck, type ArtifactApproval } from "../lineage/artifact-approval.js";
import type { ArticleImageEntry, ArticleImageReview } from "../publish/article-images.js";
import { ARTICLE_COVER_RATIOS, cropParam, type ArticleMasterCover } from "./cover.js";

export { ARTICLE_COVER_RATIOS, type ArticleCoverRatio } from "./cover.js";

/** 公众号「创作来源」的原选项，一字不改（spec §7a） */
export const CREATION_SOURCES = [
  "内容由AI生成", "素材来源官方媒体/网络新闻", "内容剧情演绎，仅供娱乐", "个人观点，仅供参考",
  "健康医疗分享，仅供参考", "投资观点，仅供参考", "无需声明",
] as const;
export type CreationSource = (typeof CREATION_SOURCES)[number];

export const ARTICLE_MIN_CHARS = 2500;
export const ARTICLE_MAX_CHARS = 4000;
export const APPROVAL_ARTIFACT = "公众号图文发布包";

export interface FounderWords { founderWords: string; at: string }
/** 2a 的旧形状（两张独立封面）：公众号只收一张封面，读到就拒，要求重登一张主图，不替他挑一张 */
export interface LegacyArticleCover { ratio: string; path: string; sha256: string }

export interface ArticlePackage {
  titleOptions: string[];
  chosenTitle?: string;
  titleChoice?: FounderWords;
  creationSource?: FounderWords & { value: CreationSource };
  /** 篇幅超出 2500–4000 时创始人的原话放行；只对放行那一刻的正文有效 */
  lengthOverride?: FounderWords & { bodyHash: string; chars: number };
  cover?: ArticleMasterCover;
  covers?: LegacyArticleCover[];
  approval?: ArtifactApproval;
  /** rebind 进行到一半（批准已撤、还没收尾）：绑到哪一版成片；重试 rebind 按它收尾，不当成「不用 rebind」 */
  rebindPending?: { toCut: string; at: string };
  /** 写作包用的底稿从哪来（成片字幕 / 退回定稿正文的原因）：领包时记下，审阅页照显示；不进指纹 */
  sourceNote?: string;
}

const EMPTY: ArticlePackage = { titleOptions: [] };

function file(contentId: string, dataDir?: string): string {
  return projectFile(contentRoot(contentId, dataDir), "article-package.json");
}

export async function readArticlePackage(contentId: string, dataDir?: string): Promise<ArticlePackage> {
  try {
    const raw = JSON.parse(await fs.readFile(file(contentId, dataDir), "utf-8")) as Partial<ArticlePackage>;
    return { ...EMPTY, ...raw, titleOptions: raw.titleOptions ?? [] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
    throw new Error(`公众号发布包读不出来（${(e as Error).message}）`);
  }
}

export async function writeArticlePackage(contentId: string, pkg: ArticlePackage, dataDir?: string): Promise<ArticlePackage> {
  const target = file(contentId, dataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeJsonAtomic(target, pkg);
  return pkg;
}

/** 正文中文字数：去掉配图标记，只数汉字（和写稿质量门同一口径） */
export function articleChars(body: string): number {
  return (body.replace(/\[IMAGE:[^\]]*\]/g, "").match(/[一-鿿]/g) ?? []).length;
}

export type LengthCheck = { ok: true; chars: number; overridden?: string } | { ok: false; chars: number; reason: string };

export function lengthCheck(body: string, pkg: ArticlePackage): LengthCheck {
  const chars = articleChars(body);
  if (chars >= ARTICLE_MIN_CHARS && chars <= ARTICLE_MAX_CHARS) return { ok: true, chars };
  const o = pkg.lengthOverride;
  if (o && o.bodyHash === bodyHash(body)) return { ok: true, chars, overridden: o.founderWords };
  const side = chars < ARTICLE_MIN_CHARS ? `少于 ${ARTICLE_MIN_CHARS}` : `超过 ${ARTICLE_MAX_CHARS}`;
  return { ok: false, chars, reason: `正文 ${chars} 字，${side} 字（公众号长文 ${ARTICLE_MIN_CHARS}–${ARTICLE_MAX_CHARS}）：改到范围内，或请创始人用原话放行` };
}

/** 有生成图就建议「内容由AI生成」；只是建议，必须创始人确认才写进包 */
export function suggestedCreationSource(review: Pick<ArticleImageReview, "entries">): CreationSource | null {
  return review.entries.some(isGenerated) ? "内容由AI生成" : null;
}

export const isGenerated = (e: ArticleImageEntry) => e.kind !== "web" && e.origin !== "web" && e.origin !== "uploaded" && e.origin !== "research";

/** 能不能批：缺什么、哪张图不行，逐条人话（空数组 = 可以批）。文件要读得到，声明要和现在的图对得上 */
export async function packageProblems(content: Pick<Content, "body">, pkg: ArticlePackage, review: Pick<ArticleImageReview, "entries">): Promise<string[]> {
  const out: string[] = [];
  if (pkg.titleOptions.length < 3 || pkg.titleOptions.length > 5) out.push(`标题候选要 3–5 个（现在 ${pkg.titleOptions.length} 个）`);
  else if (!pkg.chosenTitle || !pkg.titleOptions.includes(pkg.chosenTitle)) out.push("创始人还没从标题候选里选定一个");
  out.push(...declarationProblems(pkg, review));
  const len = lengthCheck(content.body ?? "", pkg);
  if (!len.ok) out.push(len.reason);
  out.push(...(await imageProblems(review.entries)), ...(await coverProblems(pkg)));
  return out;
}

function declarationProblems(pkg: ArticlePackage, review: Pick<ArticleImageReview, "entries">): string[] {
  const suggested = suggestedCreationSource(review);
  if (!pkg.creationSource) return [`创作来源还没请创始人确认${suggested ? "（有生成图，建议「内容由AI生成」）" : ""}`];
  if (pkg.creationSource.value === "无需声明" && review.entries.some((e) => e.status === "ready" && isGenerated(e))) {
    return ["文章里有 AI 生成的配图，创作来源不能是「无需声明」：请创始人改选（建议「内容由AI生成」）"];
  }
  return [];
}

export const LEGACY_COVER_PAIR = "包里还是 2a 的两张独立封面：公众号只收一张封面加两个裁切，请按 cover-generator 公众号段重出一张居中安全的主图，再 set_cover 登记一张主图（不会替你从两张里挑一张）";

async function coverProblems(pkg: ArticlePackage): Promise<string[]> {
  if (pkg.covers?.length) return [LEGACY_COVER_PAIR];
  if (!pkg.cover) return ["缺封面主图（一张，2.35:1 和 1:1 从它裁）"];
  if ((await fileSha(pkg.cover.path)) !== pkg.cover.sha256) return [`封面主图不见了或在登记后被改过（${pkg.cover.path}）：重新 set_cover`];
  return [];
}

async function imageProblems(entries: ArticleImageEntry[]): Promise<string[]> {
  const out: string[] = [];
  for (const e of entries) {
    const n = e.index + 1;
    const isWeb = e.kind === "web" || e.origin === "web";
    if (e.status === "error") out.push(`配图 ${n} 生成失败：${e.error ?? "没有原因"}`);
    else if (e.status !== "ready" || !e.imagePath) out.push(`配图 ${n} 还没有图`);
    else if ((await fileSha(e.imagePath)) === "missing") out.push(`配图 ${n} 的文件读不了：重新生成或登记`);
    else if (isWeb && !e.sourceUrl) out.push(`配图 ${n} 是 web 图但没有来源链接，不能过审`);
  }
  return out;
}

async function fileSha(p: string | undefined): Promise<string> {
  if (!p) return "missing";
  try { return createHash("sha256").update(await fs.readFile(p)).digest("hex"); } catch { return "missing"; }
}

/** 整包指纹：正文、选定标题、每张图（文件字节 + 来源）、封面主图（文件字节）+ 两个裁切、创作来源 */
export async function packageHash(content: Pick<Content, "body" | "derivedFrom">, pkg: ArticlePackage, review: Pick<ArticleImageReview, "entries">): Promise<string> {
  const images = [];
  for (const e of review.entries) images.push({ index: e.index, kind: e.kind ?? "gen", sha: await fileSha(e.imagePath), sourceUrl: e.sourceUrl, credit: e.credit });
  const c = pkg.cover;
  const cover = c ? { sha: await fileSha(c.path), crops: ARTICLE_COVER_RATIOS.map((r) => `${r}=${cropParam(c.crops[r])}`) } : null;
  const legacy = pkg.covers?.length ? pkg.covers.map((x) => x.sha256) : null;
  // rebind 过的稿把源成片身份也算进指纹：绑定一换，旧批准一定失效（哪怕撤批准那一步没落盘）。从没 rebind 过的不带，已有批准不受影响
  const sourceCut = content.derivedFrom?.rebound ? { sourceCut: content.derivedFrom.sourceCutHash } : {};
  return artifactHash({ body: content.body ?? "", title: pkg.chosenTitle ?? null, images, cover, legacy, creationSource: pkg.creationSource?.value ?? null, ...sourceCut });
}

export function approvePackage(pkg: ArticlePackage, hash: string, now = new Date()): ArticlePackage {
  return { ...pkg, approval: approveArtifact(APPROVAL_ARTIFACT, hash, now) };
}

export async function packageApprovalCheck(content: Pick<Content, "body" | "derivedFrom">, pkg: ArticlePackage, review: Pick<ArticleImageReview, "entries">): Promise<ApprovalCheck> {
  return checkArtifactApproval(pkg.approval, await packageHash(content, pkg, review));
}

const locks = new Map<string, Promise<unknown>>();

/** 同一篇文章的包改动与批准排队执行：批的那一刻包不会被另一个调用改掉。锁顺序：文件归属事务 → 这把锁 → 稿件写锁（见 en-edition/script.ts withEnLock） */
export function withArticleLock<T>(contentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(contentId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(contentId, tail);
  void tail.then(() => { if (locks.get(contentId) === tail) locks.delete(contentId); });
  return run;
}
