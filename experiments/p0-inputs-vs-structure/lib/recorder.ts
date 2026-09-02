/**
 * runLoop 录音器 + 审稿开关。
 *
 * 两件事都靠同一个包装：generateScript 只暴露 `deps.runLoopImpl` 一个注入口，
 * 写手/审稿/改稿三轮都从它过。
 *
 * 1) 录音：把每轮实际发出的 system/user、端点、模型、token、stopReason 记下来，
 *    落进 meta.json。盲评看到分数不一样时，唯一能回答「到底喂了什么」的就是这份记录。
 * 2) 审稿开关：src 里**没有**关审稿的旗标——reviewAndConverge 是无条件调的
 *    （generate-script.ts runGeneration 里写死）。消融格不改生产代码，改成在这一层
 *    把 agent==="reviewer" 的那轮短路掉：不发请求、不调 submit_review 就返回，
 *    reviewAndConverge 自己会判成 status="skipped" 并原样交回写手稿。
 *    改稿轮（reviser）永远发生在审稿出 blocker 之后，审稿短路了它自然也不跑 = 只剩写手。
 */
import type { runLoop as RunLoop, LoopResult } from "../../../src/engine/loop.js";

export interface RecordedCall {
  /** writer / reviewer / reviser / direct-writer；缺省 unknown */
  agent: string;
  baseUrl: string;
  model: string;
  protocol: string;
  system: string;
  user: string;
  turns: number;
  totalTokens: number;
  toolCallCount: number;
  stopReason: string;
  durationMs: number;
  /** 这轮被消融开关短路了（没有真的发请求） */
  shortCircuited?: boolean;
}

export interface RecorderOptions {
  /** true = 关审稿（消融格）：reviewer 轮直接空转返回 */
  disableReview: boolean;
  /** 底层实现；冒烟测试传 mock，真跑传 runLoop */
  impl: typeof RunLoop;
}

const EMPTY: LoopResult = {
  finalMessage: "",
  turns: 0,
  totalTokens: 0,
  toolCallCount: 0,
  stopReason: "no_tool_calls",
};

export function createRecorder(opts: RecorderOptions): { runLoopImpl: typeof RunLoop; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const runLoopImpl: typeof RunLoop = async (config, options) => {
    const agent = options.logMeta?.agent ?? "unknown";
    const base = {
      agent,
      baseUrl: config.baseUrl,
      model: options.model,
      protocol: config.protocol ?? "openai",
      system: options.systemPrompt,
      user: options.userMessage,
    };

    if (opts.disableReview && agent === "reviewer") {
      calls.push({ ...base, ...EMPTY, stopReason: "no_tool_calls", durationMs: 0, shortCircuited: true });
      return EMPTY;
    }

    const startedAt = Date.now();
    const result = await opts.impl(config, options);
    calls.push({
      ...base,
      turns: result.turns,
      totalTokens: result.totalTokens,
      toolCallCount: result.toolCallCount,
      stopReason: result.stopReason,
      durationMs: Date.now() - startedAt,
    });
    return result;
  };

  return { runLoopImpl, calls };
}
