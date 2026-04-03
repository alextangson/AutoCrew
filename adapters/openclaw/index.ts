/**
 * AutoCrew — thin OpenClaw plugin adapter.
 *
 * Bridges the standalone AutoCrew runtime to OpenClaw's plugin API.
 * All logic lives in src/ — this file only does registration + system prompt injection.
 */
import { bootstrap } from "../../src/cli/bootstrap.js";
import type { PluginConfig } from "../../src/runtime/context.js";

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
    const { runner } = bootstrap(config);

    // Bridge tools to OpenClaw API
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

    // System prompt injection
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
6. **标题硬限制**：所有选题标题必须 ≤20 个中文字符（含标点符号和 emoji）。这是小红书等平台的硬性限制。超过 20 字的标题必须重写，不能截断。生成选题时，加载 skills/title-craft 方法论来指导标题创作。
7. **去AI味+审核自动执行**：写完内容后，自动运行 autocrew_humanize（去AI味）和 autocrew_review（审核），不要问用户"要不要去AI味"或"要不要审核"——直接做。这是质量底线，不是可选功能。
8. **告知文件位置**：保存内容后，必须告诉用户文件保存在哪里以及如何打开。格式：「📄 内容已保存到：~/.autocrew/contents/{id}/draft.md」+ 打开方式。
</autocrew_instructions>`;
      });
    }
  },
};

export default autocrewPlugin;
