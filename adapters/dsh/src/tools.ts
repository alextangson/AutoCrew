/**
 * ToolRunner → dsh `ctx.tools` 桥。
 *
 * AutoCrew 的能力只有一个注册源（根 index.ts 的 `registerAutocrewCapabilities`），
 * OpenClaw / CLI / MCP 都从那里取；dsh 是第四个消费面，同样只从那里取。
 *
 * 两处 dsh 特有的契约，是这个文件存在的全部理由：
 *
 * 1. `output` 是**强制**的，且注册表会校验 execute 的返回值。AutoCrew 工具按
 *    action 分叉返回不同形状，没法用一份严格 schema 描述，所以这里声明开放对象
 *    ——它仍然锁死「必须返回对象」（模块静默返回 undefined 会当场被抓）。
 *    逐工具收紧留到各自的输出契约被审过之后。
 *
 * 2. `ok: false` 必须**抛**出去，不能当成功值返回。dsh 只有抛错才会把这轮标成
 *    `isError` 让模型看见失败；返回一个内含 error 字段的「成功」结果，正是
 *    AutoCrew 现在最贵的那类 bug（静默丢结果还报成功）。这条不变量是这次移植
 *    真正买到的东西。
 */
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { registerAutocrewCapabilities } from "../../../index.js";
import { createContext, type PluginConfig } from "../../../src/runtime/context.js";
import { EventBus } from "../../../src/runtime/events.js";
import { ToolRunner } from "../../../src/runtime/tool-runner.js";
import { toLosslessJson } from "../../../src/utils/lossless-json.js";

/**
 * 放行进 dsh 的工具 —— 「写作线」：开机 → 看状态 → 立意 → 写 → 审 → 发布前门禁。
 *
 * 每一个都逐条过了 README「再放行一个工具的检查单」，逐工具的审计结论记在
 * README 的审计表里（失败是否都走 ok:false、有没有 import.meta.url 推出的
 * REPO_ROOT、有没有新的外部依赖）。表里判定为「不放行」的工具**不许**因为
 * 「顺手」被加进这个数组——尤其是 `autocrew_research`：它的浏览器适配器拿不到
 * 数据时会造 5 条占位选题、然后 `ok:true` 报成功，正是这个桥要挡的那类 bug。
 */
export const PORTED_TOOLS: readonly string[] = [
  // 开机自检与全局视图
  "autocrew_init",
  "autocrew_status",
  "autocrew_dashboard",
  // 选题 → 案卷
  "autocrew_topic",
  "autocrew_content",
  // 写
  "autocrew_generate",
  "autocrew_style",
  // 审 → 改 → 发布前门禁
  "autocrew_review",
  "autocrew_humanize",
  "autocrew_rewrite",
  "autocrew_pre_publish",
  // 一站式流程：research / status / select_angle / write / draft / doctor
  "autocrew_workflow",
  // 宿主写稿（P3 §5）：领包 → 补证 → 交稿过同一套门禁。dsh 里的模型自己动笔时用它
  "autocrew_writer",
  // 待办桌与认领（P3 §6）：dsh 只跑写作线，所以这里能看到的是 writer 那张桌
  "autocrew_desk",
];

/** 开放对象：只保证「是个对象」，形状随 action 变。 */
const OPEN_OBJECT_SCHEMA = { type: "object" as const, additionalProperties: true };

/**
 * dsh 注册表投影 schema 时要求「lossless JSON」，见到 TypeBox 的 own symbol 直接抛
 * `parameters must be lossless JSON before schema projection`。MCP 侧有同一个要求，
 * 所以实现搬到了 `src/utils/lossless-json.ts`；这里保留具名再导出，桥的调用点不变。
 */
export { toLosslessJson };

function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

export interface BuiltTools {
  definitions: ToolDefinition[];
  /** 注册源里存在、但这一批还没放行的工具名——调用方据此打印进度。 */
  pending: string[];
  /**
   * 在 `PORTED_TOOLS` 里、但注册源里查无此名的工具名。写错一个字母就等于那个工具
   * 悄悄消失，所以这里把它抬成一条可见的诊断，而不是让 for 循环无声跳过。
   */
  missing: string[];
}

/**
 * 把 AutoCrew 的工具集编译成 dsh 的 ToolDefinition。
 *
 * 不声明 `timeoutMs`：声明它等于承诺工具体会响应 `exec.signal`，而 AutoCrew 的
 * execute 目前一个都不接收信号。宁可没有超时，也不能给出一个做不到的承诺。
 */
export function buildDshTools(config: PluginConfig = {}): BuiltTools {
  const ctx = createContext(config);
  const runner = new ToolRunner({ ctx, eventBus: new EventBus() });
  registerAutocrewCapabilities(runner);

  const definitions: ToolDefinition[] = [];
  const pending: string[] = [];

  for (const tool of runner.getTools()) {
    if (!PORTED_TOOLS.includes(tool.name)) {
      pending.push(tool.name);
      continue;
    }
    definitions.push({
      name: tool.name,
      description: tool.description,
      parameters: toLosslessJson(tool.parameters) as ToolDefinition["parameters"],
      output: { schema: OPEN_OBJECT_SCHEMA, render: renderJson },
      async execute(args: unknown) {
        // dsh 交下来的 args 是冻结的，而 ToolRunner 的中间件会就地写 _dataDir /
        // _geminiApiKey——必须拷贝一份再进去，否则第一次调用就 TypeError。
        // 宿主归因（P3 spec §4.1）：dsh 是进程内桥，没有 MCP 层帮它注入 `_host`，这里补上；
        // 模型自己传的 `_host` 一律覆盖，归因不能由模型自报
        const params = { ...(args as Record<string, unknown>), _host: "dsh" };
        const result = await runner.execute(tool.name, params);
        if (result.ok === false) {
          throw new Error(String(result.error ?? `${tool.name} failed`));
        }
        // dsh 注册表对返回值同样要求 lossless JSON：AutoCrew 工具的结果里常带 `undefined` 字段
        // （可选项没值就不写）——2026-09-05 真机第一发 `autocrew_workflow status` 就被判
        // 「value is not lossless JSON」。JSON 往返一次把 undefined/NaN/Date 都归一成纯 JSON。
        return toLosslessJson(result);
      },
    });
  }

  const built = new Set(definitions.map((d) => d.name));
  const missing = PORTED_TOOLS.filter((name) => !built.has(name));

  return { definitions, pending, missing };
}
