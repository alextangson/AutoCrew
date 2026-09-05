/**
 * Cover Review Tool — generate, review, and approve cover images.
 *
 * Actions:
 * - create_candidates: generate 3 content-driven creative directions (A/B/C)
 * - get: retrieve existing cover review for a content
 * - approve: approve a selected variant
 * - generate_ratios: generate 16:9 + 4:3 from approved cover
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  getContent,
  getCoverReview,
  saveCoverReview,
  approveCoverVariant,
  transitionStatus,
  normalizeLegacyStatus,
  type CoverReview,
  type CoverVariant,
} from "../storage/local-store.js";
import { buildCoverPrompts } from "../modules/cover/prompt-builder.js";
import { designCoverPlan, reviseCoverDesign, type CoverDesign } from "../modules/cover/designer.js";
import { generateWideCover } from "../modules/cover/wide-crop.js";
import { generateImage, listReferencePhotos, type GeminiModel } from "../adapters/image/gemini.js";
import { generateCoverViaRelay, adaptCoverPrompt, type CoverAspect } from "../adapters/image/relay-cover.js";
import { resolveCoverProvider, GEMINI_HINT } from "../modules/cover/provider.js";
import { getDataDir as resolveDataDir } from "../storage/local-store.js";
import {
  loadCoverStyleProfile,
  selectCoverReferencePhotos,
  type CoverStyleProfile,
} from "../modules/cover/style-profile.js";
import {
  identityLockedOutpaintPrompt,
  localizedEditPrompt,
  prepareIdentityLockedOutpaint,
  prepareLocalizedEditMask,
  type NormalizedMaskRegion,
} from "../modules/cover/identity-outpaint.js";

type PrimaryRatio = "3:4" | "16:9" | "4:3" | "2.35:1";

type CoverLabel = "a" | "b" | "c";

export const coverReviewSchema = Type.Object({
  action: Type.Unsafe<"create_candidates" | "get" | "approve" | "revise" | "platform_ratios" | "generate_ratios">({
    type: "string",
    enum: ["create_candidates", "get", "approve", "revise", "platform_ratios", "generate_ratios"],
    description:
      "Cover action: create_candidates (generate 3 covers), get (view review), approve (pick one), " +
      "revise (full redraw or local masked edit via edit_mode), platform_ratios (identity-locked outpaint for personal IP; 2.35:1/16:9/4:3/3:4), " +
      "generate_ratios (legacy alias: 16:9 + 4:3).",
  }),
  content_id: Type.String({ description: "AutoCrew content id." }),
  label: Type.Optional(
    Type.Unsafe<CoverLabel>({
      type: "string",
      enum: ["a", "b", "c"],
      description: "Which variant to approve/revise.",
    }),
  ),
  custom_title: Type.Optional(
    Type.String({ description: "Override the auto-extracted cover title (2-9 Chinese chars)." }),
  ),
  ratio: Type.Optional(
    Type.Unsafe<"3:4" | "16:9" | "4:3" | "2.35:1">({
      type: "string",
      enum: ["3:4", "16:9", "4:3", "2.35:1"],
      description:
        "Primary ratio for create_candidates: 3:4 vertical (default); 16:9/4:3 landscape (bilibili, douyin PC); 2.35:1 ultra-wide banner (wechat_mp 公众号).",
    }),
  ),
  feedback: Type.Optional(Type.String({ description: "Revision feedback in Chinese (for revise action)." })),
  edit_mode: Type.Optional(
    Type.Unsafe<"full" | "local">({
      type: "string",
      enum: ["full", "local"],
      description: "Revision mode: full redraw, or local masked edit that locks every pixel outside mask_region.",
    }),
  ),
  mask_region: Type.Optional(
    Type.Object({
      x: Type.Number({ minimum: 0, maximum: 1 }),
      y: Type.Number({ minimum: 0, maximum: 1 }),
      width: Type.Number({ minimum: 0.02, maximum: 1 }),
      height: Type.Number({ minimum: 0.02, maximum: 1 }),
    }),
  ),
  ratios: Type.Optional(
    Type.Array(Type.String(), { description: 'Ratios for platform_ratios, e.g. ["2.35:1"] or ["16:9","4:3"].' }),
  ),
  _geminiApiKey: Type.Optional(Type.String()),
  _geminiModel: Type.Optional(Type.String()),
  _dataDir: Type.Optional(Type.String()),
});

function getDataDir(params: Record<string, unknown>): string {
  return resolveDataDir((params._dataDir as string) || undefined);
}

function getGeminiApiKey(params: Record<string, unknown>): string | null {
  return (params._geminiApiKey as string) || process.env.GEMINI_API_KEY || null;
}

function getGeminiModel(params: Record<string, unknown>): GeminiModel {
  const m = params._geminiModel as string;
  if (m === "imagen-4" || m === "gemini-native") return m;
  return "auto";
}

export async function executeCoverReview(params: Record<string, unknown>) {
  const action = params.action as string;
  const contentId = params.content_id as string;
  const dataDir = getDataDir(params);

  if (!contentId) return { ok: false, error: "content_id is required" };

  // --- GET ---
  if (action === "get") {
    const review = await getCoverReview(contentId, dataDir);
    if (!review) return { ok: false, error: `No cover review found for ${contentId}` };
    return { ok: true, review };
  }

  // --- APPROVE ---
  if (action === "approve") {
    const label = params.label as CoverLabel;
    if (!label) return { ok: false, error: "label (a/b/c) is required for approve action" };

    const result = await approveCoverVariant(contentId, label, dataDir);
    if (!result) return { ok: false, error: `Failed to approve variant ${label} for ${contentId}` };
    return { ok: true, review: result };
  }

  if (action === "create_candidates") return createCandidates(params, contentId, dataDir);
  if (action === "revise") return reviseVariant(params, contentId, dataDir);
  if (action === "platform_ratios") return platformRatios(params, contentId, dataDir);

  // --- GENERATE RATIOS(legacy MCP 动作名) ---
  // V5.6.1 创始人裁决:横屏(16:9/4:3)是一等需求,不再过 Pro 门——委托给 platform_ratios
  // (provider 感知:relay 中转直出,gemini 原生比例;同方案重渲染保风格统一)。
  if (action === "generate_ratios") {
    return platformRatios({ ...params, ratios: ["16:9", "4:3"] }, contentId, dataDir);
  }

  return { ok: false, error: `Unknown action: ${action}` };
}

// ── 设计方案形状(设计师与规则版 prompt-builder 的公共面) ─────────────────────

interface DesignSpec {
  label: "A" | "B" | "C";
  style: string;
  creativeConcept: string;
  visualMedium: string;
  palette: string;
  imagePrompt: string;
  titleText: string;
  layoutHint: string;
  designReason?: string;
}

/** 现有候选的最大修订号(旧数据无 revision 视为 1);新一轮候选 = max+1 */
function maxRevision(review: CoverReview | null): number {
  if (!review || review.variants.length === 0) return 0;
  return review.variants.reduce((m, v) => Math.max(m, v.revision ?? 1), 0);
}

