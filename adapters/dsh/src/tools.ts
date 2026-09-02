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

/**
 * 第一批进 dsh 的工具。每加一个都要先过它的输出契约（返回形状是否稳定、失败是否
 * 都走 ok:false、有没有 import.meta.url 相对资源），过一个加一个，不整批放行。
 */
export const PORTED_TOOLS: readonly string[] = ["autocrew_status"];

/** 开放对象：只保证「是个对象」，形状随 action 变。 */
const OPEN_OBJECT_SCHEMA = { type: "object" as const, additionalProperties: true };

/**
 * AutoCrew 的参数 schema 是 TypeBox 造的，对象上挂着 `Symbol(TypeBox.Kind)` 一类的
 * own symbol；dsh 注册表投影 schema 时要求「lossless JSON」，见到 symbol 直接抛
 * `parameters must be lossless JSON before schema projection`。JSON 往返一次把
 * symbol 和 undefined 都甩掉，剩下的正好是纯 JSON Schema。
 */
function toLosslessJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function renderJson(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

export interface BuiltTools {
  definitions: ToolDefinition[];
  /** 注册源里存在、但这一批还没放行的工具名——调用方据此打印进度。 */
  pending: string[];
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
        const params = { ...(args as Record<string, unknown>) };
        const result = await runner.execute(tool.name, params);
        if (result.ok === false) {
          throw new Error(String(result.error ?? `${tool.name} failed`));
        }
        return result;
      },
    });
  }

  return { definitions, pending };
}
