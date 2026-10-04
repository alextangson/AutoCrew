/** Codex 审查 13 条的回归测试（每条先复现失败，再验证修复） */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { saveContent } from "../../storage/local-store.js";
import { buildGateSamples, proposeBump } from "./bump.js";
import { commitPrediction } from "./commit.js";
import { benchmarkInbox, learnPrepare } from "./learn-from.js";
import { observe } from "./observations.js";
import { readObservations } from "./obs-store.js";
import { calibrationPool } from "./pool.js";
import { blindStep } from "./predict.js";
import { retro } from "./retro.js";
import { calibrationDir, ensureCalibration, readLog } from "./store.js";
import { audit, BODY, engine, fakeLoop, predictPublished, SELF } from "./test-fixtures.js";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";

const DAY = 86_400_000;
const NAMES = ["底部", "基础盘", "命中", "小爆", "大爆"];
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "calib-fix-")); });
const mk = (publishedAt: string | null = null) => saveContent({ _provenance: HUMAN_WRITE, title: "AI 周报", body: "正文", platform: "douyin", status: "draft_ready", tags: [], publishedAt } as never, dir);
const ER_HEAVY = { weights: { ER: 3, SR: 1.5, HP: 1.5, QL: 1, NA: 1, AB: 1, SAT: 1 }, divisor: 10, multiplier: 2 };
async function seedPool(n: number, skipFirst = false) {
  for (let i = 0; i < n; i++) {
    const { p, later } = await predictPublished(dir, 100 * (i + 1) ** 2, `样本${i}`, { ...SELF, ER: i, MS: i }, skipFirst && i === 0);
    await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x", observations: i === 0 ? ["开头给具体场景更留人"] : [] }, dir, later);
  }
}

describe("P1", () => {
  it("#1 原始观察不进 rubric.json；发布抽象规则要过校验", async () => {
    const r = await observe({ op: "add", text: "样本《AI 周报》点赞 9999，评论说太精彩了，https://example.com/video" }, dir);
    expect((await ensureCalibration(dir)).rubric.observations).toEqual([]);
    await expect(observe({ op: "publish", id: r.id, rule: "《AI 周报》那种开头更好" }, dir)).rejects.toThrow(/抽象/);
    await expect(observe({ op: "publish", id: r.id, rule: "点赞 9999 的开头" }, dir)).rejects.toThrow(/抽象/);
    await observe({ op: "publish", id: r.id, rule: "开头给具体场景比给概念更留人" }, dir);
    expect((await ensureCalibration(dir)).rubric.observations.map((o) => o.text)).toEqual(["开头给具体场景比给概念更留人"]);
  });
  it("#2 被改过的盲评记录不能落预测", async () => {
    const c = await mk();
    const b = await blindStep({ content_id: c.id, self_scores: SELF }, dir, { runLoopImpl: fakeLoop(SELF) });
    const f = path.join(calibrationDir(dir), "blind-runs.jsonl");
    await fs.writeFile(f, (await fs.readFile(f, "utf-8")).replace(/"score":3/, "\"score\":5"));
    await expect(commitPrediction({ blind_run_id: b.blind_run_id, ...BODY(NAMES) }, dir)).rejects.toThrow(/完整性/);
  });
  it("#3 D+1 盲评、D+5 才落 → 记 reconstructed，不进池、不等复盘", async () => {
    const c = await mk(new Date(Date.now() - 1 * DAY).toISOString());
    const b = await blindStep({ content_id: c.id, self_scores: SELF, seen_data: false }, dir, { runLoopImpl: fakeLoop(SELF) });
    const r = await commitPrediction({ blind_run_id: b.blind_run_id, seen_data: false, ...BODY(NAMES) }, dir, new Date(Date.now() + 4 * DAY));
    expect(r.reconstructed).toBe(true);
    expect((await ensureCalibration(dir)).state.pending_retros).toEqual([]);
    const c2 = await mk(new Date(Date.now() - 1 * DAY).toISOString());
    const b2 = await blindStep({ content_id: c2.id, self_scores: SELF, seen_data: false }, dir, { runLoopImpl: fakeLoop(SELF) });
    expect((await commitPrediction({ blind_run_id: b2.blind_run_id, seen_data: true, ...BODY(NAMES) }, dir)).reconstructed).toBe(true);
  });
  it("#4 并发两个升级只落一个", async () => {
    await engine(dir, true);
    await seedPool(5);
    const rs = await Promise.all([1, 2].map(() => proposeBump({ formula: ER_HEAVY, kind: "default-aligned" }, dir, { auditLoop: audit("PASS") })));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect((await ensureCalibration(dir)).rubric.version).toBe("v2.1");
  });
  it("#5/#6 补打的维度分按版本留存，下次门用它；审计看到的是生效分", async () => {
    await engine(dir, true);
    await seedPool(5, true);
    const withMs = { weights: { ...ER_HEAVY.weights, MS: 1 }, divisor: 11, multiplier: 2 };
    const calls: Array<{ opts: Record<string, unknown> }> = [];
    const auditCapture = (async (_c: unknown, opts: Record<string, unknown> & { tools: Array<{ execute: (a: Record<string, unknown>) => unknown }> }) => {
      calls.push({ opts });
      await opts.tools[0].execute({ verdict: "PASS", reason: "理由".repeat(60) });
      return { finalMessage: "", turns: 1, totalTokens: 1, toolCallCount: 1, stopReason: "no_tool_calls" };
    }) as never;
    const r = await proposeBump({ formula: withMs, kind: "default-aligned" }, dir, { auditLoop: auditCapture, blindLoop: fakeLoop({ ...SELF, MS: 1 }) });
    expect(r.ok).toBe(true);
    const pool = await calibrationPool(dir);
    const first = pool.find((s) => s.prediction.title === "样本0")!;
    const payload = String(calls[0].opts.userMessage);
    const rows = JSON.parse(payload.split("校准池（维度分、实绩）：\n")[1].split("\n\n")[0]) as Array<{ id: string; scores: { MS: number } }>;
    expect(rows.find((x) => x.id === first.prediction.id)!.scores.MS).toBe(1);
    const { rubric } = await ensureCalibration(dir);
    const again = await buildGateSamples(pool, rubric.formula, withMs, dir, { blindLoop: (async () => { throw new Error("不该再补打"); }) as never });
    expect(again.samples.find((s) => s.id === first.prediction.id)!.scores.MS).toBe(1);
  });
});

