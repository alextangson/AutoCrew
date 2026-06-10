# 薄 Loop 引擎 + 进程内生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 [DECISION-engine.md](DECISION-engine.md) 裁决的自研薄 loop 产品化（PRD §5 双层架构的内层），并交付第一个真实消费者：**进程内口播脚本生成**（PRD §5 "进程内生成，单一 model provider"——v1 非技术用户没有宿主 agent，生成必须是产品自己的能力）。

**Architecture:** `src/engine/`（config + loop，OpenAI 兼容协议，注入式 fetch 可测试，预算上限，withRetry 重试）。生成管线 `src/modules/writing/`：koubo 包 + creator profile 组装 prompt → loop 以 **submit_script 工具调用作为结构化输出通道**（spike 已证明 tool-use 可靠）→ always-on humanizer + 违禁词过滤（§7.1）→ 存稿。新工具 `autocrew_generate` 注册进宿主。真实 API 冒烟脚本归 scripts/，不进测试套件。

**Tech Stack:** TypeScript ESM，vitest（mock fetch，零网络），复用 [retry.ts](../../src/utils/retry.ts)（withRetry/checkFetchResponse）。参考实现：[spikes/thin-loop/loop.mts](../../spikes/thin-loop/loop.mts)（192 行已实测，**形状参考，禁止 import**）。

**设计决定（已锁定）：**
- **不做流式**：宿主聊天界面自己流式，我们的工具返回最终结果。v1.5 桌面 UI 时再加（YAGNI，记录在案）。
- **结构化输出 = 工具调用**：模型必须调 `submit_script({title, hook, body, cta, hashtags})`——比"求 JSON + 正则解析"可靠（spike 实证 DeepSeek tool-use 干净），且天然练 loop 的工具机制。
- **强弱双档进 config**（§9 路由）：`strongModel`（核心生成）/`fastModel`（后续过滤打标用），本计划只消费 strong。
- **配置优先级**：`~/.autocrew/engine.json` > 环境变量 `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`。缺 key 报可执行的中文错误。**key 永不入库**——engine.json 在用户数据目录，不在仓库。
- **baseURL 即未来的薄云中转**：v1 dogfood 直连 DeepSeek，正式版只换 config 不换代码（DECISION-engine.md 的路线 A 红利）。
- 与宿主生成（write-script skill）并存：dogfood 期两条路都活，**质量对比本身是 §12 的信号**（宿主 Claude vs 进程内 DeepSeek）。

---

## File Structure

| 文件 | 职责 |
|---|---|
| Create `src/engine/config.ts` + test | EngineConfig 加载（engine.json > env），缺失报错 |
| Create `src/engine/loop.ts` + test | 薄 agent loop：OpenAI 协议、工具执行、预算上限、重试；fetch 注入可测 |
| Create `src/modules/writing/script-prompt.ts` + test | 纯函数：pack + profile + 请求 → system/user prompt |
| Create `src/modules/writing/generate-script.ts` + test | 生成管线：loop + submit_script 捕获 + humanize + 违禁词 + 存稿 |
| Create `src/tools/generate.ts` + test | `autocrew_generate` 工具 |
| Modify `index.ts` | 注册（仅此宿主） |
| Create `scripts/smoke-generate.mts` | 真实 API 冒烟（创始人手跑，不进套件） |
| Modify `docs/dogfood-runbook.md` | 进程内生成 dogfood 章节（双路对比） |

---

### Task 1: EngineConfig

**Files:** Create `src/engine/config.ts`、`src/engine/config.test.ts`

- [ ] **Step 1: failing test**

```typescript
// src/engine/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEngineConfig } from "./config.js";

let testDir: string;
const ENV_KEYS = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-engine-test-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("loadEngineConfig", () => {
  it("reads engine.json from dataDir with full precedence", async () => {
    await fs.writeFile(
      path.join(testDir, "engine.json"),
      JSON.stringify({ apiKey: "sk-file", baseUrl: "https://relay.example.com", strongModel: "m-strong", fastModel: "m-fast" }),
    );
    process.env.DEEPSEEK_API_KEY = "sk-env";
    const c = await loadEngineConfig(testDir);
    expect(c.apiKey).toBe("sk-file");
    expect(c.baseUrl).toBe("https://relay.example.com");
    expect(c.strongModel).toBe("m-strong");
  });

  it("falls back to env with DeepSeek defaults", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-env";
    const c = await loadEngineConfig(testDir);
    expect(c.apiKey).toBe("sk-env");
    expect(c.baseUrl).toBe("https://api.deepseek.com");
    expect(c.strongModel).toBe("deepseek-v4-pro");
    expect(c.fastModel).toBe("deepseek-v4-flash");
  });

  it("partial engine.json merges over env/defaults", async () => {
    await fs.writeFile(path.join(testDir, "engine.json"), JSON.stringify({ strongModel: "m-x" }));
    process.env.DEEPSEEK_API_KEY = "sk-env";
    const c = await loadEngineConfig(testDir);
    expect(c.apiKey).toBe("sk-env");
    expect(c.strongModel).toBe("m-x");
  });

  it("throws actionable error when no key anywhere", async () => {
    await expect(loadEngineConfig(testDir)).rejects.toThrow(/DEEPSEEK_API_KEY|engine\.json/);
  });
});
```

