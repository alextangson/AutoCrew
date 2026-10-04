/**
 * AutoCrew — OpenClaw plugin entry point.
 *
 * Architecture:
 * - Runtime layer (ToolRunner + EventBus + Hooks) handles middleware, state, events
 * - Tools are registered once via ToolRunner, then bridged to OpenClaw API
 * - CLI commands call ToolRunner.execute() for consistent middleware behavior
 */
import { topicCreateSchema, executeTopicCreate } from "./src/tools/topic-create.js";
import { researchSchema, executeResearch } from "./src/tools/research.js";
import { contentSaveSchema, executeContentSave } from "./src/tools/content-save.js";
import { statusSchema, executeStatus } from "./src/tools/status.js";
import { assetSchema, executeAsset } from "./src/tools/asset.js";
import { pipelineSchema, executePipeline } from "./src/tools/pipeline.js";
import { publishSchema, executePublish } from "./src/tools/publish.js";
import { humanizeSchema, executeHumanize } from "./src/tools/humanize.js";
import { rewriteSchema, executeHostRewrite } from "./src/tools/rewrite.js";
import { coverReviewSchema, executeCoverReview } from "./src/tools/cover-review.js";
import { editorialSchema, executeEditorial, EDITORIAL_DESCRIPTION } from "./src/tools/editorial.js";
import { memorySchema, executeMemory } from "./src/tools/memory.js";
import { reviewSchema, executeReview } from "./src/tools/review.js";
import { prePublishSchema, executePrePublishTool } from "./src/tools/pre-publish.js";
import { dashboardSchema, executeDashboard } from "./src/tools/dashboard.js";
import { flywheelSchema, executeFlywheel } from "./src/tools/flywheel.js";
import { insightsSchema, executeInsights, INSIGHTS_DESCRIPTION } from "./src/tools/insights.js";
import { generateSchema, executeGenerate } from "./src/tools/generate.js";
import { styleSchema, executeHostStyle } from "./src/tools/style.js";
import { workflowSchema, executeWorkflow, WORKFLOW_DESCRIPTION } from "./src/tools/workflow.js";
import { scoutSchema, executeScout, SCOUT_DESCRIPTION } from "./src/tools/scout.js";
import { reviewDeskSchema, executeReviewDesk, REVIEW_DESK_DESCRIPTION } from "./src/tools/host-review.js";
import { writerSchema, executeWriter, WRITER_DESCRIPTION } from "./src/tools/writer.js";
import { deskSchema, executeDesk, DESK_DESCRIPTION } from "./src/tools/desk.js";
import { videoSchema, executeVideo, VIDEO_DESCRIPTION } from "./src/tools/video.js";
import { draftSchema, executeDraft, DRAFT_DESCRIPTION } from "./src/tools/draft.js";
import { executeInit } from "./src/tools/init.js";
import { getProStatus, saveProKey } from "./src/modules/pro/gate.js";
import { verifyKey } from "./src/modules/pro/api-client.js";
import { personaSummary, loadProfile, detectMissingInfo } from "./src/modules/profile/creator-profile.js";
import { createContext, type PluginConfig } from "./src/runtime/context.js";
import { ToolRunner } from "./src/runtime/tool-runner.js";
import { EventBus } from "./src/runtime/events.js";
import { HookManager } from "./src/runtime/hooks.js";
import { reviseDraft } from "./src/modules/writing/draft-revision.js";
import { aiContentWriteRefusal } from "./src/modules/research/angle-gate.js";

// --- Tool Registry ---