// ── provider 分流(V5.6.1:默认中转 image2,Gemini 保留可选) ───────────────────

interface ProviderCtx {
  provider: "relay" | "gemini";
  relay: { apiKey: string; baseUrl: string; model: string } | null;
  geminiKey: string | null;
  geminiModel: GeminiModel;
  referencePhotos: string[];
  styleProfile: CoverStyleProfile | null;
}

/**
 * 局部编辑只有 3 个图像位：现有封面必须占 1 位，剩下两位固定留给
 * 真实身份锚点和用户选中的生成生活照。旧逻辑直接 slice 前三张，会把
 * 排在 identity/editorial 之后的 generated portrait 截掉，导致用户明明
 * 选过生活照，修脸时却永远看不到它。
 */
function localEditReferences(sourcePath: string, referencePhotos: string[]): string[] {
  const identity = referencePhotos[0];
  const generated = referencePhotos.find((item) => path.basename(path.dirname(item)) === "portraits");
  const fallback = referencePhotos.find((item) => item !== identity && item !== generated);
  return [...new Set([sourcePath, identity, generated ?? fallback].filter((item): item is string => Boolean(item)))].slice(0, 3);
}

/** 解析生图 provider;MCP 注入的 _geminiApiKey/_geminiModel 在 gemini 分支仍优先 */
async function resolveProviderCtx(
  params: Record<string, unknown>,
  dataDir: string,
): Promise<ProviderCtx | { ok: false; error: string; hint: string }> {
  const resolved = await resolveCoverProvider(dataDir);
  const geminiKey = getGeminiApiKey(params) ?? resolved.gemini.apiKey;
  const geminiModel: GeminiModel =
    typeof params._geminiModel === "string" ? getGeminiModel(params) : resolved.gemini.model;
  if (resolved.provider === "relay" && !resolved.relay) {
    return { ok: false, error: "中转生图未配置(封面生成需要)", hint: resolved.hint ?? "设置·发布 填生图 Key/端点" };
  }
  if (resolved.provider === "gemini" && !geminiKey) {
    return { ok: false, error: "Gemini API key required for cover generation.", hint: GEMINI_HINT };
  }
  const [referencePhotos, styleProfile] = await Promise.all([
    listReferencePhotos(dataDir),
    loadCoverStyleProfile(dataDir),
  ]);
  return {
    provider: resolved.provider,
    relay: resolved.relay,
    geminiKey,
    geminiModel,
    referencePhotos: selectCoverReferencePhotos(referencePhotos, styleProfile),
    styleProfile,
  };
}

