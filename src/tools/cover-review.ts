/**
 * Cover Review Tool — generate, review, and approve cover images.
 *
 * Actions:
 * - create_candidates: generate 3 style variants (A/B/C) as 3:4 images
 * - get: retrieve existing cover review for a content
 * - approve: approve a selected variant
 * - generate_ratios: [Pro] generate 16:9 + 4:3 from approved cover
 */
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  getContent,
  getCoverReview,
  saveCoverReview,
  approveCoverVariant,
  type CoverReview,
  type CoverVariant,
} from "../storage/local-store.js";
import { buildCoverPrompts } from "../modules/cover/prompt-builder.js";
import { designCoverPlan, reviseCoverDesign } from "../modules/cover/designer.js";
import { generateWideCover } from "../modules/cover/wide-crop.js";
import { generateImage, listReferencePhotos, type GeminiModel } from "../adapters/image/gemini.js";
import { generateMultiRatio } from "../modules/cover/ratio-adapter.js";
import { getDataDir as resolveDataDir } from "../storage/local-store.js";

type CoverLabel = "a" | "b" | "c";

export const coverReviewSchema = Type.Object({
  action: Type.Unsafe<"create_candidates" | "get" | "approve" | "revise" | "platform_ratios" | "generate_ratios">({
    type: "string",
    enum: ["create_candidates", "get", "approve", "revise", "platform_ratios", "generate_ratios"],
    description:
      "Cover action: create_candidates (generate 3 covers), get (view review), approve (pick one), " +
      "revise (redo one variant per feedback), platform_ratios (2.35:1 for wechat_mp; 16:9/4:3 Pro), " +
      "generate_ratios (legacy Pro: 16:9 + 4:3).",
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
    Type.String({ description: "Override the auto-extracted cover title (2-8 Chinese chars)." }),
  ),
  feedback: Type.Optional(Type.String({ description: "Revision feedback in Chinese (for revise action)." })),
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

  // --- GENERATE RATIOS (Pro) ---
  if (action === "generate_ratios") {
    const apiKey = getGeminiApiKey(params);
    if (!apiKey) {
      return { ok: false, error: "Gemini API key required." };
    }

    const review = await getCoverReview(contentId, dataDir);
    if (!review) return { ok: false, error: `No cover review found for ${contentId}` };
    if (!review.approvedLabel) return { ok: false, error: "No variant approved yet. Run approve first." };

    const approved = review.variants.find((v) => v.label === review.approvedLabel);
    if (!approved?.imagePrompt) return { ok: false, error: "Approved variant has no prompt" };

    const model = getGeminiModel(params);
    const referencePhotos = approved.hasPersonalIP ? await listReferencePhotos(dataDir) : undefined;
    const assetsDir = path.join(dataDir, "contents", contentId, "assets", "covers");

    const result = await generateMultiRatio({
      originalPrompt: approved.imagePrompt,
      apiKey,
      model,
      referenceImagePaths: referencePhotos,
      outputDir: assetsDir,
      baseName: `cover-${approved.label}`,
      dataDir,
    });

    // Pro gate returned upgrade hint
    if ("upgradeHint" in result) return result;

    // Update variant with new paths
    if (result.paths["16:9"]) {
      approved.imagePaths = { ...approved.imagePaths, "16:9": result.paths["16:9"] };
    }
    if (result.paths["4:3"]) {
      approved.imagePaths = { ...approved.imagePaths, "4:3": result.paths["4:3"] };
    }

    await saveCoverReview(contentId, review, dataDir);

    return {
      ok: result.ok,
      paths: result.paths,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
  }

  return { ok: false, error: `Unknown action: ${action}` };
}

// ── 设计方案形状(设计师与规则版 prompt-builder 的公共面) ─────────────────────

interface DesignSpec {
  label: "A" | "B" | "C";
  style: string;
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

async function generateVariant(
  spec: DesignSpec,
  revision: number,
  opts: { apiKey: string; model: GeminiModel; referencePhotos: string[]; assetsDir: string },
): Promise<{ variant: CoverVariant } | { error: string }> {
  // 文件名带修订号:重生成必换名,浏览器 immutable 缓存永不脏读
  const outputPath = path.join(opts.assetsDir, `cover-${spec.label.toLowerCase()}-r${revision}`);
  const result = await generateImage({
    prompt: spec.imagePrompt,
    aspectRatio: "3:4",
    model: opts.model,
    apiKey: opts.apiKey,
    referenceImagePaths: opts.referencePhotos.length > 0 ? opts.referencePhotos : undefined,
    outputPath,
  });
  if (!result.ok) return { error: `${spec.label}: ${result.error}` };
  return {
    variant: {
      label: spec.label.toLowerCase() as CoverLabel,
      imagePrompt: spec.imagePrompt,
      style: spec.style,
      titleText: spec.titleText,
      imagePaths: { "3:4": result.imagePath },
      model: result.model,
      hasPersonalIP: opts.referencePhotos.length > 0,
      layoutHint: spec.layoutHint,
      designReason: spec.designReason ?? `${spec.style} 风格 — ${spec.layoutHint.slice(0, 60)}`,
      revision,
    },
  };
}

async function createCandidates(params: Record<string, unknown>, contentId: string, dataDir: string) {
  const apiKey = getGeminiApiKey(params);
  if (!apiKey) {
    return {
      ok: false,
      error: "Gemini API key required for cover generation.",
      hint: "免费获取：https://aistudio.google.com/apikey — 设置页「封面生成」或插件配置 gemini_api_key",
    };
  }
  const content = await getContent(contentId, dataDir);
  if (!content) return { ok: false, error: `Content ${contentId} not found` };

  const model = getGeminiModel(params);
  const referencePhotos = await listReferencePhotos(dataDir);
  const existing = await getCoverReview(contentId, dataDir);
  const revision = maxRevision(existing) + 1;
  const planInput = {
    title: content.title,
    body: content.body,
    platform: content.platform,
    hasReferencePhotos: referencePhotos.length > 0,
    customTitle: params.custom_title as string | undefined,
  };

  // LLM 设计师优先;引擎不可用/未提交时降级规则版——封面不能因引擎故障全断
  let specs: DesignSpec[];
  let designSource: "designer" | "rules" = "designer";
  try {
    specs = (await designCoverPlan(planInput, dataDir)).designs;
  } catch {
    designSource = "rules";
    specs = buildCoverPrompts(planInput);
  }

  const assetsDir = path.join(dataDir, "contents", contentId, "assets", "covers");
  const variants: CoverVariant[] = [];
  const errors: string[] = [];
  for (const spec of specs) {
    const generated = await generateVariant(spec, revision, { apiKey, model, referencePhotos, assetsDir });
    if ("error" in generated) errors.push(generated.error);
    else variants.push(generated.variant);
  }
  if (variants.length === 0) return { ok: false, error: "All 3 cover generations failed", details: errors };

  const review: CoverReview = {
    platform: content.platform || "xhs",
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
    designSource,
  };
}

async function reviseVariant(params: Record<string, unknown>, contentId: string, dataDir: string) {
  const apiKey = getGeminiApiKey(params);
  if (!apiKey) return { ok: false, error: "Gemini API key required." };
  const label = params.label as CoverLabel;
  const feedback = typeof params.feedback === "string" ? params.feedback.trim() : "";
  if (!label || !feedback) return { ok: false, error: "revise 需要 label(a/b/c) 与 feedback" };

  const [content, review] = await Promise.all([getContent(contentId, dataDir), getCoverReview(contentId, dataDir)]);
  if (!content) return { ok: false, error: `Content ${contentId} not found` };
  if (!review) return { ok: false, error: `No cover review found for ${contentId}` };
  const variant = review.variants.find((v) => v.label === label);
  if (!variant?.imagePrompt) return { ok: false, error: `Variant ${label} has no prompt to revise` };

  const referencePhotos = variant.hasPersonalIP ? await listReferencePhotos(dataDir) : [];
  const design = await reviseCoverDesign(
    {
      previous: {
        label: label.toUpperCase() as "A" | "B" | "C",
        style: variant.style ?? "cinematic",
        imagePrompt: variant.imagePrompt,
        titleText: variant.titleText ?? "",
        layoutHint: variant.layoutHint ?? "",
        designReason: variant.designReason ?? "",
      },
      feedback,
      title: content.title,
      hasReferencePhotos: referencePhotos.length > 0,
    },
    dataDir,
  );

  const revision = (variant.revision ?? 1) + 1;
  const assetsDir = path.join(dataDir, "contents", contentId, "assets", "covers");
  const generated = await generateVariant(design, revision, {
    apiKey,
    model: getGeminiModel(params),
    referencePhotos,
    assetsDir,
  });
  if ("error" in generated) return { ok: false, error: generated.error };

  const idx = review.variants.findIndex((v) => v.label === label);
  review.variants[idx] = generated.variant;
  review.feedback = [
    ...(review.feedback ?? []),
    { label, note: feedback, prevPrompt: variant.imagePrompt, at: new Date().toISOString() },
  ];
  // 修订过的方案若曾被选用,选用作废回待审
  if (review.approvedLabel === label) {
    review.status = "review_pending";
    delete review.approvedLabel;
    delete review.approvedImagePath;
    delete review.approvedAt;
  }
  const saved = await saveCoverReview(contentId, review, dataDir);
  if (!saved) return { ok: false, error: "Failed to save cover review" };
  return { ok: true, review: saved, revised: label, revision };
}

async function platformRatios(params: Record<string, unknown>, contentId: string, dataDir: string) {
  const apiKey = getGeminiApiKey(params);
  if (!apiKey) return { ok: false, error: "Gemini API key required." };

  const [content, review] = await Promise.all([getContent(contentId, dataDir), getCoverReview(contentId, dataDir)]);
  if (!review) return { ok: false, error: `No cover review found for ${contentId}` };
  if (!review.approvedLabel) return { ok: false, error: "No variant approved yet. Run approve first." };
  const approved = review.variants.find((v) => v.label === review.approvedLabel);
  if (!approved?.imagePrompt) return { ok: false, error: "Approved variant has no prompt" };

  const requested =
    Array.isArray(params.ratios) && params.ratios.length > 0
      ? (params.ratios as string[])
      : content?.platform === "wechat_mp"
        ? ["2.35:1"]
        : [];
  if (requested.length === 0) {
    return { ok: false, error: "没有要生成的比例(该平台无默认横版;显式传 ratios)" };
  }

  const model = getGeminiModel(params);
  const referencePhotos = approved.hasPersonalIP ? await listReferencePhotos(dataDir) : undefined;
  const assetsDir = path.join(dataDir, "contents", contentId, "assets", "covers");
  const baseName = `cover-${approved.label}-r${approved.revision ?? 1}`;
  const paths: Record<string, string> = {};
  const warnings: string[] = [];
  const errors: string[] = [];

  if (requested.includes("2.35:1")) {
    // 公众号是一等平台席位:2.35:1 不进 Pro 门
    const wide = await generateWideCover({
      originalPrompt: approved.imagePrompt,
      apiKey,
      model,
      referenceImagePaths: referencePhotos,
      outputDir: assetsDir,
      baseName,
    });
    if (wide.ok && wide.path) {
      approved.imagePaths = { ...approved.imagePaths, "2.35:1": wide.path };
      paths["2.35:1"] = wide.path;
      if (wide.warning) warnings.push(wide.warning);
    } else if (wide.error) {
      errors.push(`2.35:1: ${wide.error}`);
    }
  }

  if (requested.some((r) => r === "16:9" || r === "4:3")) {
    const result = await generateMultiRatio({
      originalPrompt: approved.imagePrompt,
      apiKey,
      model,
      referenceImagePaths: referencePhotos,
      outputDir: assetsDir,
      baseName,
      dataDir,
    });
    if ("upgradeHint" in result) {
      if (Object.keys(paths).length === 0 && errors.length === 0) return result;
      warnings.push(result.upgradeHint);
    } else {
      if (result.paths["16:9"]) {
        approved.imagePaths = { ...approved.imagePaths, "16:9": result.paths["16:9"] };
        paths["16:9"] = result.paths["16:9"];
      }
      if (result.paths["4:3"]) {
        approved.imagePaths = { ...approved.imagePaths, "4:3": result.paths["4:3"] };
        paths["4:3"] = result.paths["4:3"];
      }
      errors.push(...result.errors);
    }
  }

  await saveCoverReview(contentId, review, dataDir);
  return {
    ok: errors.length === 0,
    paths,
    warnings: warnings.length > 0 ? warnings : undefined,
    errors: errors.length > 0 ? errors : undefined,
  };
}
