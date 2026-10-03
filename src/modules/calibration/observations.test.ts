import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addWritingRule, initProfile, loadProfile } from "../profile/creator-profile.js";
import { observe } from "./observations.js";
import { ensureCalibration } from "./store.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "calib-o-")); await initProfile(dir); });
const add = async (text: string, sample_ids: string[] = ["p1"]) => (await observe({ op: "add", text, sample_ids }, dir)).id as string;

describe("§五 观察生命周期", () => {
  it("升跨视频观察默认 ≥2 样本；不够要写软违反理由并留标注", async () => {
    const id = await add("开头给具体场景更留人");
    await expect(observe({ op: "promote", id, to: "cross_video" }, dir)).rejects.toThrow(/≥2/);
    const r = await observe({ op: "promote", id, to: "cross_video", soft_reason: "一次 10 倍偏差" }, dir);
    expect(r.soft_note).toMatch(/Promoted with 1 samples \(default expects 2\)/);
    const id2 = await add("标题带数字更好", ["p1"]);
    expect(await observe({ op: "promote", id: id2, to: "cross_video", sample_ids: ["p2"] }, dir)).toMatchObject({ ok: true, stage: "cross_video" });
  });
  it("单样本强信号可暂存为待验证假设", async () => {
    const id = await add("结尾给可照抄的指令留存更高");
    expect(await observe({ op: "promote", id, to: "hypothesis" }, dir)).toMatchObject({ stage: "hypothesis" });
  });
  it("删除留墓碑，同一条不能重提；rubric.json 观察区同步去掉", async () => {
    const id = await add("开头用问句更留人");
    expect((await ensureCalibration(dir)).rubric.observations).toHaveLength(1);
    await observe({ op: "retire", id, reason: "refuted" }, dir);
    expect((await ensureCalibration(dir)).rubric.observations).toHaveLength(0);
    expect(await observe({ op: "add", text: "开头用问句，更留人。" }, dir)).toMatchObject({ ok: false, code: "tombstoned" });
  });
  it("沉淀只建待批写作规则，不直接生效", async () => {
    const id = await add("口播里先给场景再给概念", ["p1", "p2"]);
    const r = await observe({ op: "settle", id }, dir);
    expect(r.writing_rule).toBe("created_pending");
    const rule = (await loadProfile(dir))!.writingRules.find((x) => x.rule === "口播里先给场景再给概念");
    expect(rule?.status).toBe("pending");
  });
  it("与创始人原话定的规则冲突：只提示，规则不动", async () => {
    await addWritingRule({ rule: "开头必须自嘲", source: "user_explicit", confidence: 1 }, dir);
    const before = (await loadProfile(dir))!.writingRules[0];
    const id = await add("自嘲开头掉留存");
    const r = await observe({ op: "rule_conflict", id, rule_id: before.id }, dir);
    expect(r).toMatchObject({ changed: false, conflict: { founder_rule: true } });
    expect((await loadProfile(dir))!.writingRules[0]).toEqual(before);
  });
  it("含数据的观察只留 memo，不进盲评白名单", async () => {
    await add("那条视频播放 3万");
    expect((await ensureCalibration(dir)).rubric.observations).toHaveLength(0);
  });
  it("清算完成记下样本数（每 10 条再提示）", async () => {
    expect(await observe({ op: "cleanup_done" }, dir)).toMatchObject({ ok: true, samples_at_last_cleanup: 0 });
  });
});
