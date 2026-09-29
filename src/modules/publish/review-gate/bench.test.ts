/** 上线前评测（spec §10）：评测集按视频分组、每问题正反各 ≥5；假 Jev 下误报 / 漏报 / 弃权 / 没跑成计得对 */
import { describe, expect, it } from "vitest";
import { benchMarkdown, buildBenchSet, runBench, summarizeBench, type BenchVideo } from "./bench.js";
import { basisFromSrt } from "./subtitles.js";
import { JevError, type JevAnswer, type JevCaller } from "./jev-client.js";

const srt = (lines: string[]) => lines.map((l, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i + 1},000\n${l}`).join("\n\n");
const videos: BenchVideo[] = Array.from({ length: 5 }, (_, i) => ({
  id: `content-${i}`, title: `第 ${i} 条视频的标题`,
  basis: basisFromSrt(srt([`开头的一句玩笑话 ${i}`, `这是第 ${i} 条视频中间讲的正事`, `结尾总结第 ${i} 条`])),
  entries: [{ platform: "douyin", label: "抖音", title: `第 ${i} 条的发布标题`, caption: `第 ${i} 条的发布文案，讲清楚这期内容` }],
}));

/** 「完美」假 Jev：按问题语义答对 */
const perfect: JevCaller = async (state, questions) => {
  const s = JSON.stringify(state);
  const answers: Record<string, JevAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const ins = JSON.stringify(q.instructions);
    if (id === "a1") { const ok = /"post_title":"第 (\d) 条/.exec(s)?.[1] === /第 (\d) 条视频中间/.exec(s)?.[1]; answers[id] = { type: "choice", choice: ok ? "准确" : "误导", probabilities: { [ok ? "准确" : "误导"]: 0.9 }, confidence: 0.9 }; }
    else if (id.startsWith("a2_")) answers[id] = { type: "noul", noul: ins.includes("73%") ? 0.05 : 0.95 };
    else if (id.startsWith("s")) answers[id] = { type: "choice", choice: "封面", probabilities: { 封面: 0.4, 平台集合: 0.3, 排期: 0.3 }, confidence: 0.5 };
    else if (id.startsWith("v")) {
      const bad = (ins.includes("3:4") && s.includes("\"比例\":\"4:3\"") && ins.includes("封面\""))
        || (ins.includes("都发") && s.includes("\"平台集合\":[\"抖音\"]") && ins.includes("平台集合"))
        || (ins.includes("晚上 8 点") && s.includes("T09:00") && ins.includes("排期"));
      answers[id] = { type: "noul", noul: bad ? 0.95 : 0.03 };
    } else if (id.startsWith("o")) answers[id] = { type: "noul", noul: ins.includes("横版封面") ? 0.9 : 0.1 };
  }
  return { model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 1 }, ms: 1 };
};

describe("评测集", () => {
  it("按视频分组；每个问题正反各 ≥5 例", () => {
    const cases = buildBenchSet(videos);
    for (const q of ["A1", "A2", "B", "O"]) {
      for (const e of ["positive", "negative"]) expect(cases.filter((c) => c.question === q && c.expect === e).length).toBeGreaterThanOrEqual(5);
    }
    expect(new Set(cases.map((c) => c.video))).toEqual(new Set(videos.map((v) => v.id)));
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });
});

describe("跑与汇总", () => {
  it("完美的假 Jev：没有误报漏报；概率分布按正反例列出", async () => {
    const cases = buildBenchSet(videos);
    const stats = summarizeBench(await runBench(cases, videos, perfect));
    for (const s of stats) expect({ q: s.question, fp: s.false_positive, fn: s.false_negative, nr: s.not_run }).toEqual({ q: s.question, fp: 0, fn: 0, nr: 0 });
    expect(stats.find((s) => s.question === "A2")!.neg_probs.every((p) => p < 0.5)).toBe(true);
  });

  it("全说「没问题」的假 Jev：反例全成漏报；失败的调用计没跑成；报告按视频分表", async () => {
    const lazy: JevCaller = async (_s, questions) => ({ model: "jev-1.13.0", usage: { input_tokens: 1, output_tokens: 0 }, ms: 1, answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, q.type === "noul" ? { type: "noul", noul: id.startsWith("v") ? 0 : 1 } : { type: "choice", choice: Object.keys(q.criteria)[0], probabilities: { [Object.keys(q.criteria)[0]]: 1 }, confidence: 1 } ])) as Record<string, JevAnswer> });
    const cases = buildBenchSet(videos);
    const results = await runBench(cases, videos, lazy);
    const stats = summarizeBench(results);
    const a1 = stats.find((s) => s.question === "A1")!;
    expect(a1.false_negative).toBe(a1.negatives);
    expect(a1.false_positive).toBe(0);
    const failing: JevCaller = async () => { throw new JevError("没配 TypeSafe 密钥"); };
    const nr = summarizeBench(await runBench(cases.slice(0, 3), videos, failing));
    expect(nr.reduce((n, s) => n + s.not_run, 0)).toBe(3);
    const md = benchMarkdown(stats, results, { videos: 5, model: "jev-1.13.0", at: "t", tokens: 1 });
    expect(md).toContain("| A1 |");
    expect(md).toContain("## 按视频");
    expect(md).toContain("content-0");
  });
});