describe("P2", () => {
  it("#7 盲评落到备用（=审计线路）时，审计不算独立", async () => {
    await engine(dir, true, true);
    let er = 0;
    const fb = (async (c: unknown, opts: Record<string, unknown> & { tools: Array<{ execute: (a: Record<string, unknown>) => unknown }> }) => {
      const r = await (fakeLoop({ ...SELF, ER: er }) as unknown as (c: unknown, o: unknown) => Promise<Record<string, unknown>>)(c, opts);
      return { ...r, usedFallback: { role: "x", from: "f", to: "deepseek-flash", error: "502" } };
    }) as never;
    for (let i = 0; i < 5; i++) {
      er = i;
      const pub = new Date(Date.now() - DAY);
      const c = await mk(pub.toISOString());
      const b = await blindStep({ content_id: c.id, self_scores: { ...SELF, ER: i }, seen_data: false }, dir, { runLoopImpl: fb });
      expect((await readLog<{ endpoint: string }>("blind-runs", dir)).records.at(-1)!.endpoint).toBe("https://api.deepseek.com");
      const p = await commitPrediction({ blind_run_id: b.blind_run_id, seen_data: false, decisions: {}, ...BODY(NAMES) }, dir);
      await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x", manual_metrics: { views: 100 * (i + 1) ** 2 } }, dir, new Date(Date.now() + 3 * DAY));
    }
    const r = await proposeBump({ formula: ER_HEAVY, kind: "default-aligned" }, dir, { auditLoop: audit("PASS") });
    expect(r).toMatchObject({ ok: false, step: 4 });
    expect(String(r.error)).toMatch(/盲评/);
  });
  it("#8 并发复盘只算一次样本", async () => {
    const { p, later } = await predictPublished(dir, 800);
    const rs = await Promise.all([1, 2].map(() => retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x" }, dir, later)));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect((await ensureCalibration(dir)).state.calibration_samples).toBe(1);
  });
  it("#9 先跑两次盲评再落，第二条不能变成另一条生效预测", async () => {
    const c = await mk();
    const b1 = await blindStep({ content_id: c.id, self_scores: SELF }, dir, { runLoopImpl: fakeLoop(SELF) });
    const b2 = await blindStep({ content_id: c.id, self_scores: SELF }, dir, { runLoopImpl: fakeLoop(SELF) });
    await commitPrediction({ blind_run_id: b1.blind_run_id, ...BODY(NAMES) }, dir);
    await expect(commitPrediction({ blind_run_id: b2.blind_run_id, ...BODY(NAMES) }, dir)).rejects.toThrow(/redo_of/);
  });
  it("#10 absorbs_observations 传 JSON 串照收；坏的打回", async () => {
    await engine(dir, true);
    await seedPool(5);
    const { live } = await readObservations(dir);
    await expect(proposeBump({ formula: ER_HEAVY, kind: "default-aligned", absorbs_observations: "[bad" }, dir, { auditLoop: audit("PASS") })).rejects.toThrow(/JSON/);
    await expect(proposeBump({ formula: ER_HEAVY, kind: "default-aligned", absorbs_observations: "{\"a\":1}" }, dir, { auditLoop: audit("PASS") })).rejects.toThrow(/数组/);
    const r = await proposeBump({ formula: ER_HEAVY, kind: "default-aligned", absorbs_observations: JSON.stringify([live[0].id]) }, dir, { auditLoop: audit("PASS") });
    expect(r.ok).toBe(true);
    expect((await readObservations(dir)).tombstones).toHaveLength(1);
  });
  it("#11 删掉末尾记录也能读出来", async () => {
    await predictPublished(dir, 800);
    await predictPublished(dir, 900, "二");
    const f = path.join(calibrationDir(dir), "predictions.jsonl");
    const lines = (await fs.readFile(f, "utf-8")).trim().split("\n");
    await fs.writeFile(f, `${lines.slice(0, -1).join("\n")}\n`);
    expect((await readLog("predictions", dir)).integrity.problems.join()).toMatch(/末尾/);
  });
  it("#12 手填 views 为 null / 空串 / 布尔 → no_data，不当 0", async () => {
    for (const views of [null, "", true, "  "]) {
      const { p, later } = await predictPublished(dir, null, `t${String(views)}`);
      expect(await retro({ prediction_id: p.prediction_id, hypothesis_conclusion: "x", manual_metrics: { views } }, dir, later)).toMatchObject({ code: "no_data" });
    }
  });
  it("#13 Way b 把转写全文交回给宿主拆", async () => {
    const inbox = benchmarkInbox(dir);
    await fs.mkdir(inbox, { recursive: true });
    const s = (i: number) => ({ title: `t${i}`, video_path: path.join(inbox, `${i}.mp4`), metrics: { views: 1 }, impression: "高", why: "x" });
    const r = await learnPrepare({ account: "A", samples: [s(1), s(2), s(3)] }, dir, { transcribe: async () => ({ ok: true, text: "转写全文在这" }) });
    expect((r.samples as Array<{ script: string }>)[0].script).toBe("转写全文在这");
  });
});