/** 单一能力注册源：OpenClaw、CLI runner 与 MCP 必须全部从这里取能力。 */
export function registerAutocrewCapabilities(runner: ToolRunner): void {
  runner.register({
    name: "autocrew_topic",
    label: "AutoCrew Topic",
    description:
      "Create or list content topics. Actions: create, list, radar_pool, radar_score. " +
      "Radar intake scored by you: radar_pool freezes the deduped candidate pool and returns pool_id, candidates and the scoring rubric; " +
      "score them on your own quota, then radar_score{pool_id, results} saves ≥70 (max 3 per pool) and returns a receipt — retrying the same results returns the same receipt.",
    parameters: topicCreateSchema,
    execute: executeTopicCreate,
  });

  runner.register({
    name: "autocrew_research",
    label: "AutoCrew Research",
    description:
      "Discover NEW topic candidates, not deep research for an existing writing request (use autocrew_workflow prepare for that). Modes: browser-first (Pro), API fallback, free (web search + viral scoring), or manual. " +
      "Supports action='discover' to generate/save topics and action='session_status' to inspect browser login readiness.",
    parameters: researchSchema,
    execute: executeResearch,
  });

  runner.register({
    name: "autocrew_content",
    label: "AutoCrew Content",
    description:
      "Manage existing content and explicit manual imports. For NEW AI-written drafts use autocrew_workflow prepare then autocrew_writer submit, never save directly. " +
      "Actions: save, list, get, update, transition, list_siblings, create_variant.",
    parameters: contentSaveSchema,
    execute: executeContentSave,
  });

  runner.register({
    name: "autocrew_workflow",
    label: "AutoCrew Workflow",
    description: WORKFLOW_DESCRIPTION,
    parameters: workflowSchema,
    execute: (params) => executeWorkflow(params),
  });

  runner.register({ name: "autocrew_scout", label: "AutoCrew Scout", description: SCOUT_DESCRIPTION, parameters: scoutSchema, execute: executeScout });
  // 灵感 → A-roll 薄路径（2026-10-04）：抖音口播新稿走它，旧的 workflow / writer 线留给其他平台
  runner.register({ name: "autocrew_draft", label: "AutoCrew Draft", description: DRAFT_DESCRIPTION, parameters: draftSchema, execute: executeDraft });
  runner.register({ name: "autocrew_review_desk", label: "AutoCrew Review Desk", description: REVIEW_DESK_DESCRIPTION, parameters: reviewDeskSchema, execute: executeReviewDesk });

  runner.register({
    name: "autocrew_writer",
    label: "AutoCrew Writer",
    description: WRITER_DESCRIPTION,
    parameters: writerSchema,
    execute: (params) => executeWriter(params),
  });

  runner.register({
    name: "autocrew_desk",
    label: "AutoCrew Desk",
    description: DESK_DESCRIPTION,
    parameters: deskSchema,
    execute: (params) => executeDesk(params),
  });

  runner.register({
    name: "autocrew_video",
    label: "AutoCrew Video",
    description: VIDEO_DESCRIPTION,
    parameters: videoSchema,
    execute: (params) => executeVideo(params),
  });

  runner.register({
    name: "autocrew_status",
    label: "AutoCrew Status",
    description: "Pipeline status, quality baseline, performance tracking, learning report. Actions: overview, baseline, compare, track_performance, learning_report. overview with brief:true returns one line of to-dos (to write / awaiting A-roll / dispatched / ready to publish).",
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
      "Manage automated content pipelines. Actions: create, list, get, enable, disable, delete, templates.",
    parameters: pipelineSchema,
    execute: executePipeline,
  });

  runner.register({
    name: "autocrew_publish",
    label: "AutoCrew Publish",
    description:
      "Run approval-gated publishing flows. Before the one-time founder confirmation of a video publish, run action='check' with the plan, the founder's verbatim quotes and any instruction_id: it checks each platform's covers (by pixels, against the registered pair), cut, cover text, title/caption limits and schedule, plus TypeSafe semantic warnings; paste summary_table verbatim and never submit a blocked platform. action='propose_preference' records a cover-ratio / publish-rule proposal the founder confirms in the workbench. Use action='ego_lite_prepare' for 视频号/小红书/抖音/Bilibili browser upload packages, or action='wechat_mp_draft' for WeChat MP drafts.",
    parameters: publishSchema,
    execute: executePublish,
  });

  runner.register({
    name: "autocrew_humanize",
    label: "AutoCrew Humanize",
    description: "Normalize whitespace and return optional style suggestions. Does not automatically replace words or rewrite meaning; use the writer flow for intentional revisions.",
    parameters: humanizeSchema,
    execute: executeHumanize,
  });

  runner.register({
    name: "autocrew_rewrite",
    label: "AutoCrew Rewrite",
    description:
      "Platform adaptations use workflow prepare and writer submit by default. Explicit execution=engine can return unreviewed suggestions only; save_as_draft is disallowed through this tool.",
    parameters: rewriteSchema,
    execute: executeHostRewrite,
  });

  runner.register({
    name: "autocrew_cover_review",
    label: "AutoCrew Cover Review",
    description:
      "PAID image API (relay/Gemini) for personal-IP covers. Default cover work does NOT start here: read skills/cover-generator first — covers are a 3:4 + 4:3 pair with the creator's real identity, generated on the Codex subscription (image_gen); Claude and other hosts dispatch that to Codex. Generating actions (create_candidates, revise, platform_ratios, draft_ratios, generate_ratios) from a host require confirm_paid_api:true after the creator explicitly chose the paid API, and 16:9 is refused. get/approve are free.",
    parameters: coverReviewSchema,
    execute: executeCoverReview,
    needsGemini: true,
  });

  runner.register({ name: "autocrew_editorial", label: "AutoCrew Editorial", description: EDITORIAL_DESCRIPTION, parameters: editorialSchema, execute: executeEditorial });

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
      "Read-only mechanical text checks and optional style suggestions, not semantic review or author approval. full_review/scan_only/quality_score are read-only; auto_fix only normalizes whitespace. For AI semantic review use writer submit.",
    parameters: reviewSchema,
    execute: executeReview,
  });

  runner.register({
    name: "autocrew_pre_publish",
    label: "AutoCrew Pre-Publish",
    description:
      "Pre-publish gate. check: 6 checks before allowing publish (video platforms read the saved video kit, not the script). " +
      "video_kit{content_id, platform, kit:{post_title, caption, cover_text, hashtags?, title_candidates, title_method}}: the host writes the video publish kit; " +
      "validated and saved, no model call. Editing the draft afterwards makes the kit stale (check returns kit_stale). " +
      "title_methods{platform?}: the publish-title method library (read it before drafting titles: 3 platform-agnostic candidates from 3 different categories, " +
      "founder picks or writes their own = \"自拟\", then adapt per platform) plus per-method trial stats.",
    parameters: prePublishSchema,
    execute: executePrePublishTool,
  });

  runner.register({
    name: "autocrew_dashboard",
    label: "AutoCrew Dashboard",
    description:
      "Content pipeline dashboard: overview stats, calendar view, pending actions, batch operations. " +
      "Actions: overview, calendar, pending, batch_review, batch_transition.",
    parameters: dashboardSchema,
    execute: executeDashboard,
  });

  runner.register({
    name: "autocrew_insights",
    label: "AutoCrew Account Insights",
    description: INSIGHTS_DESCRIPTION,
    parameters: insightsSchema,
    execute: executeInsights,
  });

  runner.register({
    name: "autocrew_flywheel",
    label: "AutoCrew Flywheel",
    description:
      "Performance loop: import platform CSV exports (back-catalog + weekly backfill), record manual metrics, " +
      "and report loop status with baseline insights. Actions: import_csv, record, report.",
    parameters: flywheelSchema,
    execute: executeFlywheel,
  });

  runner.register({
    name: "autocrew_generate",
    label: "AutoCrew Generate",
    description:
      "Explicit BACKGROUND ENGINE writing only: execution=engine must be requested by the user. Normal writing stays with the current host: start with autocrew_workflow prepare, then autocrew_writer. Action: script; requires a prepared topic_id on MCP.",
    parameters: generateSchema,
    execute: (p) => executeGenerate(p),
  });

  runner.register({
    name: "autocrew_style",
    label: "AutoCrew Style",
    description:
      "Host-driven style analysis: returns samples or edit differences for the current host to analyze. User-confirmed preferences use autocrew_editorial. Only explicit execution=engine invokes a separate model API.",
    parameters: styleSchema,
    execute: (p) => executeHostStyle(p),
  });

  runner.register({
    name: "autocrew_revise",
    label: "AutoCrew Revise",
    description: "Default: return a host revision handoff for the existing draft; record feedback and force a writer pack for that content_id. Only explicit execution=engine invokes a background model and saves a revision.",
    parameters: {
      type: "object" as const,
      required: ["content_id", "instruction"],
      properties: {
        content_id: { type: "string" as const, description: "Existing AutoCrew content id." },
        instruction: { type: "string" as const, description: "Concrete revision feedback." },
        execution: { type: "string" as const, enum: ["host", "engine"], description: "Default host. engine only when the user explicitly requests separately billed background rewriting." },
      },
    },
    execute: async (params) => {
      const contentId = String(params.content_id ?? "");
      const instruction = String(params.instruction ?? "").trim();
      if (!contentId || !instruction) return { ok: false, error: "content_id and instruction are required" };
      if (params.execution !== "engine") {
        const inspected = await executeEditorial({ action: "inspect", content_id: contentId, _dataDir: params._dataDir });
        if (inspected.ok === false) return inspected;
        return { ok: true, status: "host_revision_required", executed_by: { kind: "host", host: params._host ?? "local-user" }, model_api_calls: 0,
          content_id: contentId, draft_hash: inspected.draft_hash, feedback: instruction,
          next_action: { tool: "autocrew_editorial", params: { action: "feedback", content_id: contentId, draft_hash: inspected.draft_hash, feedback: instruction, scope: "draft" }, message: "以本次用户反馈的稳定event_id及user_confirmed:true记录原话，再按反馈回执重领原稿writer包；局部修改传selection，保留未修改部分。" } };
      }
      // 选题会闸口：后台改写一张占位稿 = 在给它的选题开第一篇；真稿的修订放行
      const refused = await aiContentWriteRefusal(contentId, params._dataDir as string | undefined);
      if (refused) return refused;
      const result = await reviseDraft(contentId, instruction, params._dataDir as string | undefined);
      return {
        ok: true,
        contentId: result.content.id,
        title: result.content.title,
        version: result.content.versions.length,
        tokensUsed: result.tokensUsed,
      };
    },
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

// --- OpenClaw Plugin ---

const autocrewPlugin = {
  id: "autocrew",
  name: "AutoCrew",
  description:
    "AI content operations crew — automated research, writing, and publishing pipeline for Chinese social media.",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      data_dir: { type: "string" as const },
      pro_api_key: { type: "string" as const },
      pro_api_url: { type: "string" as const },
      cdp_proxy_url: { type: "string" as const },
      gemini_api_key: { type: "string" as const },
      gemini_model: { type: "string" as const },
    },
  },

  register(api: any, config?: PluginConfig) {
    // --- Runtime Layer ---
    const ctx = createContext(config);
    const eventBus = new EventBus();
    const hookManager = new HookManager();
    const runner = new ToolRunner({ ctx, eventBus });

    // Register all tools
    registerAutocrewCapabilities(runner);

    // Initialize hooks (async, fire-and-forget)
    hookManager.init(eventBus, runner, ctx.dataDir).catch(() => {});

    // --- Bridge: ToolRunner → OpenClaw API ---
    for (const def of runner.getTools()) {
      api.registerTool(
        () => ({
          name: def.name,
          label: def.label,
          description: def.description,
          parameters: def.parameters,
          async execute(_id: string, params: Record<string, unknown>) {
            return runner.execute(def.name, openclawModelParams(def.name, params));
          },
        }),
        { names: [def.name] },
      );
    }

    // --- CLI: openclaw crew ---
    api.registerCli(
      ({ program }: any) => {
        const crew = program.command("crew").description("AutoCrew content operations");

        crew
          .command("status")
          .description("Show pipeline status")
          .action(async () => {
            const result = await runner.execute("autocrew_status", {});
            console.log(`AutoCrew v${result.version}`);
            console.log(`Data: ${ctx.dataDir}`);
            console.log(`Topics: ${result.topics}`);
            console.log(`Contents: ${result.contents} (draft:${(result.contentsByStatus as any)?.draft ?? 0} review:${(result.contentsByStatus as any)?.review ?? 0} approved:${(result.contentsByStatus as any)?.approved ?? 0} published:${(result.contentsByStatus as any)?.published ?? 0})`);
          });

        crew
          .command("topics")
          .description("List saved topics")
          .action(async () => {
            const result = await runner.execute("autocrew_topic", { action: "list" });
            const topics = (result.topics || []) as any[];
            if (topics.length === 0) {
              console.log("No topics yet. Use 'autocrew_topic' tool or 'openclaw crew research' to create some.");
              return;
            }
            for (const t of topics) {
              console.log(`[${t.id}] ${t.title} (${t.platform || "general"}) — score: ${t.viralScore ?? "?"}`);
            }
          });

        crew
          .command("contents")
          .description("List content items")
          .action(async () => {
            const result = await runner.execute("autocrew_content", { action: "list" });
            const items = (result.items || []) as any[];
            if (items.length === 0) {
              console.log("No content yet. Use 'autocrew_content' tool to save drafts.");
              return;
            }
            for (const c of items) {
              console.log(`[${c.id}] ${c.title} — ${c.status} (${c.platform || "general"})`);
            }
          });

        crew
          .command("research")
          .description("Discover browser-first topic candidates and save them into AutoCrew")
          .requiredOption("--keyword <keyword>", "Research keyword or angle")
          .option("--industry <industry>", "Industry or niche")
          .option("--platform <platform>", "Target platform", "xiaohongshu")
          .option("--count <count>", "Number of topics", "3")
          .action(async (options: Record<string, unknown>) => {
            const result = await runner.execute("autocrew_research", {
              action: "discover",
              keyword: options.keyword,
              industry: options.industry,
              platform: options.platform,
              topic_count: Number(options.count || 3),
            });

            if (!result.ok) {
              console.error(`Research failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }

            console.log(`Research complete. Mode: ${result.mode}`);
            const topics = (result.topics || []) as any[];
            for (const t of topics) {
              console.log(`  [${t.id}] ${t.title} — score: ${t.viralScore ?? "?"}`);
            }
          });

        crew
          .command("assets <content-id>")
          .description("List assets for a content project")
          .action(async (contentId: string) => {
            const result = await runner.execute("autocrew_asset", { action: "list", content_id: contentId });
            const assets = (result.assets || []) as any[];
            if (assets.length === 0) {
              console.log(`No assets for ${contentId}.`);
              return;
            }
            for (const a of assets) {
              console.log(`  [${a.type}] ${a.filename} (${a.role || "general"})`);
            }
          });

        crew
          .command("versions <content-id>")
          .description("List version history for a content project")
          .action(async (contentId: string) => {
            const result = await runner.execute("autocrew_asset", { action: "versions", content_id: contentId });
            const versions = (result.versions || []) as any[];
            if (versions.length === 0) {
              console.log(`No versions for ${contentId}.`);
              return;
            }
            for (const v of versions) {
              console.log(`  v${v.version} — ${v.note || "no note"} (${v.savedAt})`);
            }
          });

        crew
          .command("open <content-id>")
          .description("Show the file path of a content project directory")
          .action(async (contentId: string) => {
            const projPath = `${ctx.dataDir}/contents/${contentId}`;
            console.log(`Content project: ${projPath}`);
            console.log(`  draft.md    — current readable draft`);
            console.log(`  meta.json   — metadata + asset index`);
            console.log(`  assets/     — media files (covers, B-Roll, etc.)`);
            console.log(`  versions/   — version history (v1.md, v2.md, ...)`);
          });

        crew
          .command("pipelines")
          .description("List configured pipelines")
          .action(async () => {
            const result = await runner.execute("autocrew_pipeline", { action: "list" });
            const pipelines = (result.pipelines || []) as any[];
            if (pipelines.length === 0) {
              console.log("No pipelines configured. Use 'autocrew_pipeline' tool to create one.");
              return;
            }
            for (const p of pipelines) {
              console.log(`  [${p.id}] ${p.name} — ${p.enabled ? "enabled" : "disabled"} (${p.schedule || "manual"})`);
            }
          });

        crew
          .command("templates")
          .description("List available pipeline templates")
          .action(async () => {
            const result = await runner.execute("autocrew_pipeline", { action: "templates" });
            const templates = (result.templates || []) as any[];
            for (const t of templates) {
              console.log(`  [${t.id}] ${t.name}`);
              console.log(`    ${t.description}`);
            }
          });

        crew
          .command("humanize <content-id>")
          .description("Run Chinese de-AI pass on a content draft")
          .action(async (contentId: string) => {
            const result = await runner.execute("autocrew_humanize", { content_id: contentId });
            if (!result.ok) {
              console.error(`Humanize failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }
            console.log(`De-AI pass complete. Changes: ${result.changeCount || 0}`);
            if ((result.changes as any[])?.length > 0) {
              for (const c of result.changes as string[]) {
                console.log(`  • ${c}`);
              }
            }
          });

        crew
          .command("adapt <content-id> <platform>")
          .description("Create a platform-native rewrite")
          .action(async (contentId: string, platform: string) => {
            const result = await runner.execute("autocrew_rewrite", {
              action: "adapt_platform",
              content_id: contentId,
              target_platform: platform,
            });
            if (!result.ok) {
              console.error(`Adapt failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }
            console.log(`Platform rewrite complete → ${platform}`);
            console.log(`  New content: ${result.newContentId || result.id || "(saved)"}`);
          });

        crew
          .command("cover-review <content-id>")
          .description("Generate A/B/C cover candidates for a content")
          .action(async (contentId: string) => {
            const result = await runner.execute("autocrew_cover_review", {
              action: "create_candidates",
              content_id: contentId,
            });
            if (!result.ok) {
              console.error(`Cover generation failed: ${result.error || "unknown error"}`);
              if (result.hint) console.log(`Hint: ${result.hint}`);
              process.exitCode = 1;
              return;
            }
            console.log(`Generated ${result.generated || 0} cover candidates.`);
            const review = result.review as any;
            if (review?.variants) {
              for (const v of review.variants) {
                console.log(`  [${v.label.toUpperCase()}] ${v.style} — ${v.titleText || ""}`);
                if (v.imagePaths?.["3:4"]) console.log(`    → ${v.imagePaths["3:4"]}`);
              }
            }
          });

        crew
          .command("approve-cover <content-id> <label>")
          .description("Approve a cover variant (a, b, or c)")
          .action(async (contentId: string, label: string) => {
            const result = await runner.execute("autocrew_cover_review", {
              action: "approve",
              content_id: contentId,
              label,
            });
            if (!result.ok) {
              console.error(`Approve failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }
            console.log(`Cover ${label.toUpperCase()} approved for ${contentId}.`);
          });

        crew
          .command("review <content-id>")
          .description("Run read-only mechanical text checks (not author approval)")
          .option("--platform <platform>", "Target platform for platform-specific checks")
          .action(async (contentId: string, options: Record<string, unknown>) => {
            const result = await runner.execute("autocrew_review", {
              action: "full_review",
              content_id: contentId,
              platform: options.platform,
            }) as any;

            if (!result.ok) {
              console.error(`Review failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }

            console.log(result.summary);
            if (result.fixes?.length > 0) {
              console.log("\nSuggested fixes:");
              for (const fix of result.fixes) {
                console.log(`  ${fix}`);
              }
            }
          });

        crew
          .command("fix <content-id>")
          .description("Auto-fix sensitive words + de-AI and save back to draft")
          .option("--platform <platform>", "Target platform for platform-specific checks")
          .action(async (contentId: string, options: Record<string, unknown>) => {
            const result = await runner.execute("autocrew_review", {
              action: "auto_fix",
              content_id: contentId,
              platform: options.platform,
            });

            if (!result.ok) {
              console.error(`Fix failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }

            console.log(`Auto-fix complete for ${contentId}.`);
            console.log(`  Sensitive words fixed: ${result.sensitiveWordsFixed || 0}`);
            console.log(`  Whitespace fixes: ${result.formatFixesApplied || 0}`);
            console.log(`  Saved: ${result.saved ? "yes" : "no"}`);
          });

        crew
          .command("pre-publish <content-id>")
          .description("Run pre-publish checklist: 6 checks before allowing publish")
          .action(async (contentId: string) => {
            const result = await runner.execute("autocrew_pre_publish", {
              action: "check",
              content_id: contentId,
            }) as any;

            if (!result.ok) {
              console.error(`Pre-publish check failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }

            console.log(result.summary);
          });

        crew
          .command("learn <content-id>")
          .description("Capture a feedback signal into AutoCrew memory")
          .requiredOption("--signal <signal>", "approval | rejection | edit | performance | general")
          .option("--feedback <feedback>", "Freeform feedback text")
          .option("--modified-text <text>", "User-edited final text for edit signals")
          .action(async (contentId: string, options: Record<string, unknown>) => {
            const result = await runner.execute("autocrew_memory", {
              action: "capture_feedback",
              content_id: contentId,
              signal_type: options.signal,
              feedback: options.feedback,
              modified_text: options.modifiedText,
            });

            if (!result.ok) {
              console.error(`Memory capture failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }

            console.log(`Saved learning to ${result.section}.`);
            console.log(`  ${result.learning}`);
          });

        crew
          .command("memory")
          .description("Show current AutoCrew MEMORY.md")
          .action(async () => {
            const result = await runner.execute("autocrew_memory", { action: "get_memory" });

            if (!result.ok) {
              console.error(`Read memory failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }

            console.log(result.content);
          });

        crew
          .command("init")
          .description("Initialize ~/.autocrew/ data directory and creator profile")
          .action(async () => {
            const result = await runner.execute("autocrew_init", {});
            if (result.alreadyExisted) {
              console.log(`AutoCrew already initialized at ${result.dataDir}`);
            } else {
              console.log(`AutoCrew initialized at ${result.dataDir}`);
            }
            console.log(`  Created: ${(result.created as any[])?.length ?? 0} items`);

            const profile = await loadProfile(ctx.dataDir);
            if (profile) {
              const missing = detectMissingInfo(profile);
              if (missing.length > 0) {
                console.log(`\n  Profile incomplete — missing: ${missing.join(", ")}`);
                console.log(`  Start a conversation with your agent to complete onboarding.`);
              } else {
                console.log(`\n  Profile complete. Ready to go!`);
              }
            }
          });

        crew
          .command("upgrade")
          .description("Activate or verify AutoCrew Pro")
          .option("--key <key>", "Pro API key")
          .action(async (options: Record<string, unknown>) => {
            if (options.key) {
              await saveProKey(options.key as string, ctx.dataDir);
              console.log("Pro API key saved. Verifying...");
              const result = await verifyKey({ dataDir: ctx.dataDir });
              if (result.ok && result.data?.valid) {
                console.log(`Pro activated! Plan: ${result.data.plan}`);
                if (result.data.expiresAt) {
                  console.log(`  Expires: ${result.data.expiresAt}`);
                }
                if (result.data.usage) {
                  console.log(`  Usage: ${result.data.usage.used}/${result.data.usage.used + result.data.usage.remaining} ${result.data.usage.unit}`);
                }
              } else {
                console.error(`Verification failed: ${result.error || "invalid key"}`);
                console.log("Key saved locally but could not be verified. Check your network or key.");
              }
            } else {
              const status = await getProStatus(ctx.dataDir);
              if (status.isPro) {
                console.log("AutoCrew Pro is active.");
                const result = await verifyKey({ dataDir: ctx.dataDir });
                if (result.ok && result.data) {
                  console.log(`  Plan: ${result.data.plan}`);
                  if (result.data.usage) {
                    console.log(`  Usage: ${result.data.usage.used}/${result.data.usage.used + result.data.usage.remaining} ${result.data.usage.unit}`);
                  }
                }
              } else {
                console.log("AutoCrew Free version.");
                console.log("\nPro features: deep crawling, competitor monitoring, analytics, TTS, digital human.");
                console.log("Get your Pro key at: https://autocrew.dev/activate");
                console.log("\nActivate: openclaw crew upgrade --key <your-key>");
              }
            }
          });

        crew
          .command("profile")
          .description("Show creator profile")
          .action(async () => {
            const profile = await loadProfile(ctx.dataDir);
            if (!profile) {
              console.log("No creator profile yet. Run 'openclaw crew init' first.");
              return;
            }
            console.log(`Industry: ${profile.industry || "(not set)"}`);
            console.log(`Platforms: ${profile.platforms.length > 0 ? profile.platforms.join(", ") : "(not set)"}`);
            console.log(`Style calibrated: ${profile.styleCalibrated ? "yes" : "no"}`);
            if (profile.audiencePersona) {
              console.log(`Audience: ${personaSummary(profile.audiencePersona, { allTiers: true })}${profile.audiencePersona.calibratedAt ? "" : " (未校准)"}`);
            } else {
              console.log(`Audience: (not set)`);
            }
            console.log(`Writing rules: ${profile.writingRules.length}`);
            console.log(`Competitors: ${profile.competitorAccounts.length}`);
            console.log(`Performance entries: ${profile.performanceHistory.length}`);

            const missing = detectMissingInfo(profile);
            if (missing.length > 0) {
              console.log(`\nMissing: ${missing.join(", ")}`);
            }
          });

        crew
          .command("baseline")
          .description("Show quality baseline from historical performance data")
          .action(async () => {
            const result = await runner.execute("autocrew_status", { action: "baseline" }) as any;
            if (!result.ok) {
              console.error(`Baseline failed: ${result.error}`);
              process.exitCode = 1;
              return;
            }
            console.log(`\n📈 质量基线 (${result.sampleSize} 条数据)\n`);
            if (result.insights?.length > 0) {
              for (const insight of result.insights) {
                console.log(`  ${insight}`);
              }
            }
            if (result.avgMetrics && Object.keys(result.avgMetrics).length > 0) {
              console.log(`\n平均指标:`);
              for (const [key, val] of Object.entries(result.avgMetrics)) {
                console.log(`  ${key}: ${val}`);
              }
            }
          });

        crew
          .command("track <content-id>")
          .description("Record performance metrics for a published content")
          .requiredOption("--views <views>", "View count")
          .option("--likes <likes>", "Like count", "0")
          .option("--comments <comments>", "Comment count", "0")
          .option("--shares <shares>", "Share count", "0")
          .option("--saves <saves>", "Save/collect count", "0")
          .action(async (contentId: string, options: Record<string, unknown>) => {
            const metrics = {
              views: Number(options.views || 0),
              likes: Number(options.likes || 0),
              comments: Number(options.comments || 0),
              shares: Number(options.shares || 0),
              saves: Number(options.saves || 0),
            };
            const result = await runner.execute("autocrew_status", {
              action: "track_performance",
              content_id: contentId,
              metrics,
            }) as any;
            if (!result.ok) {
              console.error(`Track failed: ${result.error}`);
              process.exitCode = 1;
              return;
            }
            console.log(`已记录 ${contentId} 的表现数据。`);
            if (result.comparison) {
              console.log(`  ${result.comparison}`);
            }
          });

        crew
          .command("learning")
          .description("Show learning progress report")
          .action(async () => {
            const result = await runner.execute("autocrew_status", { action: "learning_report" }) as any;
            if (!result.ok) {
              console.error(`Report failed: ${result.error}`);
              process.exitCode = 1;
              return;
            }
            console.log(result.report);
          });

        crew
          .command("dashboard")
          .description("Show content pipeline dashboard")
          .option("--days <days>", "Look-back period in days", "7")
          .action(async (options: Record<string, unknown>) => {
            const result = await runner.execute("autocrew_dashboard", {
              action: "overview",
              days: Number(options.days || 7),
            }) as any;

            if (!result.ok) {
              console.error(`Dashboard failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }

            console.log(`\n📊 AutoCrew Dashboard (${result.period})`);
            console.log(`─────────────────────────────`);
            console.log(`选题: ${result.totals.topics}  内容: ${result.totals.contents}  已发布: ${result.totals.published}`);
            console.log(`\n近期活动:`);
            console.log(`  新选题: ${result.recentActivity.newTopics}  新内容: ${result.recentActivity.newContents}  发布: ${result.recentActivity.publishedThisPeriod}`);

            const pa = result.pendingActions;
            if (pa.total > 0) {
              console.log(`\n⏳ 待处理 (${pa.total}):`);
              if (pa.needsReview > 0) console.log(`  待审核: ${pa.needsReview}`);
              if (pa.needsPublish > 0) console.log(`  待发布: ${pa.needsPublish}`);
              if (pa.inRevision > 0) console.log(`  修改中: ${pa.inRevision}`);
              if (pa.needsCover > 0) console.log(`  待封面: ${pa.needsCover}`);
            } else {
              console.log(`\n✅ 没有待处理事项`);
            }

            const statuses = result.byStatus as Record<string, number>;
            if (Object.keys(statuses).length > 0) {
              console.log(`\n状态分布:`);
              for (const [status, count] of Object.entries(statuses)) {
                console.log(`  ${status}: ${count}`);
              }
            }
          });

        crew
          .command("pending")
          .description("Show pending action items")
          .action(async () => {
            const result = await runner.execute("autocrew_dashboard", { action: "pending" }) as any;
            if (!result.ok) {
              console.error(`Failed: ${result.error}`);
              process.exitCode = 1;
              return;
            }
            if (result.count === 0) {
              console.log("没有待处理事项。");
              return;
            }
            console.log(`⏳ ${result.count} 项待处理:\n`);
            for (const item of result.items) {
              console.log(`  [${item.id}] ${item.title} — ${item.status} (${item.platform || "general"})`);
              console.log(`    → ${item.suggestedAction}`);
            }
          });

        // --- Debug commands ---
        crew
          .command("audit")
          .description("Show recent tool execution audit log")
          .action(() => {
            if (ctx.audit.length === 0) {
              console.log("No audit entries yet.");
              return;
            }
            for (const entry of ctx.audit.slice(-20)) {
              const status = entry.ok ? "✓" : "✗";
              console.log(`  ${status} ${entry.tool}${entry.action ? `:${entry.action}` : ""} — ${entry.durationMs}ms (${entry.timestamp})`);
              if (entry.error) console.log(`    Error: ${entry.error}`);
            }
          });

        crew
          .command("events")
          .description("Show recent event history")
          .action(() => {
            const history = eventBus.getHistory(20);
            if (history.length === 0) {
              console.log("No events yet.");
              return;
            }
            for (const e of history) {
              console.log(`  ${e.type} — ${JSON.stringify(e.data)} (${e.timestamp})`);
            }
          });
      },
      { commands: ["crew"] },
    );
  },
};

/**
 * OpenClaw 里模型发起的工具调用一律打上 `_modelCall`（覆盖模型自报的同名值）：付费出图护栏、
 * 视频稿的创始人批准（审片通过 / 封面定稿 / 剪辑后改平台）都靠它认出「这是模型不是人」。
 * 只标来源、不动 `_host`，认领归属照旧；用户手敲的 /cover 斜杠命令不经过这里，等同工作台操作。
 */
export function openclawModelParams(_toolName: string, params: Record<string, unknown>): Record<string, unknown> {
  return { ...params, _modelCall: true };
}

export default autocrewPlugin;