/** 单张出图:relay 走中转(尺寸精裁在适配器内);gemini 原生 3:4/16:9/4:3(2.35:1 走 wide-crop 桥) */
async function renderCoverImage(
  imagePrompt: string,
  targetAspect: CoverAspect,
  outputPath: string,
  ctx: ProviderCtx,
  refs: string[],
  maskPath?: string,
): Promise<{ ok: boolean; imagePath?: string; model?: string; warning?: string; error?: string }> {
  if (ctx.provider === "relay" && ctx.relay) {
    const r = await generateCoverViaRelay({
      prompt: imagePrompt,
      targetAspect,
      referenceImagePaths: refs,
      ...(maskPath ? { maskPath } : {}),
      outputPath,
      relay: ctx.relay,
    });
    return r.ok
      ? { ok: true, imagePath: r.imagePath, model: r.model, ...(r.warning ? { warning: r.warning } : {}) }
      : { ok: false, error: r.error };
  }
  // gemini 无 2.35:1 原生比例:走 21:9 → 居中裁的 wide-crop 桥(与 platformRatios 同一实现)
  if (targetAspect === "2.35:1") {
    const wide = await generateWideCover({
      originalPrompt: imagePrompt,
      apiKey: ctx.geminiKey ?? "",
      model: ctx.geminiModel,
      referenceImagePaths: refs.length > 0 ? refs : undefined,
      outputDir: path.dirname(outputPath),
      baseName: path.basename(outputPath),
    });
    return wide.ok
      ? { ok: true, imagePath: wide.path, model: "gemini-wide", ...(wide.warning ? { warning: wide.warning } : {}) }
      : { ok: false, error: wide.error ?? "wide-crop 生成失败" };
  }
  const result = await generateImage({
    prompt: adaptCoverPrompt(imagePrompt, targetAspect),
    aspectRatio: targetAspect,
    model: ctx.geminiModel,
    apiKey: ctx.geminiKey ?? "",
    referenceImagePaths: refs.length > 0 ? refs : undefined,
    outputPath,
  });
  return result.ok
    ? { ok: true, imagePath: result.imagePath, model: result.model }
    : { ok: false, error: result.error };
}

