/**
 * goal.test.ts — 目标存取:往返、留档、校验。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getGoal, setGoal } from "./goal.js";
import { loadProfile, goalSummary } from "./creator-profile.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-goal-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("setGoal / getGoal", () => {
  it("设定 → 读回,horizon/metrics 原样,空档案自动建", async () => {
    const goal = await setGoal({ statement: "3 个月公众号做到 1 万粉", horizon: "2026-10-09", metrics: ["涨粉", " 周更 3 篇 "] }, dir);
    expect(goal.statement).toBe("3 个月公众号做到 1 万粉");
    expect(goal.metrics).toEqual(["涨粉", "周更 3 篇"]);
    const read = await getGoal(dir);
    expect(read).toMatchObject({ statement: goal.statement, horizon: "2026-10-09" });
    // 写进 profile 唯一事实源
    const profile = await loadProfile(dir);
    expect(profile!.goal!.statement).toBe(goal.statement);
  });

  it("更新目标 → 旧目标压进 history(留档供复盘对照)", async () => {
    await setGoal({ statement: "旧目标" }, dir);
    const updated = await setGoal({ statement: "新目标" }, dir);
    expect(updated.statement).toBe("新目标");
    expect(updated.history).toHaveLength(1);
    expect(updated.history![0].statement).toBe("旧目标");
  });

  it("空 statement → 拒;无目标时 getGoal → null", async () => {
    await expect(setGoal({ statement: "   " }, dir)).rejects.toThrow(/目标/);
    expect(await getGoal(dir)).toBeNull();
  });
});

describe("goalSummary", () => {
  it("一行话渲染(prompt 共用口径)", () => {
    expect(goalSummary(null)).toBe("");
    expect(goalSummary({ statement: "破万粉", horizon: "3 个月", metrics: ["涨粉"], setAt: "t" })).toBe("破万粉(期限:3 个月);关键指标:涨粉");
  });
});
