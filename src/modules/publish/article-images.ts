import { portableProjectRecord } from "../../storage/project-record.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { contentRoot, projectFile, readProjectRegistry } from "../../storage/content-project.js";
/**
 * 正文配图工作区：把稿件内 [IMAGE: ...] 变成可单独生成、预览、重做的持久资产。
 * 发布阶段只复用这里确认过的图片，不再把“排版/推草稿”变成一个看不见的生图黑箱。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { getContent, getDataDir } from "../../storage/local-store.js";
import { isContentId } from "../../storage/entity-id.js";
import { generateWechatImageAsset } from "./wechat-mp.js";
import { enrichBodyImagePrompt } from "./body-image-prompt.js";

export type ArticleImageStatus = "missing" | "generating" | "ready" | "error";
/** 图位来源（全媒体 spec §3.2）：gen = 走生图通道链生成；web = 官方来源图 / 我们自己截的公开页面，必须带来源链接 */
export type ArticleImageKind = "gen" | "web";
/** 写稿时请求的生图模型（创始人定的是 Codex Image 2.5）；Codex 通道报不出实际模型，只能记「未核实」 */
export const REQUESTED_IMAGE_MODEL = "Image 2.5";

export interface ArticleImageEntry {
  id: string;
  index: number;
  sourcePrompt: string;
  prompt: string;
  section?: string;
  bodyOffset: number;
  status: ArticleImageStatus;
  revision: number;
  imagePath?: string;
  error?: string;
  updatedAt?: string;
  /** 缺省视为 generated（历史条目无此字段）。research = 深调研素材导入。 */
  origin?: "generated" | "uploaded" | "research" | "web";
  /** origin=research 时的来源素材 id：用来认出「这一槽已经是这张图了」，避免重复导入空转。 */
  sourceAssetId?: string;
  /** 标记里写的图位来源；缺省 = gen（历史标记没有前缀） */
  kind?: ArticleImageKind;
  /** gen：实际出图的通道、请求的模型；modelStatus 如实标——codex 报不出模型 = unverified，中转出的不是 Image 2.5 = mismatch */
  provider?: string;
  requestedModel?: string;
  reportedModel?: string;
  modelStatus?: "unverified" | "mismatch";
  /** web：图片来源链接与图下署名（没有链接的 web 图不能过审） */
  sourceUrl?: string;
  credit?: string;
}

export interface ArticleImageReview {
  contentId: string;
  bodyFingerprint: string;
  entries: ArticleImageEntry[];
  updatedAt: string;
}

export interface ArticleImageMarker {
  index: number;
  /** 标记里的原文（含 gen: / web: 前缀），用来认旧条目 */
  prompt: string;
  kind: ArticleImageKind;
  /** 去掉前缀后的描述 */
  description: string;
  offset: number;
  section?: string;
}