async function generateVariant(
  spec: DesignSpec,
  revision: number,
  opts: { ctx: ProviderCtx; assetsDir: string; ratio: PrimaryRatio },
): Promise<{ variant: CoverVariant; warning?: string } | { error: string }> {
  // 文件名带修订号:重生成必换名,浏览器 immutable 缓存永不脏读;横屏主比例带后缀防与竖版撞名
  const suffix = opts.ratio === "3:4" ? "" : `-${opts.ratio.replace(":", "x")}`;
  const outputPath = path.join(opts.assetsDir, `cover-${spec.label.toLowerCase()}-r${revision}${suffix}`);
  const refs = opts.ctx.referencePhotos;
  const result = await renderCoverImage(spec.imagePrompt, opts.ratio, outputPath, opts.ctx, refs);
  if (!result.ok || !result.imagePath) return { error: `${spec.label}: ${result.error}` };
  // 参考图被中转降级时,人物一致性并未生效——hasPersonalIP 要如实
  const refApplied = refs.length > 0 && !(result.warning ?? "").includes("未带人物");
  return {
    variant: {
      label: spec.label.toLowerCase() as CoverLabel,
      imagePrompt: spec.imagePrompt,
      style: spec.style,
      creativeConcept: spec.creativeConcept,
      visualMedium: spec.visualMedium,
      palette: spec.palette,
      titleText: spec.titleText,
      imagePaths: { [opts.ratio]: result.imagePath } as CoverVariant["imagePaths"],
      model: result.model,
      hasPersonalIP: refApplied,
      layoutHint: spec.layoutHint,
      designReason: spec.designReason ?? `${spec.creativeConcept} · ${spec.layoutHint.slice(0, 60)}`,
      revision,
    },
    ...(result.warning ? { warning: `${spec.label}: ${result.warning}` } : {}),
  };
}

async function createCandidates(params: Record<string, unknown>, contentId: string, dataDir: string) {
  const ctx = await resolveProviderCtx(params, dataDir);
  if ("error" in ctx) return ctx;
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: `Content ${contentId} not found` };

  const existing = await getCoverReview(contentId, dataDir);
  const revision = maxRevision(existing) + 1;
  // 主比例:用户在生成入口按平台选;缺省竖屏 3:4。公众号超宽横幅 2.35:1 现为一等主比例(V5.6.5)。
  const PRIMARY_RATIOS: PrimaryRatio[] = ["3:4", "16:9", "4:3", "2.35:1"];
  const primaryRatio: PrimaryRatio = PRIMARY_RATIOS.includes(params.ratio as PrimaryRatio)
    ? (params.ratio as PrimaryRatio)
    : "3:4";
  const planInput = {
    title: content.title,
    body: content.body,
    platform: content.platform,
    hasReferencePhotos: ctx.referencePhotos.length > 0,
    customTitle: params.custom_title as string | undefined,
    targetAspect: primaryRatio,
    styleProfile: ctx.styleProfile,
  };

  // LLM 设计师优先;引擎不可用/未提交时降级规则版——封面不能因引擎故障全断
  let specs: DesignSpec[];
  let designSource: "designer" | "hybrid" | "rules" = "designer";
  try {
    specs = (await designCoverPlan(planInput, dataDir)).designs;
  } catch (err) {
    const fallback = buildCoverPrompts(planInput);
    const partial =
      err && typeof err === "object" && Array.isArray((err as { designs?: unknown }).designs)
        ? (err as { designs: CoverDesign[] }).designs
        : [];
    if (partial.length > 0) {
      const received = new Set(partial.map((design) => design.label));
      specs = [...partial, ...fallback.filter((spec) => !received.has(spec.label))].sort((a, b) =>
        a.label.localeCompare(b.label),
      );
      designSource = "hybrid";
    } else {
      designSource = "rules";
      specs = fallback;
    }
  }

  const assetsDir = path.join(dataDir, "contents", contentId, "assets", "covers");
  const variants: CoverVariant[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  // 3 张封面相互独立(不同 prompt/输出文件),并行出图——串行是纯浪费墙钟(3×→1×)。
  // 逐条结果按 specs 顺序回收,variants/errors 排序与串行版一致。
  // _onVariant:每出完一张就回调(进度事件,消掉"卡死"体感);MCP/测试不传则无操作。
  const onVariant =
    typeof params._onVariant === "function"
      ? (params._onVariant as (p: { done: number; total: number; label: string; ok: boolean }) => void)
      : undefined;
  const onPhase = typeof params._onPhase === "function" ? (params._onPhase as (label: string) => void) : undefined;
  let done = 0;
  const total = specs.length;
  // 设计(LLM)→出图 的交接点:并行出图前先报一声,别让这 ~90s 显得像卡死。
  onPhase?.(`设计方案已定，${total} 张并行出图中…`);
  const generatedAll = await Promise.all(
    specs.map((spec) =>
      generateVariant(spec, revision, { ctx, assetsDir, ratio: primaryRatio }).then((generated) => {
        done += 1;
        onVariant?.({ done, total, label: spec.label, ok: !("error" in generated) });
        return generated;
      }),
    ),
  );
  for (const generated of generatedAll) {
    if ("error" in generated) {
      errors.push(generated.error);
    } else {
      variants.push(generated.variant);
      if (generated.warning) warnings.push(generated.warning);
    }
  }
  if (variants.length === 0) return { ok: false, error: "All 3 cover generations failed", details: errors };

  const review: CoverReview = {
    platform: content.platform || "xhs",
    designSource,
    expectedVariantCount: specs.length,
    ...(errors.length > 0 ? { generationErrors: errors } : {}),
    primaryRatio,
    status: "review_pending",
    variants,
    ...(existing?.createdAt ? { createdAt: existing.createdAt } : {}),
    ...(existing?.feedback ? { feedback: existing.feedback } : {}),
  };
  const saved = await saveCoverReview(contentId, review, dataDir);
  if (!saved) return { ok: false, error: "Failed to save cover review" };
  return {
    ok: true,
    review: saved,
    generated: variants.length,
    failed: errors.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? [...new Set(warnings)] : undefined,
    designSource,
    provider: ctx.provider,
  };
}