- [ ] **Step 2: run → FAIL（模块缺失）**

- [ ] **Step 3: implement**

```typescript
// src/engine/config.ts
/**
 * 引擎配置 — 进程内生成的 model provider 接入（PRD §9：国产模型 + 薄云中转）。
 * baseUrl 即未来的中转地址：dogfood 直连 DeepSeek，正式版改 engine.json 不改代码。
 * 优先级：<dataDir>/engine.json > 环境变量 > 默认值。key 永不入仓库。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../storage/local-store.js";

export interface EngineConfig {
  apiKey: string;
  baseUrl: string;
  /** 核心生成（口播脚本） */
  strongModel: string;
  /** 过滤/排版/打标（后续计划消费） */
  fastModel: string;
}

const DEFAULTS = {
  baseUrl: "https://api.deepseek.com",
  strongModel: "deepseek-v4-pro",
  fastModel: "deepseek-v4-flash",
};

export async function loadEngineConfig(dataDir?: string): Promise<EngineConfig> {
  let fromFile: Partial<EngineConfig> = {};
  try {
    const raw = await fs.readFile(path.join(getDataDir(dataDir), "engine.json"), "utf-8");
    fromFile = JSON.parse(raw) as Partial<EngineConfig>;
  } catch {
    // 没有 engine.json 是正常的（用 env）
  }
  const apiKey = fromFile.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "引擎未配置 model provider：设置环境变量 DEEPSEEK_API_KEY，或在 ~/.autocrew/engine.json 写入 {\"apiKey\": \"...\"}",
    );
  }
  return {
    apiKey,
    baseUrl: fromFile.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULTS.baseUrl,
    strongModel: fromFile.strongModel ?? DEFAULTS.strongModel,
    fastModel: fromFile.fastModel ?? DEFAULTS.fastModel,
  };
}
```

- [ ] **Step 4: run module + full suite + tsc → 全绿**
- [ ] **Step 5: Commit** — `feat: engine config — provider endpoint as data, relay-ready`

---

### Task 2: 薄 Loop

**Files:** Create `src/engine/loop.ts`、`src/engine/loop.test.ts`

接口合同（参考 spikes/thin-loop/loop.mts 的实测形状，按以下签名产品化）：

```typescript
// src/engine/loop.ts —— 关键导出
export interface LoopTool {
  name: string;
  description: string;
  /** JSON Schema（OpenAI function parameters 格式） */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

export interface LoopOptions {
  model: string;
  systemPrompt: string;
  userMessage: string;
  tools?: LoopTool[];
  /** 默认 6 */
  maxTurns?: number;
  /** 默认 20000 */
  maxTotalTokens?: number;
  /** 测试注入；默认 globalThis.fetch */
  fetchImpl?: typeof fetch;
}

export interface LoopResult {
  finalMessage: string;
  turns: number;
  totalTokens: number;
  toolCallCount: number;
  stopReason: "no_tool_calls" | "max_turns" | "max_tokens";
}

export async function runLoop(config: EngineConfig, opts: LoopOptions): Promise<LoopResult>;
```

实现要求（spike 代码为骨架，叠加产品化三角）：
1. **重试**：每次 fetch 包 `withRetry`（[retry.ts](../../src/utils/retry.ts)），响应经 `checkFetchResponse(res, "engine loop")`（429/5xx 抛 RetryableError 自动重试，4xx 客户端错误直接抛）。
2. **预算**：turns 与 totalTokens 上限同 spike 语义（token 超限在轮首检查；maxTurns 到达时 stopReason="max_turns"）。
3. **工具执行**：单轮多个 tool_calls 顺序执行；单个工具抛错 → 该 tool 消息为 `Error: <msg>`，loop 继续（模型自纠）；JSON.parse(arguments) 失败同样转 Error 消息。
4. **消息构造**：assistant 消息保留 tool_calls；tool 消息带 tool_call_id + name——与 spike 相同（DeepSeek 实测接受）。
5. 函数 <50 行：拆 `callModel`（fetch+retry+解析）与 `executeToolCalls` 两个私有 helper。

