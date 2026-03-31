/**
 * AutoCrew — OpenClaw plugin entry point.
 *
 * Registers tools and CLI subcommands into the OpenClaw Gateway.
 * Tools core logic lives in src/tools/ (shared with Claude Code MCP entry).
 */
import { topicCreateSchema, executeTopicCreate } from "./src/tools/topic-create.js";
import { contentSaveSchema, executeContentSave } from "./src/tools/content-save.js";
import { statusSchema, executeStatus } from "./src/tools/status.js";

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
              console.log(`[${c.id}] ${c.title} (${c.status})`);
              console.log(`  platform: ${c.platform || "unset"}`);
              console.log(`  ${c.body?.length || 0} chars`);
              console.log();
            }
          });
      },
      { commands: ["crew"] },
    );
  },
};

export default autocrewPlugin;