/**
 * 撤销封面批准后的同步降级（阶段制 spec §1.2）：已经站在「待发布」的稿件，
 * 封面一作废就退回「封面设计」——不留「发布就绪但封面作废」这种错位态。
 *
 * force 是因为 publish_ready → cover_pending 不是状态图里的人工边（它是系统纠错，
 * 不该出现在推进下拉里）；阶段门对这条边没有规则，所以纠错永远做得成。
 * 返回一句话给调用方拿去 toast——状态被系统改了，人必须看得见。
 */
async function downgradeAfterRevoke(contentId: string, dataDir: string): Promise<string | null> {
  const content = await getContent(contentId, dataDir);
  if (!content || normalizeLegacyStatus(content.status) !== "publish_ready") return null;
  const moved = await transitionStatus(contentId, "cover_pending", { force: true }, dataDir);
  return moved.ok
    ? "封面选用已作废，这篇退回「封面设计」"
    : `封面选用已作废，但稿件状态没退回「封面设计」：${moved.error ?? "未知原因"}`;
}

async function reviseVariant(params: Record<string, unknown>, contentId: string, dataDir: string) {
  const ctx = await resolveProviderCtx(params, dataDir);
  if ("error" in ctx) return ctx;
  const label = params.label as CoverLabel;
  const feedback = typeof params.feedback === "string" ? params.feedback.trim() : "";
  if (!label || !feedback) return { ok: false, error: "revise 需要 label(a/b/c) 与 feedback" };

  const [content, review] = await Promise.all([getContent(contentId, dataDir), getCoverReview(contentId, dataDir)]);
  if (!content) return { ok: false, error: `Content ${contentId} not found` };
  if (!review) return { ok: false, error: `No cover review found for ${contentId}` };
  const variant = review.variants.find((v) => v.label === label);
  if (!variant?.imagePrompt) return { ok: false, error: `Variant ${label} has no prompt to revise` };

  const primaryRatio: PrimaryRatio = review.primaryRatio ?? "3:4";
  const revision = (variant.revision ?? 1) + 1;
  const assetsDir = path.join(dataDir, "contents", contentId, "assets", "covers");
  let generated: Awaited<ReturnType<typeof generateVariant>>;
  if (params.edit_mode === "local") {
    if (ctx.provider !== "relay" || !ctx.relay) {
      return { ok: false, error: "局部遮罩修订需要支持 mask 的 image2 中转；已拒绝整张重画" };
    }
    const region = params.mask_region as NormalizedMaskRegion | undefined;
    if (!region) return { ok: false, error: "局部修订需要先在封面上框选区域" };
    const sourcePath = variant.imagePaths[primaryRatio];
    if (!sourcePath) return { ok: false, error: `方案 ${label.toUpperCase()} 缺少 ${primaryRatio} 母版` };
    let workDir: string | undefined;
    try {
      const mask = await prepareLocalizedEditMask(sourcePath, region);
      workDir = mask.workDir;
      const suffix = primaryRatio === "3:4" ? "" : `-${primaryRatio.replace(":", "x")}`;
      const outputPath = path.join(assetsDir, `cover-${label}-r${revision}${suffix}`);
      const result = await renderCoverImage(
        localizedEditPrompt(variant.imagePrompt, feedback),
        primaryRatio,
        outputPath,
        ctx,
        localEditReferences(sourcePath, ctx.referencePhotos),
        mask.maskPath,
      );
      generated = result.ok && result.imagePath
        ? {
            variant: {
              ...variant,
              imagePaths: { [primaryRatio]: result.imagePath },
              revision,
              model: result.model,
              hasPersonalIP: true,
              designReason: `${variant.designReason ?? variant.creativeConcept ?? "局部修订"} · 框外像素锁定`,
            },
            ...(result.warning ? { warning: result.warning } : {}),
          }
        : { error: result.error ?? `${label.toUpperCase()}: 局部修订未返回图片` };
    } catch (err) {
      generated = {
        error: `${label.toUpperCase()}: 局部遮罩修订失败，已拒绝整张重画：${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    const design = await reviseCoverDesign(
      {
        previous: {
          label: label.toUpperCase() as "A" | "B" | "C",
          style: variant.style ?? "存量方案",
          creativeConcept: variant.creativeConcept ?? variant.designReason ?? "沿用存量方案的核心画面",
          visualMedium: variant.visualMedium ?? "legacy generated image",
          palette: variant.palette ?? "沿用存量配色",
          imagePrompt: variant.imagePrompt,
          titleText: variant.titleText ?? "",
          layoutHint: variant.layoutHint ?? "",
          designReason: variant.designReason ?? "",
        },
        feedback,
        title: content.title,
        hasReferencePhotos: ctx.referencePhotos.length > 0,
        targetAspect: primaryRatio,
        styleProfile: ctx.styleProfile,
      },
      dataDir,
    );
    generated = await generateVariant(design, revision, { ctx, assetsDir, ratio: primaryRatio });
  }
  if ("error" in generated) return { ok: false, error: generated.error };

  const idx = review.variants.findIndex((v) => v.label === label);
  review.variants[idx] = generated.variant;
  review.feedback = [
    ...(review.feedback ?? []),
    {
      label,
      note: params.edit_mode === "local" ? `局部遮罩：${feedback}` : feedback,
      prevPrompt: variant.imagePrompt,
      at: new Date().toISOString(),
    },
  ];
  // 修订过的方案若曾被选用,选用作废回待审
  const revoked = review.approvedLabel === label;
  if (revoked) {
    review.status = "review_pending";
    delete review.approvedLabel;
    delete review.approvedImagePath;
    delete review.approvedAt;
  }
  const saved = await saveCoverReview(contentId, review, dataDir);
  if (!saved) return { ok: false, error: "Failed to save cover review" };
  const statusNote = revoked ? await downgradeAfterRevoke(contentId, dataDir) : null;
  return {
    ok: true,
    review: saved,
    revised: label,
    revision,
    editMode: params.edit_mode === "local" ? "local" : "full",
    ...(statusNote ? { statusNote } : {}),
    ...(generated.warning ? { warnings: [generated.warning] } : {}),
  };
}

async function platformRatios(params: Record<string, unknown>, contentId: string, dataDir: string) {
  const ctx = await resolveProviderCtx(params, dataDir);
  if ("error" in ctx) return ctx;

  const [content, review] = await Promise.all([getContent(contentId, dataDir), getCoverReview(contentId, dataDir)]);
  if (!review) return { ok: false, error: `No cover review found for ${contentId}` };
  if (!review.approvedLabel) return { ok: false, error: "No variant approved yet. Run approve first." };
  const approved = review.variants.find((v) => v.label === review.approvedLabel);
  if (!approved?.imagePrompt) return { ok: false, error: "Approved variant has no prompt" };

  // 可适配比例(V5.6.1:横屏是一等需求,B站/抖音PC 收 16:9/4:3——不再过 Pro 门)。
  // 个人 IP + relay 不得整张重渲染：批准母版像素锁定，只 outpaint 新增画布；
  // 非人物方案或不支持 mask 的 Gemini 才沿用同 prompt 新比例重渲染。
  const ADAPT_RATIOS = ["2.35:1", "16:9", "4:3", "3:4"] as const;
  const primaryRatio: PrimaryRatio = review.primaryRatio ?? "3:4";
  const requestedRaw =
    Array.isArray(params.ratios) && params.ratios.length > 0
      ? (params.ratios as string[])
      : content?.platform === "wechat_mp"
        ? ["2.35:1"]
        : [];
  const requested = requestedRaw.filter(
    (r): r is CoverAspect => (ADAPT_RATIOS as readonly string[]).includes(r) && r !== primaryRatio,
  );
  if (requested.length === 0) {
    return { ok: false, error: `没有要生成的比例(主比例 ${primaryRatio} 已有;显式传 ratios,可选 2.35:1/16:9/4:3/3:4)` };
  }

  const refs = approved.hasPersonalIP ? ctx.referencePhotos : [];
  const approvedMaster =
    approved.imagePaths[primaryRatio] ??
    review.approvedImagePath ??
    approved.imagePaths["3:4"] ??
    approved.imagePaths["16:9"] ??
    approved.imagePaths["4:3"] ??
    approved.imagePaths["2.35:1"];
  const assetsDir = path.join(dataDir, "contents", contentId, "assets", "covers");
  const baseName = `cover-${approved.label}-r${approved.revision ?? 1}`;
  const paths: Record<string, string> = {};
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const ratio of requested) {
    const outputPath = path.join(
      assetsDir,
      `${baseName}-${ratio === "2.35:1" ? "235x1" : ratio.replace(":", "x")}`,
    );
    let r: { ok: boolean; imagePath?: string; warning?: string; error?: string };
    if (ctx.provider === "relay" && approved.hasPersonalIP && approvedMaster) {
      let workDir: string | undefined;
      try {
        const assets = await prepareIdentityLockedOutpaint(approvedMaster, ratio);
        workDir = assets.workDir;
        r = await renderCoverImage(
          identityLockedOutpaintPrompt(approved.imagePrompt, ratio),
          ratio,
          outputPath,
          ctx,
          [assets.canvasPath, ...refs].slice(0, 3),
          assets.maskPath,
        );
      } catch (err) {
        r = {
          ok: false,
          error: `个人 IP 锁定延展失败，已拒绝整张重画：${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      // Gemini 没有 2.35:1 原生比例 → 21:9 桥(wide-crop);其余统一走新比例重渲染。
      r =
        ctx.provider === "gemini" && ratio === "2.35:1"
          ? await generateWideCover({
              originalPrompt: approved.imagePrompt,
              apiKey: ctx.geminiKey ?? "",
              model: ctx.geminiModel,
              referenceImagePaths: refs.length > 0 ? refs : undefined,
              outputDir: assetsDir,
              baseName,
            }).then((wide) => ({ ok: wide.ok, imagePath: wide.path, warning: wide.warning, error: wide.error }))
          : await renderCoverImage(approved.imagePrompt, ratio, outputPath, ctx, refs);
    }
    if (r.ok && r.imagePath) {
      approved.imagePaths = { ...approved.imagePaths, [ratio]: r.imagePath };
      paths[ratio] = r.imagePath;
      if (r.warning) warnings.push(r.warning);
    } else if (r.error) {
      errors.push(`${ratio}: ${r.error}`);
    }
  }

  await saveCoverReview(contentId, review, dataDir);

  // 人机协同(V5.6.1):适配比例也在文件夹根留「拿了就走」副本(封面-16x9.png 等)
  const projDir = path.join(dataDir, "contents", contentId);
  for (const [ratio, p] of Object.entries(paths)) {
    const suffix = ratio === "2.35:1" ? "235x1" : ratio.replace(":", "x");
    await fs.copyFile(p, path.join(projDir, `封面-${suffix}${path.extname(p) || ".png"}`)).catch(() => {});
  }

  return {
    ok: errors.length === 0,
    paths,
    warnings: warnings.length > 0 ? warnings : undefined,
    errors: errors.length > 0 ? errors : undefined,
  };
}
