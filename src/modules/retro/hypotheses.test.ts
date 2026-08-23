/**
 * hypotheses.test.ts —— 假设台账(spec §5.3):append-only + latest-wins 读、校验拒收、
 * 模型提案解析。台账是账本,脏数据一条都不许进。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendHypotheses,
  listHypotheses,
  listOpenHypotheses,
  validateHypothesis,
  parseHypothesisProposals,
  type Hypothesis,
} from "./hypotheses.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-hyp-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function hyp(over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: "hyp-1",
    statement: "开头 5s 抛问题的视频完播率高于账号基线",
    metricFocus: "completionRate",
    direction: "up",
    scope: { platform: "douyin" },
    contentIds: ["c1"],
    proposedAt: "2026-08-16T09:00:00.000Z",
    retroRunId: "retro-weekly-2026-08-16T090000",
    status: "open",
    ...over,
  };
}

describe("台账落盘", () => {
  it("append → list 往返;文件不存在时读作空", async () => {
    expect(await listHypotheses(dir)).toEqual([]);
    await appendHypotheses([hyp()], dir);
    const all = await listHypotheses(dir);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: "hyp-1", status: "open", metricFocus: "completionRate" });
  });

  it("latest-wins:同 id 后写覆盖先写,journal 里两条都在", async () => {
    await appendHypotheses([hyp()], dir);
    await appendHypotheses(
      [hyp({ status: "supported", verdictAt: "2026-08-23T09:00:00.000Z" })],
      dir,
    );
    const all = await listHypotheses(dir);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "supported", verdictAt: "2026-08-23T09:00:00.000Z" });
    const raw = await fs.readFile(path.join(dir, "hypotheses.jsonl"), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(2); // append-only:旧版本可回溯
  });

  it("坏行与不合 schema 的行跳过,其余照常可读", async () => {
    await appendHypotheses([hyp(), hyp({ id: "hyp-2", statement: "另一条" })], dir);
    const file = path.join(dir, "hypotheses.jsonl");
    await fs.appendFile(file, '{"id":"hyp-trunc\n', "utf-8"); // 崩溃留下的半行
    await fs.appendFile(file, JSON.stringify({ id: "hyp-3", statement: "缺字段" }) + "\n", "utf-8");
    const all = await listHypotheses(dir);
    expect(all.map((h) => h.id).sort()).toEqual(["hyp-1", "hyp-2"]);
  });

  it("写前校验:不合 schema 的记录直接抛,不落进 journal", async () => {
    await expect(
      appendHypotheses([{ ...hyp(), metricFocus: "妖怪指标" } as unknown as Hypothesis], dir),
    ).rejects.toThrow(/metricFocus/);
    await expect(fs.access(path.join(dir, "hypotheses.jsonl"))).rejects.toThrow();
  });

  it("listOpenHypotheses 只给 open", async () => {
    await appendHypotheses([hyp(), hyp({ id: "hyp-2", status: "refuted" })], dir);
    const open = await listOpenHypotheses(dir);
    expect(open.map((h) => h.id)).toEqual(["hyp-1"]);
  });
});

describe("validateHypothesis", () => {
  it("收下合法记录并归一化 scope/contentIds", () => {
    const r = validateHypothesis({ ...hyp(), scope: { platform: " douyin ", tag: "" }, contentIds: ["c1", "", 7] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scope).toEqual({ platform: "douyin" });
      expect(r.value.contentIds).toEqual(["c1"]);
    }
  });

  it.each([
    ["statement 为空", { statement: "  " }, /statement/],
    ["metricFocus 不认识", { metricFocus: "roi" }, /metricFocus/],
    ["direction 非法", { direction: "sideways" }, /direction/],
    ["proposedAt 不是 ISO", { proposedAt: "2026/08/16" }, /proposedAt/],
    ["status 非法", { status: "maybe" }, /status/],
  ])("拒收:%s", (_label, patch, pattern) => {
    const r = validateHypothesis({ ...hyp(), ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("；")).toMatch(pattern);
  });

  it("拒收非对象", () => {
    expect(validateHypothesis("一条假设").ok).toBe(false);
    expect(validateHypothesis(null).ok).toBe(false);
  });
});

describe("parseHypothesisProposals", () => {
  const ctx = { retroRunId: "retro-weekly-2026-08-23T090000", proposedAt: "2026-08-23T09:00:00.000Z" };
  const good = [
    { statement: "问题式开头完播率更高", metricFocus: "completionRate", direction: "up", scope: { platform: "douyin" }, nextAction: "下周三条都用问题开头" },
  ];

  it("解析 JSON 数组 → 完整假设记录(id/runId/status 由代码盖)", () => {
    const r = parseHypothesisProposals(JSON.stringify(good), ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]).toMatchObject({
        retroRunId: ctx.retroRunId,
        status: "open",
        proposedAt: ctx.proposedAt,
        contentIds: [],
        nextAction: "下周三条都用问题开头",
      });
      expect(r.value[0].id).toContain(ctx.retroRunId);
    }
  });

  it("带 ``` 围栏也照收", () => {
    const r = parseHypothesisProposals("```json\n" + JSON.stringify(good) + "\n```", ctx);
    expect(r.ok).toBe(true);
  });

  it("空数组 = 本期不提假设,不是错误", () => {
    const r = parseHypothesisProposals("[]", ctx);
    expect(r).toMatchObject({ ok: true, value: [] });
  });

  it.each([
    ["JSON 坏了", "{不是 JSON", /JSON 解析失败/],
    ["超过 3 条", JSON.stringify([good[0], good[0], good[0], good[0]]), /最多 3 条/],
    ["缺 nextAction", JSON.stringify([{ ...good[0], nextAction: undefined }]), /nextAction/],
    ["metricFocus 不认识", JSON.stringify([{ ...good[0], metricFocus: "roi" }]), /metricFocus/],
    ["空块", "   ", /为空/],
  ])("拒收:%s", (_label, raw, pattern) => {
    const r = parseHypothesisProposals(raw, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("；")).toMatch(pattern);
  });

  it("一条不合格 = 整块拒收(不半收)", () => {
    const r = parseHypothesisProposals(JSON.stringify([good[0], { ...good[0], direction: "flat" }]), ctx);
    expect(r.ok).toBe(false);
  });
});
