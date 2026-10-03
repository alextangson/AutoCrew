/** 校准测试共用的假盲评通道与预测主体（不是测试文件） */
import { ALL_DIMS } from "./rubric.js";

export const SELF = { ER: 3, SR: 3, HP: 3, QL: 3, NA: 3, AB: 3, SAT: 3, MS: 2, TS: 3 };
export function fakeLoop(scores: Record<string, number>, captured: Array<{ config: unknown; opts: Record<string, unknown> }> = []) {
  return (async (config: unknown, opts: { tools: Array<{ execute: (a: Record<string, unknown>) => unknown }> } & Record<string, unknown>) => {
    captured.push({ config, opts });
    const dims = Object.fromEntries(ALL_DIMS.map((d) => [d, { score: scores[d], confidence: "medium", reason: "开头那句加班赶周报" }]));
    await opts.tools[0].execute({ dimensions: JSON.stringify(dims) });
    return { finalMessage: "", turns: 1, totalTokens: 1, toolCallCount: 1, stopReason: "no_tool_calls" };
  }) as never;
}
export const BODY = (buckets: string[]) => ({
  prediction: { bucket: buckets[1], distribution: { [buckets[0]]: 30, [buckets[1]]: 40, [buckets[2]]: 20, [buckets[3]]: 8, [buckets[4]]: 2 }, center: 500, reason: "钩子具体但议题偏窄" },
  factors: [{ factor: "钩子", direction: "+", confidence: "中", note: "开头场景具体" }],
  counterfactuals: Object.fromEntries(buckets.map((b) => [b, `落在${b}说明…`])),
  hypothesis: "赌具体场景钩子能撑住前 3 秒",
});

process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "test-key";
