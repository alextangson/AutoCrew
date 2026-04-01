/**
 * AutoCrew — OpenClaw plugin entry point.
 *
 * Registers tools and CLI subcommands into the OpenClaw Gateway.
 * Tools core logic lives in src/tools/ (shared with Claude Code MCP entry).
 */
import { topicCreateSchema, executeTopicCreate } from "./src/tools/topic-create.js";
import { researchSchema, executeResearch } from "./src/tools/research.js";
import { contentSaveSchema, executeContentSave } from "./src/tools/content-save.js";
import { statusSchema, executeStatus } from "./src/tools/status.js";
import { assetSchema, executeAsset } from "./src/tools/asset.js";
import { pipelineSchema, executePipeline } from "./src/tools/pipeline.js";
import { publishSchema, executePublish } from "./src/tools/publish.js";
import { humanizeSchema, executeHumanize } from "./src/tools/humanize.js";
import { rewriteSchema, executeRewrite } from "./src/tools/rewrite.js";
import { coverReviewSchema, executeCoverReview } from "./src/tools/cover-review.js";
import { memorySchema, executeMemory } from "./src/tools/memory.js";
import { reviewSchema, executeReview } from "./src/tools/review.js";
import { prePublishSchema, executePrePublish } from "./src/tools/pre-publish.js";
import { executeInit } from "./src/tools/init.js";
import { getProStatus, saveProKey } from "./src/modules/pro/gate.js";
import { verifyKey } from "./src/modules/pro/api-client.js";
import { loadProfile, detectMissingInfo } from "./src/modules/profile/creator-profile.js";

function getDataDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return `${home}/.autocrew`;
}

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

  register(api: any, config?: Record<string, any>) {
    const dataDir = config?.data_dir || getDataDir();

    // --- Tool: autocrew_topic ---
    api.registerTool(
      () => ({
        name: "autocrew_topic",
        label: "AutoCrew Topic",
        description:
          "Create or list content topics. Use action='create' with title/description/tags to save a topic idea, or action='list' to show all saved topics.",
        parameters: topicCreateSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          return executeTopicCreate({ ...params, _dataDir: dataDir });
        },
      }),
      { names: ["autocrew_topic"] },
    );

    // --- Tool: autocrew_research ---
    api.registerTool(
      () => ({
        name: "autocrew_research",
        label: "AutoCrew Research",
        description:
          "Topic discovery with multiple modes: browser-first (Pro), API fallback, free (web search + viral scoring), or manual. " +
          "Supports action='discover' to generate/save topics and action='session_status' to inspect browser login readiness.",
        parameters: researchSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          return executeResearch({ ...params, _dataDir: dataDir });
        },
      }),
      { names: ["autocrew_research"] },
    );

    // --- Tool: autocrew_content ---
    api.registerTool(
      () => ({
        name: "autocrew_content",
        label: "AutoCrew Content",
        description:
          "Manage content lifecycle. Actions: 'save' (title+body), 'list', 'get' (id), 'update' (id+fields), " +
          "'transition' (id+target_status, validated state machine), 'create_variant' (topicId+platform), " +
          "'siblings' (id), 'allowed_transitions' (id).",
        parameters: contentSaveSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          return executeContentSave({ ...params, _dataDir: dataDir });
        },
      }),
      { names: ["autocrew_content"] },
    );

    // --- Tool: autocrew_status ---
    api.registerTool(
      () => ({
        name: "autocrew_status",
        label: "AutoCrew Status",
        description:
          "Show AutoCrew pipeline status: topic count, content count, content status breakdown.",
        parameters: statusSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          return executeStatus({ ...params, _dataDir: dataDir });
        },
      }),
      { names: ["autocrew_status"] },
    );

    // --- Tool: autocrew_asset ---
    api.registerTool(
      () => ({
        name: "autocrew_asset",
        label: "AutoCrew Asset",
        description:
          "Manage content project assets (covers, B-Roll, images, videos, subtitles) and version history. Actions: add, list, remove, versions, get_version, revert.",
        parameters: assetSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          return executeAsset({ ...params, _dataDir: dataDir });
        },
      }),
      { names: ["autocrew_asset"] },
    );

    // --- Tool: autocrew_pipeline ---
    api.registerTool(
      () => ({
        name: "autocrew_pipeline",
        label: "AutoCrew Pipeline",
        description:
          "Manage automated content pipelines (cron schedules). Actions: create, list, get, enable, disable, delete, templates. Use template='daily-research'/'weekly-content'/'daily-publish'/'full-pipeline' for presets.",
        parameters: pipelineSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          return executePipeline({ ...params, _dataDir: dataDir });
        },
      }),
      { names: ["autocrew_pipeline"] },
    );

    // --- Tool: autocrew_publish ---
    api.registerTool(
      () => ({
        name: "autocrew_publish",
        label: "AutoCrew Publish",
        description:
          "Run proven publishing flows. Currently supports action='wechat_mp_draft' to generate images, produce a cover, and push a WeChat MP article into the draft box.",
        parameters: publishSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          return executePublish({ ...params, _dataDir: dataDir });
        },
      }),
      { names: ["autocrew_publish"] },
    );

    // --- Tool: autocrew_humanize ---
    api.registerTool(
      () => ({
        name: "autocrew_humanize",
        label: "AutoCrew Humanize",
        description:
          "Run the Chinese de-AI pass. Supports action='humanize_zh' for raw text or an existing content draft.",
        parameters: humanizeSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          return executeHumanize({ ...params, _dataDir: dataDir });
        },
      }),
      { names: ["autocrew_humanize"] },
    );

    // --- Tool: autocrew_rewrite ---
    api.registerTool(
      () => ({
        name: "autocrew_rewrite",
        label: "AutoCrew Rewrite",
        description:
          "Adapt source drafts into platform-native versions. Supports action='adapt_platform' for single platform, " +
          "action='batch_adapt' for multiple platforms at once with auto title/hashtag generation and sibling linking.",
        parameters: rewriteSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          return executeRewrite({ ...params, _dataDir: dataDir });
        },
      }),
      { names: ["autocrew_rewrite"] },
    );

    // --- Tool: autocrew_cover_review ---
    api.registerTool(
      () => ({
        name: "autocrew_cover_review",
        label: "AutoCrew Cover Review",
        description:
          "Generate, review, and approve cover images. Actions: create_candidates (generate 3 style variants via Gemini), get (view review), approve (pick one), generate_ratios (Pro: 16:9 + 4:3).",
        parameters: coverReviewSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          return executeCoverReview({
            ...params,
            _dataDir: dataDir,
            _geminiApiKey: config?.gemini_api_key || process.env.GEMINI_API_KEY,
            _geminiModel: config?.gemini_model || "auto",
          });
        },
      }),
      { names: ["autocrew_cover_review"] },
    );

    // --- Tool: autocrew_memory ---
    api.registerTool(
      () => ({
        name: "autocrew_memory",
        label: "AutoCrew Memory",
        description:
          "Capture user feedback into MEMORY.md or read current memory. Supports action='capture_feedback' and action='get_memory'.",
        parameters: memorySchema,
        async execute(_id: string, params: Record<string, unknown>) {
          return executeMemory({ ...params, _dataDir: dataDir });
        },
      }),
      { names: ["autocrew_memory"] },
    );

    // --- Tool: autocrew_review ---
    api.registerTool(
      () => ({
        name: "autocrew_review",
        label: "AutoCrew Review",
        description:
          "Content review: sensitive word scan + de-AI check + quality scoring. " +
          "Actions: 'full_review' (all checks), 'scan_only' (sensitive words), " +
          "'quality_score' (score only), 'auto_fix' (apply fixes and save).",
        parameters: reviewSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          return executeReview({ ...params, _dataDir: dataDir });
        },
      }),
      { names: ["autocrew_review"] },
    );

    // --- Tool: autocrew_pre_publish ---
    api.registerTool(
      () => ({
        name: "autocrew_pre_publish",
        label: "AutoCrew Pre-Publish",
        description:
          "Pre-publish checklist gate. Runs 6 checks (content review, cover review, hashtags, title, platform, body length) " +
          "before allowing publish. Action: 'check'.",
        parameters: prePublishSchema,
        async execute(_id: string, params: Record<string, unknown>) {
          return executePrePublish({ ...params, _dataDir: dataDir });
        },
      }),
      { names: ["autocrew_pre_publish"] },
    );

    // --- Tool: autocrew_init ---
    api.registerTool(
      () => ({
        name: "autocrew_init",
        label: "AutoCrew Init",
        description:
          "Initialize the AutoCrew data directory (~/.autocrew/) and creator profile. Safe to run multiple times.",
        parameters: { type: "object" as const, properties: {} },
        async execute(_id: string, _params: Record<string, unknown>) {
          return executeInit({ dataDir });
        },
      }),
      { names: ["autocrew_init"] },
    );

    // --- Tool: autocrew_pro_status ---
    api.registerTool(
      () => ({
        name: "autocrew_pro_status",
        label: "AutoCrew Pro Status",
        description:
          "Check AutoCrew Pro status: whether Pro is active, profile completeness, and missing info.",
        parameters: { type: "object" as const, properties: {} },
        async execute(_id: string, _params: Record<string, unknown>) {
          const proStatus = await getProStatus(dataDir);
          const profile = await loadProfile(dataDir);
          const missing = profile ? detectMissingInfo(profile) : ["profile_not_initialized"];
          return {
            ok: true,
            isPro: proStatus.isPro,
            profileExists: profile !== null,
            missingInfo: missing,
            styleCalibrated: profile?.styleCalibrated ?? false,
          };
        },
      }),
      { names: ["autocrew_pro_status"] },
    );

    // --- CLI: openclaw crew ---
    api.registerCli(
      ({ program }: any) => {
        const crew = program.command("crew").description("AutoCrew content operations");

        crew
          .command("status")
          .description("Show pipeline status")
          .action(async () => {
            const result = await executeStatus({ _dataDir: dataDir });
            console.log(`AutoCrew v${result.version}`);
            console.log(`Data: ${dataDir}`);
            console.log(`Topics: ${result.topics}`);
            console.log(`Contents: ${result.contents} (draft:${result.contentsByStatus.draft} review:${result.contentsByStatus.review} approved:${result.contentsByStatus.approved} published:${result.contentsByStatus.published})`);
          });

        crew
          .command("topics")
          .description("List saved topics")
          .action(async () => {
            const { listTopics } = await import("./src/storage/local-store.js");
            const topics = await listTopics(dataDir);
            if (topics.length === 0) {
              console.log("No topics yet. Ask your agent to research some!");
              return;
            }
            for (const t of topics) {
              console.log(`[${t.id}] ${t.title}`);
              console.log(`  ${t.description}`);
              console.log(`  tags: ${t.tags.join(", ")}`);
              console.log();
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
            const result = await executeResearch({
              action: "discover",
              keyword: options.keyword,
              industry: options.industry,
              platform: options.platform,
              topic_count: Number(options.count || 3),
              _dataDir: dataDir,
            });

            if (!result.ok) {
              console.error(`Research failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }

            console.log(`Research completed for ${result.platform}.`);
            console.log(`  keyword: ${result.keyword}`);
            console.log(`  sources: ${(result.sourcesUsed || []).join(", ")}`);
            console.log(`  saved: ${result.savedCount}`);
          });

        crew
          .command("sessions")
          .description("Show browser-first session readiness for supported platforms")
          .option("--platform <platform>", "Optional single platform filter")
          .action(async (options: Record<string, unknown>) => {
            const result = await executeResearch({
              action: "session_status",
              platform: options.platform,
              _dataDir: dataDir,
            });

            if (!result.ok) {
              console.error(`Session check failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }

            for (const session of result.sessions || []) {
              const status = session.loggedIn ? "logged-in" : "not-logged-in";
              console.log(`[${session.platform}] ${status}${session.note ? ` — ${session.note}` : ""}`);
            }
          });

        crew
          .command("contents")
          .description("List saved content drafts")
          .action(async () => {
            const { listContents } = await import("./src/storage/local-store.js");
            const contents = await listContents(dataDir);
            if (contents.length === 0) {
              console.log("No content yet. Ask your agent to write some!");
              return;
            }
            for (const c of contents) {
              const assetCount = c.assets?.length || 0;
              const versionCount = c.versions?.length || 0;
              console.log(`[${c.id}] ${c.title} (${c.status})`);
              console.log(`  platform: ${c.platform || "unset"} | ${c.body?.length || 0} chars | ${assetCount} assets | v${versionCount}`);
              console.log();
            }
          });

        crew
          .command("assets <content-id>")
          .description("List assets for a content project")
          .action(async (contentId: string) => {
            const { listAssets } = await import("./src/storage/local-store.js");
            const assets = await listAssets(contentId, dataDir);
            if (assets.length === 0) {
              console.log(`No assets for ${contentId}.`);
              return;
            }
            console.log(`Assets for ${contentId}:`);
            for (const a of assets) {
              console.log(`  [${a.type}] ${a.filename}${a.description ? ` — ${a.description}` : ""}`);
            }
          });

        crew
          .command("versions <content-id>")
          .description("Show version history for a content project")
          .action(async (contentId: string) => {
            const { listVersions } = await import("./src/storage/local-store.js");
            const versions = await listVersions(contentId, dataDir);
            if (versions.length === 0) {
              console.log(`No versions for ${contentId}.`);
              return;
            }
            console.log(`Versions for ${contentId}:`);
            for (const v of versions) {
              console.log(`  v${v.version} — ${v.note || "no note"} (${v.savedAt})`);
            }
          });

        crew
          .command("open <content-id>")
          .description("Show the file path of a content project directory")
          .action(async (contentId: string) => {
            const projPath = `${dataDir}/contents/${contentId}`;
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
            const result = await executePipeline({ action: "list", _dataDir: dataDir });
            const pipelines = (result as any).pipelines || [];
            if (pipelines.length === 0) {
              console.log("No pipelines configured. Use 'autocrew_pipeline' tool to create one.");
              return;
            }
            for (const p of pipelines) {
              const status = p.enabled ? "✅ enabled" : "⏸ disabled";
              console.log(`[${p.id}] ${p.name} (${status})`);
              console.log(`  schedule: ${p.schedule}`);
              console.log(`  steps: ${p.steps.map((s: any) => s.skill).join(" → ")}`);
              console.log();
            }
          });

        crew
          .command("templates")
          .description("Show preset pipeline templates")
          .action(async () => {
            const result = await executePipeline({ action: "templates", _dataDir: dataDir });
            const templates = (result as any).templates || [];
            for (const t of templates) {
              console.log(`[${t.template}] ${t.name}`);
              console.log(`  ${t.description}`);
              console.log(`  schedule: ${t.schedule} | steps: ${t.steps}`);
              console.log();
            }
          });

        crew
          .command("wechat-mp-draft <article-path>")
          .description("Generate images/cover and push a WeChat MP article into the draft box")
          .option("--theme <theme>", "WeChat formatting theme", "newspaper")
          .option("--dry-run", "Generate assets and print the publish command without pushing")
          .option("--skip-images", "Skip image generation when image files already exist")
          .option("--author <author>", "Author used by the publish script", "Lawrence")
          .action(async (articlePath: string, options: Record<string, unknown>) => {
            const result = await executePublish({
              action: "wechat_mp_draft",
              article_path: articlePath,
              theme: options.theme,
              dry_run: Boolean(options.dryRun),
              skip_images: Boolean(options.skipImages),
              author: options.author,
              _dataDir: dataDir,
            });

            if (!result.ok) {
              console.error(`Publish failed: ${result.error || "unknown error"}`);
              if (result.stderr) {
                console.error(result.stderr);
              }
              process.exitCode = 1;
              return;
            }

            console.log("WeChat MP draft flow completed.");
            console.log(`  article: ${result.articlePath}`);
            console.log(`  cover: ${result.coverPath}`);
            console.log(`  images: ${result.generatedImages.length}`);
            if (result.command) {
              console.log(`  command: ${result.command}`);
            }
          });

        crew
          .command("humanize <content-id>")
          .description("Run the Chinese de-AI pass on a saved draft and write the result back")
          .action(async (contentId: string) => {
            const result = await executeHumanize({
              action: "humanize_zh",
              content_id: contentId,
              save_back: true,
              _dataDir: dataDir,
            });

            if (!result.ok) {
              console.error(`Humanize failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }

            console.log(result.summary);
            for (const change of result.changes || []) {
              console.log(`  - ${change}`);
            }
          });

        crew
          .command("adapt <content-id> <platform>")
          .description("Create a platform-native rewrite from an existing draft and save it as a new draft")
          .action(async (contentId: string, platform: string) => {
            const result = await executeRewrite({
              action: "adapt_platform",
              content_id: contentId,
              target_platform: platform,
              save_as_draft: true,
              _dataDir: dataDir,
            });

            if (!result.ok) {
              console.error(`Adapt failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }

            console.log(`Adapted for ${result.platform}.`);
            console.log(`  title: ${result.title}`);
            if (result.content?.id) {
              console.log(`  saved: ${result.content.id}`);
            }
            for (const note of result.notes || []) {
              console.log(`  - ${note}`);
            }
          });

        crew
          .command("cover-review <content-id>")
          .description("Create Xiaohongshu A/B/C cover review candidates for an existing draft")
          .action(async (contentId: string) => {
            const result = await executeCoverReview({
              action: "create_candidates",
              content_id: contentId,
              _dataDir: dataDir,
            });

            if (!result.ok) {
              console.error(`Cover review failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }

            console.log(`Cover review ready for ${contentId}.`);
            console.log(`  status: ${result.review.status}`);
            for (const variant of result.review.variants || []) {
              console.log(`  [${variant.label}] ${variant.prototypeName || "unknown prototype"} — ${variant.hookText || ""}`);
            }
          });

        crew
          .command("approve-cover <content-id> <label>")
          .description("Approve one Xiaohongshu cover candidate and advance the draft to publish-ready")
          .action(async (contentId: string, label: string) => {
            const result = await executeCoverReview({
              action: "approve",
              content_id: contentId,
              label,
              _dataDir: dataDir,
            });

            if (!result.ok) {
              console.error(`Approve failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }

            console.log(`Approved cover ${result.review.approvedLabel} for ${contentId}.`);
            console.log(`  status: ${result.review.status}`);
            if (result.review.approvedImagePath) {
              console.log(`  cover: ${result.review.approvedImagePath}`);
            }
          });

        crew
          .command("review <content-id>")
          .description("Run full content review: sensitive words + de-AI check + quality score")
          .option("--platform <platform>", "Target platform for platform-specific checks")
          .action(async (contentId: string, options: Record<string, unknown>) => {
            const result = await executeReview({
              action: "full_review",
              content_id: contentId,
              platform: options.platform,
              _dataDir: dataDir,
            });

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
            const result = await executeReview({
              action: "auto_fix",
              content_id: contentId,
              platform: options.platform,
              _dataDir: dataDir,
            });

            if (!result.ok) {
              console.error(`Fix failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }

            console.log(`Auto-fix complete for ${contentId}.`);
            console.log(`  Sensitive words fixed: ${result.sensitiveWordsFixed || 0}`);
            console.log(`  AI traces fixed: ${result.aiFixesApplied || 0}`);
            console.log(`  Saved: ${result.saved ? "yes" : "no"}`);
          });

        crew
          .command("pre-publish <content-id>")
          .description("Run pre-publish checklist: 6 checks before allowing publish")
          .action(async (contentId: string) => {
            const result = await executePrePublish({
              action: "check",
              content_id: contentId,
              _dataDir: dataDir,
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
            const result = await executeMemory({
              action: "capture_feedback",
              content_id: contentId,
              signal_type: options.signal,
              feedback: options.feedback,
              modified_text: options.modifiedText,
              _dataDir: dataDir,
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
            const result = await executeMemory({
              action: "get_memory",
              _dataDir: dataDir,
            });

            if (!result.ok) {
              console.error(`Read memory failed: ${result.error || "unknown error"}`);
              process.exitCode = 1;
              return;
            }

            console.log(result.content);
          });

        // --- New commands: init, upgrade, profile ---

        crew
          .command("init")
          .description("Initialize ~/.autocrew/ data directory and creator profile")
          .action(async () => {
            const result = await executeInit({ dataDir });
            if (result.alreadyExisted) {
              console.log(`AutoCrew already initialized at ${result.dataDir}`);
            } else {
              console.log(`AutoCrew initialized at ${result.dataDir}`);
            }
            console.log(`  Created: ${result.created.length} items`);

            // Check profile completeness
            const profile = await loadProfile(dataDir);
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
              // Save and verify the key
              await saveProKey(options.key as string, dataDir);
              console.log("Pro API key saved. Verifying...");
              const result = await verifyKey({ dataDir });
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
              // Show current status
              const status = await getProStatus(dataDir);
              if (status.isPro) {
                console.log("AutoCrew Pro is active.");
                const result = await verifyKey({ dataDir });
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
            const profile = await loadProfile(dataDir);
            if (!profile) {
              console.log("No creator profile yet. Run 'openclaw crew init' first.");
              return;
            }
            console.log(`Industry: ${profile.industry || "(not set)"}`);
            console.log(`Platforms: ${profile.platforms.length > 0 ? profile.platforms.join(", ") : "(not set)"}`);
            console.log(`Style calibrated: ${profile.styleCalibrated ? "yes" : "no"}`);
            if (profile.audiencePersona) {
              console.log(`Audience: ${profile.audiencePersona.name} (${profile.audiencePersona.age || "?"}, ${profile.audiencePersona.job || "?"})`);
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
      },
      { commands: ["crew"] },
    );
  },
};

export default autocrewPlugin;