function bodyFingerprint(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

export function parseArticleImageMarkers(body: string): ArticleImageMarker[] {
  return [...body.matchAll(/\[IMAGE:\s*(.+?)\]/g)]
    .map((match, index) => {
      const prompt = match[1]?.trim() ?? "";
      const offset = match.index ?? 0;
      const before = body.slice(0, offset);
      const headings = [...before.matchAll(/^#{1,4}\s+(.+)$/gm)];
      const section = headings.at(-1)?.[1]?.trim();
      const typed = /^(gen|web)\s*[:：]\s*/i.exec(prompt);
      const kind: ArticleImageKind = typed?.[1]?.toLowerCase() === "web" ? "web" : "gen";
      const description = typed ? prompt.slice(typed[0].length).trim() : prompt;
      return { index, prompt, kind, description, offset, ...(section ? { section } : {}) };
    })
    .filter((marker) => marker.prompt.length > 0);
}

function locations(contentId: string, dataDir?: string) {
  const root = contentRoot(contentId, dataDir);
  return {
    root,
    meta: projectFile(root, "article-images.json"),
    assets: projectFile(root, "assets", "article-images"),
  };
}

async function readReview(contentId: string, dataDir?: string): Promise<ArticleImageReview | null> {
  try {
    const loc = locations(contentId, dataDir);
    return portableProjectRecord(JSON.parse(await fs.readFile(loc.meta, "utf-8")), loc.root, true) as ArticleImageReview;
  } catch {
    return null;
  }
}

async function writeReview(
  contentId: string,
  review: Omit<ArticleImageReview, "updatedAt"> | ArticleImageReview,
  dataDir?: string,
): Promise<ArticleImageReview> {
  const loc = locations(contentId, dataDir);
  await fs.mkdir(loc.root, { recursive: true });
  const saved = { ...review, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(loc.meta, readProjectRegistry(dataDir) ? portableProjectRecord(saved, loc.root) : saved);
  return saved;
}

async function fileExists(filePath?: string): Promise<boolean> {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 根据当前正文同步标记；正文其他段落修改不会误删已生成配图。 */
export async function getArticleImageReview(contentId: string, dataDir?: string): Promise<ArticleImageReview> {
  if (!isContentId(contentId)) throw new Error("需要合法 content_id");
  const content = await getContent(contentId, dataDir);
  if (!content) throw new Error(`Content not found: ${contentId}`);
  const markers = parseArticleImageMarkers(content.body || "");
  const previous = await readReview(contentId, dataDir);
  const entries: ArticleImageEntry[] = [];

  for (const marker of markers) {
    const old = previous?.entries.find((entry) => entry.index === marker.index && entry.sourcePrompt === marker.prompt);
    const imageStillExists = old?.imagePath ? await fileExists(old.imagePath) : false;
    entries.push(old
      ? {
          ...old,
          bodyOffset: marker.offset,
          section: marker.section,
          // 生成失败留着「失败 + 原因」，不在下一次读时悄悄变回「还没有图」
          status: old.status === "generating" ? "generating" : imageStillExists ? old.status : old.status === "error" && !old.imagePath ? "error" : "missing",
          ...(imageStillExists ? {} : { imagePath: undefined, error: old.imagePath ? "图片文件已丢失，请重新生成" : old.error }),
        }
      : {
          id: `body-image-${marker.index + 1}`,
          index: marker.index,
          sourcePrompt: marker.prompt,
          prompt: marker.description,
          kind: marker.kind,
          section: marker.section,
          bodyOffset: marker.offset,
          status: "missing",
          revision: 0,
        });
  }

  const nextCore = { contentId, bodyFingerprint: bodyFingerprint(content.body || ""), entries };
  const previousCore = previous
    ? { contentId: previous.contentId, bodyFingerprint: previous.bodyFingerprint, entries: previous.entries }
    : null;
  if (!previous || JSON.stringify(nextCore) !== JSON.stringify(previousCore)) {
    return writeReview(contentId, nextCore, dataDir);
  }
  return previous;
}

async function updateEntry(
  review: ArticleImageReview,
  index: number,
  update: Partial<ArticleImageEntry>,
  dataDir?: string,
): Promise<ArticleImageReview> {
  const entries = review.entries.map((entry) => entry.index === index ? { ...entry, ...update } : entry);
  return writeReview(review.contentId, { ...review, entries }, dataDir);
}

export async function generateArticleImages(
  input: { contentId: string; index?: number; prompt?: string },
  dataDir?: string,
): Promise<{ ok: boolean; review: ArticleImageReview; generated: number; failed: number; errors?: string[]; degraded?: string[] }> {
  let review = await getArticleImageReview(input.contentId, dataDir);
  const targets = input.index === undefined
    ? review.entries.filter((entry) => entry.status !== "ready" && entry.kind !== "web")
    : review.entries.filter((entry) => entry.index === input.index);
  if (input.index !== undefined && targets.length === 0) throw new Error(`正文配图 ${input.index + 1} 不存在`);
  // web 图位只收真图（官方来源 / 自己截的公开页面）+ 来源链接，不拿生成图顶替
  if (targets.some((entry) => entry.kind === "web")) throw new Error(`配图 ${input.index! + 1} 是 web 图位：要截图或找官方图并带来源链接登记，不能生成`);

  let generated = 0;
  const errors: string[] = [];
  // 走了备用通道就要说出来:图出来了不代表主通道没坏,不说等于把故障闷掉
  const degradations = new Set<string>();
  const loc = locations(input.contentId, dataDir);
  await fs.mkdir(loc.assets, { recursive: true });

  for (const target of targets) {
    const prompt = input.index === target.index && input.prompt?.trim() ? input.prompt.trim() : target.prompt;
    const revision = (target.revision ?? 0) + 1;
    review = await updateEntry(review, target.index, {
      prompt,
      status: "generating",
      revision,
      error: undefined,
      updatedAt: new Date().toISOString(),
    }, dataDir);
    const filename = `body-${String(target.index + 1).padStart(2, "0")}-r${revision}.png`;
    const outputPath = path.join(loc.assets, filename);
    const result = await generateWechatImageAsset(enrichBodyImagePrompt(prompt), outputPath, { dataDir, size: "16:9" });
    if (result.ok) {
      generated += 1;
      if (result.degraded) degradations.add(result.degraded);
      review = await updateEntry(review, target.index, {
        status: "ready",
        imagePath: outputPath,
        origin: "generated",
        ...genProvenance(result),
        error: undefined,
        updatedAt: new Date().toISOString(),
      }, dataDir);
    } else {
      const error = result.stderr || "生图服务没有返回图片";
      errors.push(`配图 ${target.index + 1}: ${error}`);
      review = await updateEntry(review, target.index, {
        status: "error",
        imagePath: undefined,
        provider: undefined, reportedModel: undefined, modelStatus: undefined,
        error,
        updatedAt: new Date().toISOString(),
      }, dataDir);
    }
  }
  return {
    ok: errors.length === 0,
    review,
    generated,
    failed: errors.length,
    ...(errors.length ? { errors } : {}),
    ...(degradations.size ? { degraded: [...degradations] } : {}),
  };
}

/** 谁出的图、请求的是什么模型；codex 报不出实际模型就如实记「未核实」，中转出的不是 Image 2.5 记「不一致」 */
function genProvenance(result: { provider?: string; providerKind?: "relay" | "codex"; model?: string }): Partial<ArticleImageEntry> {
  const codex = result.providerKind === "codex";
  return {
    provider: result.provider ?? "(未知通道)",
    requestedModel: REQUESTED_IMAGE_MODEL,
    reportedModel: codex ? undefined : result.model,
    modelStatus: codex || !result.model ? "unverified" : result.model === REQUESTED_IMAGE_MODEL ? undefined : "mismatch",
    sourceUrl: undefined,
    credit: undefined,
  };
}

export const MAX_UPLOAD_IMAGE_BYTES = 5 * 1024 * 1024;

/** 扩展名以字节魔数为准——文件名只是用户给的提示，不可信。 */
function sniffImageExt(bytes: Buffer): "png" | "jpg" | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}

/** 图片来源标注：用户上传（缺省）或深调研素材导入。校验对两者一视同仁。 */
export interface ArticleImageProvenance {
  origin: "uploaded" | "research" | "web";
  sourceAssetId?: string;
  /** origin=web 必带：来源链接（http/https）与图下署名 */
  sourceUrl?: string;
  credit?: string;
}

/** web 图的来源：链接必须是 http(s)，署名不能空——缺了就拒，不留一张来路不明的图 */
function checkWebProvenance(p: ArticleImageProvenance): void {
  if (p.origin !== "web") return;
  let url: URL | null = null;
  try { url = new URL(String(p.sourceUrl ?? "").trim()); } catch { url = null; }
  if (!url || !/^https?:$/.test(url.protocol)) throw new Error("web 图必须带来源链接（http/https 开头）");
  if (!p.credit?.trim()) throw new Error("web 图必须带图下署名（来源名称），比如「图源：OpenAI 官网」");
}

/**
 * 外来图片顶进一个插图位——用户上传与深调研素材导入**共用这一条路**（同一套校验：
 * 生成中不许顶、非空、≤5MB、按字节魔数只收 png/jpg）。只收 png/jpg：webp 会在
 * 公众号推送的内容类型映射里静默失败。
 */
export async function attachUploadedArticleImage(
  contentId: string,
  index: number,
  bytes: Buffer,
  dataDir?: string,
  provenance: ArticleImageProvenance = { origin: "uploaded" },
): Promise<ArticleImageReview> {
  const review = await getArticleImageReview(contentId, dataDir);
  const entry = review.entries.find((candidate) => candidate.index === index);
  if (!entry) throw new Error(`正文配图 ${index + 1} 不存在`);
  // generateArticleImages 内存态整写 review——生成中放行上传会被静默覆写回去
  if (entry.status === "generating") throw new Error(`配图 ${index + 1} 正在生成中，等它完成再上传`);
  if (bytes.length === 0) throw new Error("图片内容为空");
  if (bytes.length > MAX_UPLOAD_IMAGE_BYTES) throw new Error("图片超过 5MB 上限，请压缩后再传");
  const ext = sniffImageExt(bytes);
  if (!ext) throw new Error("仅支持 PNG/JPG 图片（按文件内容识别；webp 公众号推送不支持）");
  checkWebProvenance(provenance);

  const loc = locations(contentId, dataDir);
  await fs.mkdir(loc.assets, { recursive: true });
  if (entry.imagePath && path.resolve(entry.imagePath).startsWith(path.resolve(loc.assets) + path.sep)) {
    await fs.rm(entry.imagePath, { force: true });
  }
  // revision 必须 +1:/api/asset 走 immutable 缓存,同名换内容会读到旧图
  const revision = (entry.revision ?? 0) + 1;
  const imagePath = path.join(loc.assets, `body-${String(index + 1).padStart(2, "0")}-r${revision}.${ext}`);
  await fs.writeFile(imagePath, bytes);
  return updateEntry(review, index, {
    status: "ready",
    imagePath,
    revision,
    origin: provenance.origin,
    sourceAssetId: provenance.sourceAssetId,
    sourceUrl: provenance.origin === "web" ? provenance.sourceUrl!.trim() : undefined,
    credit: provenance.origin === "web" ? provenance.credit!.trim() : undefined,
    provider: undefined, requestedModel: undefined, reportedModel: undefined, modelStatus: undefined,
    error: undefined,
    updatedAt: new Date().toISOString(),
  }, dataDir);
}

export async function removeArticleImage(contentId: string, index: number, dataDir?: string): Promise<ArticleImageReview> {
  let review = await getArticleImageReview(contentId, dataDir);
  const entry = review.entries.find((candidate) => candidate.index === index);
  if (!entry) throw new Error(`正文配图 ${index + 1} 不存在`);
  const loc = locations(contentId, dataDir);
  if (entry.imagePath && path.resolve(entry.imagePath).startsWith(path.resolve(loc.assets) + path.sep)) {
    await fs.rm(entry.imagePath, { force: true });
  }
  review = await updateEntry(review, index, { status: "missing", imagePath: undefined, error: undefined }, dataDir);
  return review;
}

/** 发布门：有标记就必须全部在正文配图区准备好，返回值按标记顺序对齐。 */
export async function preparedArticleImages(
  contentId: string,
  dataDir?: string,
): Promise<{ ok: true; paths: string[] } | { ok: false; missing: number[]; error: string }> {
  const review = await getArticleImageReview(contentId, dataDir);
  const missing: number[] = [];
  const paths: string[] = [];
  for (const entry of review.entries) {
    if (entry.status !== "ready" || !entry.imagePath || !(await fileExists(entry.imagePath))) {
      missing.push(entry.index + 1);
    } else {
      paths[entry.index] = entry.imagePath;
    }
  }
  if (missing.length > 0) {
    return { ok: false, missing, error: `正文配图尚未准备好：第 ${missing.join("、")} 张。请先在稿件的「正文配图」中生成或重做。` };
  }
  return { ok: true, paths };
}