- [ ] **Step 1: failing tests** — mock fetch 全覆盖，零网络：

```typescript
// src/engine/loop.test.ts
import { describe, it, expect } from "vitest";
import { runLoop, type LoopTool } from "./loop.js";
import type { EngineConfig } from "./config.js";

const CFG: EngineConfig = { apiKey: "sk-test", baseUrl: "https://fake.local", strongModel: "m", fastModel: "f" };

/** 按顺序回放的 mock fetch；记录每次请求体 */
function mockFetch(responses: Array<Record<string, unknown>>, captured: Array<Record<string, unknown>> = []) {
  let i = 0;
  const impl = (async (_url: unknown, init?: { body?: string }) => {
    captured.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { impl, captured };
}

function completion(content: string | null, toolCalls?: Array<{ id: string; name: string; args: string }>, tokens = 100) {
  return {
    id: "x",
    choices: [
      {
        message: {
          role: "assistant",
          content,
          tool_calls: toolCalls?.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args } })),
        },
        finish_reason: toolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: tokens / 2, completion_tokens: tokens / 2, total_tokens: tokens },
  };
}

describe("runLoop", () => {
  it("single turn without tools", async () => {
    const { impl, captured } = mockFetch([completion("你好，这是脚本")]);
    const r = await runLoop(CFG, { model: "m", systemPrompt: "sys", userMessage: "写一段", fetchImpl: impl });
    expect(r.finalMessage).toBe("你好，这是脚本");
    expect(r.stopReason).toBe("no_tool_calls");
    expect(r.turns).toBe(1);
    expect((captured[0].messages as unknown[]).length).toBe(2); // system + user
  });

  it("executes tool calls and feeds results back", async () => {
    const calls: unknown[] = [];
    const tool: LoopTool = {
      name: "echo",
      description: "回声",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: (args) => {
        calls.push(args);
        return `echo:${args.text}`;
      },
    };
    const { impl, captured } = mockFetch([
      completion(null, [{ id: "t1", name: "echo", args: '{"text":"hi"}' }]),
      completion("完成"),
    ]);
    const r = await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", tools: [tool], fetchImpl: impl });
    expect(calls).toEqual([{ text: "hi" }]);
    expect(r.toolCallCount).toBe(1);
    expect(r.finalMessage).toBe("完成");
    const secondMsgs = captured[1].messages as Array<{ role: string; content?: string }>;
    expect(secondMsgs.some((m) => m.role === "tool" && m.content === "echo:hi")).toBe(true);
  });

  it("tool error becomes an Error message, loop continues", async () => {
    const tool: LoopTool = {
      name: "boom",
      description: "炸",
      parameters: { type: "object", properties: {} },
      execute: () => {
        throw new Error("内部失败");
      },
    };
    const { impl, captured } = mockFetch([
      completion(null, [{ id: "t1", name: "boom", args: "{}" }]),
      completion("已绕过"),
    ]);
    const r = await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", tools: [tool], fetchImpl: impl });
    expect(r.finalMessage).toBe("已绕过");
    const secondMsgs = captured[1].messages as Array<{ role: string; content?: string }>;
    expect(secondMsgs.some((m) => m.role === "tool" && m.content?.startsWith("Error:"))).toBe(true);
  });

  it("malformed tool arguments become an Error message", async () => {
    const tool: LoopTool = { name: "x", description: "x", parameters: { type: "object", properties: {} }, execute: () => "ok" };
    const { impl, captured } = mockFetch([
      completion(null, [{ id: "t1", name: "x", args: "{broken" }]),
      completion("done"),
    ]);
    await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", tools: [tool], fetchImpl: impl });
    const secondMsgs = captured[1].messages as Array<{ role: string; content?: string }>;
    expect(secondMsgs.some((m) => m.role === "tool" && m.content?.startsWith("Error:"))).toBe(true);
  });

  it("stops at maxTurns", async () => {
    const tool: LoopTool = { name: "again", description: "x", parameters: { type: "object", properties: {} }, execute: () => "go" };
    const { impl } = mockFetch([completion(null, [{ id: "t", name: "again", args: "{}" }])]); // 永远要求工具
    const r = await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", tools: [tool], maxTurns: 3, fetchImpl: impl });
    expect(r.turns).toBe(3);
    expect(r.stopReason).toBe("max_turns");
  });

  it("stops when token budget exhausted", async () => {
    const tool: LoopTool = { name: "again", description: "x", parameters: { type: "object", properties: {} }, execute: () => "go" };
    const { impl } = mockFetch([completion(null, [{ id: "t", name: "again", args: "{}" }], 6000)]);
    const r = await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", tools: [tool], maxTotalTokens: 10000, fetchImpl: impl });
    expect(r.stopReason).toBe("max_tokens");
    expect(r.totalTokens).toBeLessThanOrEqual(12000); // 第二轮轮首被拦
  });

  it("non-retryable API error throws with status", async () => {
    const impl = (async () => new Response("bad key", { status: 401 })) as typeof fetch;
    await expect(
      runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", fetchImpl: impl }),
    ).rejects.toThrow(/401/);
  });

  it("retries 429 then succeeds", async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      if (n === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify(completion("ok")), { status: 200 });
    }) as typeof fetch;
    const r = await runLoop(CFG, { model: "m", systemPrompt: "s", userMessage: "u", fetchImpl: impl });
    expect(r.finalMessage).toBe("ok");
    expect(n).toBe(2);
  });
});
```

