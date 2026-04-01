import path from "node:path";
import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import {
  approveCoverVariant,
  getContent,
  getCoverReview,
  saveCoverReview,
} from "../storage/local-store.js";

type CoverLabel = "a" | "b" | "c";

const DEFAULT_REFERENCE_POOL = "/Users/macmini/projects/Auto-redbook-skill/content/cover_reference_pool.json";

export const coverReviewSchema = Type.Object({
  action: Type.Unsafe<"create_candidates" | "get" | "approve">({
    type: "string",
    enum: ["create_candidates", "get", "approve"],
    description: "Cover review action: create candidates, get existing review, or approve a selected variant.",
  }),
  content_id: Type.String({ description: "AutoCrew content id." }),
  label: Type.Optional(
    Type.Unsafe<CoverLabel>({
      type: "string",
      enum: ["a", "b", "c"],
      description: "Selected cover label for approve.",
    }),
  ),
  reference_pool_path: Type.Optional(Type.String({ description: "Optional path to cover_reference_pool.json." })),
  notes: Type.Optional(Type.String({ description: "Optional review notes." })),
});

function buildHookText(titleMain?: string, titleSub?: string): string {
  if (titleMain && titleSub) return `${titleMain} / ${titleSub}`;
  return titleMain || titleSub || "";
}

async function loadReferencePool(referencePoolPath?: string) {
  const target = referencePoolPath || DEFAULT_REFERENCE_POOL;
  const raw = await fs.readFile(target, "utf-8");
  const parsed = JSON.parse(raw);
  return parsed.prototypes || [];
}

function pickVariantTriplet(prototypes: any[]) {
  const sameTrack = prototypes.find((item) => item.source_category === "same_track") || prototypes[0];
  const crossTrack = prototypes.find((item) => item.source_category === "cross_track") || prototypes[1] || sameTrack;
  const recent = prototypes
    .filter((item) => item.performance?.verdict === "keep")
    .sort((a, b) => (b.performance?.avg_impressions || 0) - (a.performance?.avg_impressions || 0))[0]
    || prototypes[2]
    || crossTrack;
  return [sameTrack, crossTrack, recent].filter(Boolean);
}

function buildCandidate(label: CoverLabel, prototype: any, contentTitle: string, contentBody: string) {
  const exampleHook = Array.isArray(prototype.cover_hook_examples) && prototype.cover_hook_examples.length > 0
    ? prototype.cover_hook_examples[0]
    : contentTitle.slice(0, 10);
  const titleMain = String(exampleHook).slice(0, 10) || contentTitle.slice(0, 10);
  const titleSub = contentBody.replace(/\s+/g, "").slice(0, 14) || "继续优化表达";

  return {
    label,
    titleMain,
    titleSub,
    titleLayout: "顶部双行",
    stopTrigger: prototype.click_mechanism || "具体结论先打停用户",
    designReason: prototype.why_it_works || "复用已验证封面原型",
    keyMoment: prototype.hook_pattern || "让用户一眼看到最关键的结果",
    hookText: buildHookText(titleMain, titleSub),
    imagePrompt: "",
    renderPrompt: "",
    seedreamPrompt: "",
    prototypeId: prototype.id,
    prototypeName: prototype.name,
    sourceCategory: prototype.source_category,
    imagePath: path.join(".autocrew", "contents", "pending", `cover-${label}.png`),
  };
}

export async function executeCoverReview(params: Record<string, unknown>) {
  const action = params.action as string;
  const contentId = params.content_id as string;
  const dataDir = (params._dataDir as string) || undefined;

  if (action === "get") {
    const review = await getCoverReview(contentId, dataDir);
    if (!review) {
      return { ok: false, error: `Cover review for ${contentId} not found` };
    }
    return { ok: true, review };
  }

  if (action === "approve") {
    const label = params.label as CoverLabel | undefined;
    if (!label) {
      return { ok: false, error: "label is required for approve" };
    }
    const approved = await approveCoverVariant(contentId, label, dataDir);
    if (!approved) {
      return { ok: false, error: `Failed to approve ${label} for ${contentId}` };
    }
    return { ok: true, review: approved };
  }

  if (action === "create_candidates") {
    const content = await getContent(contentId, dataDir);
    if (!content) {
      return { ok: false, error: `Content ${contentId} not found` };
    }

    const prototypes = await loadReferencePool((params.reference_pool_path as string) || undefined);
    if (!Array.isArray(prototypes) || prototypes.length === 0) {
      return { ok: false, error: "No cover prototypes available" };
    }

    const [a, b, c] = pickVariantTriplet(prototypes);
    const variants = [
      buildCandidate("a", a, content.title, content.body),
      buildCandidate("b", b, content.title, content.body),
      buildCandidate("c", c, content.title, content.body),
    ];

    const review = await saveCoverReview(
      contentId,
      {
        platform: "xiaohongshu",
        status: "review_pending",
        stopReason: "先用三个不同结构原型测试点击反应",
        coverHook: variants.map((item) => item.hookText).join(" | "),
        variants,
        notes: (params.notes as string) || undefined,
      },
      dataDir,
    );

    if (!review) {
      return { ok: false, error: `Failed to create cover review for ${contentId}` };
    }

    return { ok: true, review };
  }

  return { ok: false, error: `Unknown action: ${action}` };
}
