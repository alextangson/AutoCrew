/** 校准测试共用的假盲评通道与预测主体（不是测试文件） */
import fs from "node:fs/promises";
import path from "node:path";
import { getConfigDir } from "../../storage/storage-roots.js";
import { saveContent } from "../../storage/local-store.js";
import { appendOutcomes } from "../flywheel/outcome-store.js";
import { commitPrediction } from "./commit.js";
import { blindStep, bucketsFor } from "./predict.js";
import { ALL_DIMS } from "./rubric.js";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";

const DAY = 86_400_000;

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

export async function predictPublished(d: string, views: number | null, title = "AI 周报", scores: Record<string, number> = SELF, skipBlind = false) {
  const published = new Date(Date.now() - 1 * DAY);
  const c = await saveContent({ _provenance: HUMAN_WRITE, title, body: "下班前领导一句明早给我……", platform: "douyin", status: "draft_ready", tags: [], publishedAt: published.toISOString() } as never, d);
  const b = await blindStep({ content_id: c.id, self_scores: scores, seen_data: false, skip_blind: skipBlind }, d, { runLoopImpl: fakeLoop(scores) });
  const scheme = await bucketsFor("douyin", d);
  const body = BODY(scheme.buckets.map((x) => x.name));
  body.prediction.center = Math.floor((scheme.buckets[1].min + (scheme.buckets[1].max as number)) / 2);
  const p = await commitPrediction({ blind_run_id: b.blind_run_id, seen_data: false, ...body }, d);
  if (views !== null) {
    await appendOutcomes([{ contentId: c.id, platform: "douyin", platformTitle: title, publishedAt: published.toISOString(), metricDate: new Date(published.getTime() + 3 * DAY).toISOString().slice(0, 10), metrics: { views, likes: 3 }, source: "auto", recordedAt: "", needsReview: false, reviewReasons: [] }], d);
  }
  return { c, p, later: new Date(Date.now() + 3 * DAY) };
}


export async function engine(dir: string, withReviewer: boolean, fallbackToReviewer = false) {
  const cfg = { apiKey: "k", baseUrl: "https://main.example", strongModel: "s", fastModel: "f", protocol: "openai",
    ...(fallbackToReviewer ? { fallback: { baseUrl: "https://api.deepseek.com", apiKey: "k2", strongModel: "deepseek-v4-pro", fastModel: "deepseek-flash", protocol: "openai" } } : {}),
    ...(withReviewer ? { routes: { reviewer: { baseUrl: "https://api.deepseek.com", apiKey: "k2", model: "deepseek-v4-pro", protocol: "openai" } } } : {}) };
  await fs.mkdir(getConfigDir(dir), { recursive: true });
  await fs.writeFile(path.join(getConfigDir(dir), "engine.json"), JSON.stringify(cfg));
}
export const audit = (verdict: string, calls: unknown[] = []) => (async (config: unknown, opts: { tools: Array<{ execute: (a: Record<string, unknown>) => unknown }> }) => {
  calls.push(config);
  await opts.tools[0].execute({ verdict, reason: "理由".repeat(60) });
  return { finalMessage: "", turns: 1, totalTokens: 1, toolCallCount: 1, stopReason: "no_tool_calls" };
}) as never;