- [ ] **Step 2: run → FAIL**
- [ ] **Step 3: implement**（spike 骨架 + 上述五点产品化；`tools` 序列化为 OpenAI `tools` 数组，空数组时不传 tools 字段）
- [ ] **Step 4: module + full + tsc 全绿**
- [ ] **Step 5: Commit** — `feat: thin agent loop — budget-capped, retrying, injectable-fetch (DECISION-engine route A)`

---

### Task 3: 口播 Prompt 组装

**Files:** Create `src/modules/writing/script-prompt.ts`、`script-prompt.test.ts`

```typescript
// 导出合同
export interface ScriptRequest {
  topic: string;
  platform: ClipboardPlatform;
  /** 调研材料（可选，RAW 注入） */
  research?: string;
}
export function buildScriptPrompts(
  pack: TrackPack,
  profile: CreatorProfile | null,
  req: ScriptRequest,
): { system: string; user: string };
```

system prompt 必须包含（测试逐项断言子串）：
- 角色定语「口播脚本编剧」+ 赛道名（pack.name）
- pack.hooks 全部 type+whenToUse（指示"只选一种最强"）
- pack.structure.hook/body/cta 全部规则行
- 该平台的 platformAdjustments（无该平台条目则跳过）
- profile 的 writingRules（rule 文本逐条）与 styleBoundaries.never/always（profile 为 null 则跳过且不崩）
- pack.complianceNote
- 指示：**必须调用 submit_script 工具提交成品，不要把脚本写在普通回复里**

user prompt：选题 + (research ?? 提示"无调研材料，基于常识写但避免编造数据") + 平台名。

测试：koubo 包 + 构造 profile（2 条 writingRules）→ 断言上述子串；profile null 不崩；research 缺省走提示语。纯函数零 IO。

- [ ] TDD 四步 + Commit — `feat: script prompt assembly — pack + profile drive the writer`

---

### Task 4: 生成管线

**Files:** Create `src/modules/writing/generate-script.ts`、`generate-script.test.ts`

```typescript
export interface GeneratedScript {
  contentId: string;
  title: string;
  body: string;        // hook + 正文 + CTA 组装后、humanize 后的最终文本
  hashtags: string[];
  violations: string[]; // 违禁词命中（不阻断存稿，透出给上层）
  tokensUsed: number;
}
export async function generateScript(req: ScriptRequest, dataDir?: string): Promise<GeneratedScript>;
```

