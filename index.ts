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
import { pipelineSchema, createPipelineExecutor } from "./src/tools/pipeline.js";
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
import { createContext, type PluginConfig } from "./src/runtime/context.js";
import { ToolRunner } from "./src/runtime/tool-runner.js";
import { EventBus } from "./src/runtime/events.js";
import { HookManager } from "./src/runtime/hooks.js";

// --- Tool Registry ---

function registerAllTools(runner: ToolRunner): void {
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
      "Run proven publishing flows. Currently supports action='wechat_mp_draft' to generate images, produce a cover, and push a WeChat MP article into the draft box.",
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
      gateway_url: { type: "string" as const },
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
    registerAllTools(runner);

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
            return runner.execute(def.name, params);
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
          .description("Run full content review (sensitive words + quality + de-AI)")
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
            console.log(`  AI traces fixed: ${result.aiFixesApplied || 0}`);
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

    // --- System Prompt Injection ---
    if (typeof api.on === "function") {
      api.on("before_prompt_build", (event: any) => {
        event.appendSystemContext = `
<autocrew_instructions>
你现在已加载 AutoCrew 插件。在帮助用户创作内容时，遵循以下规则：

1. **先拆解再执行**：收到复杂请求时（如"帮我写一篇小红书"），先调用 autocrew_pipeline templates 展示完整步骤，用户确认后再逐步执行。
2. **文件优先**：所有内容产出必须通过 autocrew_content save 保存到 ~/.autocrew/，不要只输出到聊天里。用户需要在下次会话中找到之前的产出。
3. **完成后汇报**：每步完成后说明做了什么、结果是什么、下一步是什么。不要只说"完成了"。
4. **使用已有工具**：优先使用 autocrew_* 系列工具完成任务，而不是手动操作文件。工具链：研究(autocrew_research) → 创建选题(autocrew_topic) → 写稿(autocrew_content save) → 去AI化(autocrew_humanize) → 审核(autocrew_review) → 封面(autocrew_cover_review) → 预发布检查(autocrew_pre_publish) → 发布(autocrew_publish)。
5. **风格校准**：写内容前检查 ~/.autocrew/STYLE.md，确保产出符合用户的写作风格。
</autocrew_instructions>`;
      });
    }
  },
};

export default autocrewPlugin;
