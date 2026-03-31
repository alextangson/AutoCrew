/**
 * AutoCrew — OpenClaw plugin entry point.
 *
 * Registers tools and CLI subcommands into the OpenClaw Gateway.
 * Tools core logic lives in src/tools/ (shared with Claude Code MCP entry).
 */
import { topicCreateSchema, executeTopicCreate } from "./src/tools/topic-create.js";
import { contentSaveSchema, executeContentSave } from "./src/tools/content-save.js";
import { statusSchema, executeStatus } from "./src/tools/status.js";
import { assetSchema, executeAsset } from "./src/tools/asset.js";

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
      tikhub_token: { type: "string" as const },
      data_dir: { type: "string" as const },
    },
  },

  register(api: any) {
    const dataDir = getDataDir();

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

    // --- Tool: autocrew_content ---
    api.registerTool(
      () => ({
        name: "autocrew_content",
        label: "AutoCrew Content",
        description:
          "Save, list, get, or update content drafts. Use action='save' with title/body to create a draft, action='list' to show all, action='get' with id, or action='update' with id and fields to modify.",
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
      },
      { commands: ["crew"] },
    );
  },
};

export default autocrewPlugin;