实现：
1. `loadEngineConfig` + `getPack(DEFAULT_PACK_ID)` + `loadProfile`。
2. `buildScriptPrompts` → `runLoop(config, { model: config.strongModel, tools: [submitScriptTool], maxTurns: 4 })`。
3. **submit_script 工具 = 结构化输出通道**：parameters 要求 `{title, hook, body, cta, hashtags: string[]}` 全必填；execute 闭包捕获 payload，缺字段时返回 `Error: 缺少字段 <名>，请补全后重新调用 submit_script`（给模型自纠机会）；成功返回 `已收到脚本`。
4. loop 结束后未捕获 payload → 抛错（上层工具转 ok:false）。
5. 组装 `body = hook + "\n\n" + body正文 + "\n\n" + cta`；过 humanizer（**先 grep src/modules/humanizer/zh.ts 的实际导出签名再接**）；过 sensitive-words（同样先查签名）得 violations。
6. 存稿：复用 write-script 流程的同款保存路径（**先看 src/tools/content-save.ts 的 executeContentSave 或 local-store saveContent 的现行用法**，与现有草稿状态机一致，status 用现有草稿初始态），hashtags 入 hashtags 字段。
7. 测试全部 mock：注入假 loop？——generate-script 直接调 runLoop 不便注入，**把 runLoop 作为可选参数注入**（`deps?: { runLoopImpl?: typeof runLoop }`，默认真实现），测试给假实现回放 submit_script 调用。覆盖：happy path（存稿成功、violations 空）；模型漏字段后自纠（第一次缺 cta → Error 消息 → 第二次全量）；终未提交 → 抛错；违禁词命中 → violations 非空但稿已存。

- [ ] TDD 四步 + Commit — `feat: in-process script generation — pack-driven, tool-call structured output`

---

### Task 5: autocrew_generate 工具 + 冒烟 + runbook + 收尾

**Files:** Create `src/tools/generate.ts`、`src/tools/generate.test.ts`、`scripts/smoke-generate.mts`；Modify `index.ts`、`docs/dogfood-runbook.md`

1. 工具：typebox schema `action: "script"`，`topic`（必填）、`platform`（必填，校验在 PLATFORM_MAPPINGS 或 ClipboardPlatform 集内）、`research`（可选）；execute → generateScript → `{ok: true, data: {contentId, title, body, hashtags, violations, tokensUsed}}`；引擎未配置/生成失败 → `{ok: false, error}`（error 必须把 loadEngineConfig 的可执行提示透传）。测试：mock generateScript（同 Task 4 的注入模式）覆盖成功/缺参/引擎未配置三路。
2. index.ts 注册（仅此处；描述写明"in-process generation via configured provider"）。
3. `scripts/smoke-generate.mts`：读真实 env，跑一条真实生成（topic 写死「AI 时代普通人最该练的一个技能」，platform douyin），打印脚本 + tokensUsed + violations。头注释：`手跑冒烟，消耗真实 API 配额，不进测试套件`。
4. runbook 新章节「七、进程内生成 dogfood」：怎么跑（autocrew_generate / smoke 脚本）；**双路对比试验**——同一选题分别让宿主（write-script skill）和引擎（autocrew_generate）各写一稿，记录哪稿编辑量更小（这是 §12 学习代理指标 + 模型路由质量的直接证据）；engine.json 配置示例（key 永不入库）。
5. 终验：`npx vitest run`（预计 ~320+）+ `npx tsc --noEmit` 0。
- [ ] Commit — `feat: autocrew_generate tool + smoke script — in-process generation dogfoodable`

---

## Self-Review Checklist（自查）

1. **Spec 覆盖**：PRD §5 内层 loop（预算上限 ✓ 自研 ✓ src/runtime 之上——注：loop 不依赖 ToolRunner（那是宿主工具层），与 §5 表述的关系是"引擎层并列组件"，DECISION-engine 已确认此口径）；§5 进程内生成 ✓；§9 强弱双档 config ✓、baseURL=中转 ✓；§7.1 always-on 去AI味+违禁词 ✓；赛道包消费 ✓。
2. **占位符**：Task 3/4 用合同+要点而非全量代码（实现规模超出计划可承载），但每个断言/分支/签名都已写死，无 TBD。Task 4 明确要求实现者先核对 humanizer/sensitive-words/存稿的真实签名再接线——这是查证指令不是占位。
3. **类型一致性**：ScriptRequest 在 T3 定义、T4/T5 复用；LoopTool/LoopResult 在 T2 定义、T4 消费；EngineConfig 在 T1 定义、T2/T4 消费。执行顺序 = 文档顺序（无交叉依赖倒置）。
4. **已知边界**：不做流式；fastModel 本计划不消费（防丢失：已在 config 注释标注消费者是后续过滤/打标）；分镜不单独结构化（douyin 的 [画面]/[口播]/[字幕条] 格式由 pack platformAdjustments 经 prompt 驱动，存稿为纯文本）。
