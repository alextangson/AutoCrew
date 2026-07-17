/**
 * 阶段 2 冒烟：生产 runLoop（pi-ai 引擎）→ 观察器 → 真实 newcli 中转，带工具往返。
 * 检验点：anthropic 工具 wire（含 eager_input_streaming 附加字段）真 relay 接受、
 * tool_use → tool_result 往返、usage/预算、finalMessage。fastModel + 小任务，成本忽略。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runLoop, type LoopTool } from "../../src/engine/loop.ts";

const cfg = JSON.parse(await fs.readFile(path.join(os.homedir(), ".autocrew/engine.json"), "utf8")) as {
  apiKey: string;
  baseUrl: string;
  fastModel: string;
};

const seen: unknown[] = [];
const clock: LoopTool = {
  name: "get_signal",
  description: "获取当前信号值（测试工具）",
  parameters: { type: "object", properties: {}, required: [] },
  execute: () => {
    seen.push(1);
    return "信号值:42";
  },
};

const r = await runLoop(
  { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, strongModel: cfg.fastModel, fastModel: cfg.fastModel, protocol: "anthropic" },
  {
    model: cfg.fastModel,
    systemPrompt: "你是连通性测试助手。必须先调用 get_signal 工具获取信号值，然后只回复\"信号是<值>\"。",
    userMessage: "开始",
    tools: [clock],
    maxTurns: 3,
  },
);

console.log("A5 finalMessage:", JSON.stringify(r.finalMessage));
console.log("A5 turns:", r.turns, "| toolCalls:", r.toolCallCount, "| totalTokens:", r.totalTokens, "| stopReason:", r.stopReason);
const pass = r.toolCallCount >= 1 && seen.length >= 1 && r.finalMessage.includes("42") && r.totalTokens > 0;
console.log(pass ? "A5 PASS" : "A5 FAIL");
process.exit(pass ? 0 : 1);
