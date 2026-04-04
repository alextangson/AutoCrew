/**
 * Tool Registry — single source of truth for all AutoCrew tool definitions.
 *
 * Used by both the OpenClaw plugin (index.ts) and the standalone server (start.ts).
 */
import { topicCreateSchema, executeTopicCreate } from "./topic-create.js";
import { researchSchema, executeResearch } from "./research.js";
import { contentSaveSchema, executeContentSave } from "./content-save.js";
import { statusSchema, executeStatus } from "./status.js";
import { assetSchema, executeAsset } from "./asset.js";
import { pipelineSchema, createPipelineExecutor } from "./pipeline.js";
import { publishSchema, executePublish } from "./publish.js";
import { humanizeSchema, executeHumanize } from "./humanize.js";
import { rewriteSchema, executeRewrite } from "./rewrite.js";
import { coverReviewSchema, executeCoverReview } from "./cover-review.js";
import { memorySchema, executeMemory } from "./memory.js";
import { reviewSchema, executeReview } from "./review.js";
import { prePublishSchema, executePrePublish } from "./pre-publish.js";
import { intelSchema, executeIntel } from "./intel.js";
import { pipelineOpsSchema, executePipelineOps } from "./pipeline-ops.js";
import { timelineSchema, executeTimeline } from "./timeline.js";
import { executeInit } from "./init.js";
import { getProStatus } from "../modules/pro/gate.js";
import { loadProfile, detectMissingInfo } from "../modules/profile/creator-profile.js";
import type { ToolRunner } from "../runtime/tool-runner.js";

export function registerAllTools(runner: ToolRunner): void {
  runner.register({
    name: "autocrew_topic",
    label: "AutoCrew Topic",
    description: "Create or list content topics. Actions: create, list.",
    parameters: topicCreateSchema,
    execute: executeTopicCreate,
  });

  runner.register({
    name: "autocrew_research",
    label: "AutoCrew Research",
    description:
      "Topic discovery with multiple modes: browser-first (Pro), API fallback, free (web search + viral scoring), or manual. " +
      "Supports action='discover' to generate/save topics and action='session_status' to inspect browser login readiness.",
    parameters: researchSchema,
    execute: executeResearch,
  });

  runner.register({
    name: "autocrew_content",
    label: "AutoCrew Content",
    description:
      "Manage content lifecycle: save drafts, list/get/update content, transition status, manage siblings and variants. " +
      "Actions: save, list, get, update, transition, list_siblings, create_variant.",
    parameters: contentSaveSchema,
    execute: executeContentSave,
  });

  runner.register({
    name: "autocrew_status",
    label: "AutoCrew Status",
    description: "Show pipeline status: topic count, content count, status breakdown.",
    parameters: statusSchema,
    execute: executeStatus,
  });

  runner.register({
    name: "autocrew_asset",
    label: "AutoCrew Asset",
    description:
      "Manage content project assets (covers, B-Roll, images, videos, subtitles) and version history. Actions: add, list, remove, versions, get_version, revert.",
    parameters: assetSchema,
    execute: executeAsset,
  });

  runner.register({
    name: "autocrew_pipeline",
    label: "AutoCrew Pipeline",
    description:
      "Workflow orchestration for content pipelines. Actions: create (from template), start, status, approve (paused step), cancel, list, templates.",
    parameters: pipelineSchema,
    execute: createPipelineExecutor(runner),
  });

  runner.register({
    name: "autocrew_publish",
    label: "AutoCrew Publish",
    description:
      "Run proven publishing flows. Actions: xiaohongshu_publish (API mode), douyin_publish, wechat_mp_draft, relay_publish (experimental).",
    parameters: publishSchema,
    execute: executePublish,
  });

  runner.register({
    name: "autocrew_humanize",
    label: "AutoCrew Humanize",
    description: "Run the Chinese de-AI pass on content text. Removes AI-sounding patterns and corporate buzzwords.",
    parameters: humanizeSchema,
    execute: executeHumanize,
  });

  runner.register({
    name: "autocrew_rewrite",
    label: "AutoCrew Rewrite",
    description:
      "Create platform-native rewrites. Actions: adapt_platform (single platform), batch_adapt (multi-platform + auto title/hashtag + sibling linking).",
    parameters: rewriteSchema,
    execute: executeRewrite,
  });

  runner.register({
    name: "autocrew_cover_review",
    label: "AutoCrew Cover Review",
    description:
      "Generate, review, and approve cover images via Gemini. Actions: create_candidates (generate 3 style variants), get (view review), approve (pick one), generate_ratios (Pro: 16:9 + 4:3).",
    parameters: coverReviewSchema,
    execute: executeCoverReview,
    needsGemini: true,
  });

  runner.register({
    name: "autocrew_memory",
    label: "AutoCrew Memory",
    description:
      "Capture user feedback into MEMORY.md or read current memory. Supports action='capture_feedback' and action='get_memory'.",
    parameters: memorySchema,
    execute: executeMemory,
  });

  runner.register({
    name: "autocrew_review",
    label: "AutoCrew Review",
    description:
      "Content review: sensitive words scan + quality score + de-AI check. Actions: full_review, scan_only, quality_score, auto_fix.",
    parameters: reviewSchema,
    execute: executeReview,
  });

  runner.register({
    name: "autocrew_pre_publish",
    label: "AutoCrew Pre-Publish",
    description: "Pre-publish gate: 6 checks before allowing publish. Actions: check.",
    parameters: prePublishSchema,
    execute: executePrePublish,
  });

  runner.register({
    name: "autocrew_intel",
    label: "AutoCrew 灵感源",
    description:
      "Inspiration source pipeline. Actions: pull (collect from web/RSS/trends), list (show saved inspiration), clean (archive expired).",
    parameters: intelSchema,
    execute: executeIntel,
  });

  runner.register({
    name: "autocrew_pipeline_ops",
    label: "AutoCrew Pipeline Ops",
    description:
      "Content pipeline lifecycle management. Actions: status (stage counts), start (topic→project), advance (next stage), version (add draft), trash, restore.",
    parameters: pipelineOpsSchema,
    execute: executePipelineOps,
  });

  runner.register({
    name: "autocrew_timeline",
    label: "AutoCrew Timeline",
    description:
      "Generate and manage video timelines. Actions: generate (parse marked script into timeline.json), get (retrieve timeline), update_segment (update segment status/asset), confirm_all (confirm all ready segments).",
    parameters: timelineSchema,
    execute: executeTimeline,
  });

  runner.register({
    name: "autocrew_init",
    label: "AutoCrew Init",
    description: "Initialize the AutoCrew data directory (~/.autocrew/) and creator profile. Safe to run multiple times.",
    parameters: { type: "object" as const, properties: {} },
    execute: async (params) => executeInit({ dataDir: params._dataDir as string }),
  });

  runner.register({
    name: "autocrew_pro_status",
    label: "AutoCrew Pro Status",
    description: "Check AutoCrew Pro status: whether Pro is active, profile completeness, and missing info.",
    parameters: { type: "object" as const, properties: {} },
    execute: async (params) => {
      const dir = params._dataDir as string;
      const proStatus = await getProStatus(dir);
      const profile = await loadProfile(dir);
      const missing = profile ? detectMissingInfo(profile) : ["profile_not_initialized"];
      return {
        ok: true,
        isPro: proStatus.isPro,
        profileExists: profile !== null,
        missingInfo: missing,
        styleCalibrated: profile?.styleCalibrated ?? false,
      };
    },
  });
}
