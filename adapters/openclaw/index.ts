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
你现在已加载 AutoCrew 插件。

1. **先拆解再执行**：收到复杂请求时，先调用 autocrew_pipeline templates 展示步骤，用户确认后再逐步执行。
2. **文件优先**：所有内容产出必须通过 autocrew_content save 保存到 ~/.autocrew/，不要只输出到聊天里。
3. **完成后汇报**：每步完成后说明做了什么、结果是什么、下一步是什么。
4. **使用已有工具**：优先使用 autocrew_* 系列工具完成任务。
5. **风格校准**：写内容前检查 ~/.autocrew/STYLE.md，确保产出符合用户的写作风格。
6. **标题硬限制**：所有选题标题必须 ≤20 个中文字符（含标点和 emoji）。超过必须重写。
7. **告知文件位置**：保存内容后告诉用户文件路径和打开方式。
</autocrew_instructions>`;
      });
    }
  },
};

export default autocrewPlugin;
