/**
 * turn 注册表测试（对话控制面设计 §Phase 3）：归属校验、重复拒绝、
 * busy 到 settle、recent-turns 有界环（50 条 / 覆盖写 / 写失败不抛）、turn_status 三态。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  registerTurn,
  abortTurn,
  settleTurn,
  getTurnStatus,
  hasActiveTurnForConversation,
  noteTurnConversation,
  readRecentTurns,
  resetActiveTurns,
} from "./turn-registry.js";

let dir: string;

beforeEach(async () => {
  resetActiveTurns();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-turnreg-"));
});

afterEach(async () => {
  resetActiveTurns();
  await fs.chmod(dir, 0o700).catch(() => {});
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  vi.restoreAllMocks();
});

describe("registerTurn", () => {
  it("同一 turnId 重复登记被拒（寻址表里不许有两个同名目标）", () => {
    expect(registerTurn("t1", "客户端A").ok).toBe(true);
    const dup = registerTurn("t1", "客户端A");
    expect(dup.ok).toBe(false);
    expect(dup.ok === false && dup.error).toContain("重复");
  });

  it("同一 client 上一轮未 settle 时再发被拒；settle 后放行", async () => {
    expect(registerTurn("t1", "客户端A").ok).toBe(true);
    const busy = registerTurn("t2", "客户端A");
    expect(busy.ok).toBe(false);
    expect(busy.ok === false && busy.error).toContain("上一轮还在进行");

    await settleTurn("t1", { dataDir: dir });
    expect(registerTurn("t2", "客户端A").ok).toBe(true);
  });

  it("abort 之后仍然 busy（stopping），文案说的是「正在停止」——不许和收尾并行", () => {
    expect(registerTurn("t1", "客户端A").ok).toBe(true);
    expect(abortTurn("t1", "客户端A")).toBe("settling");
    const busy = registerTurn("t2", "客户端A");
    expect(busy.ok).toBe(false);
    expect(busy.ok === false && busy.error).toContain("正在停止");
  });

  it("不同 client 各跑各的，互不占位", () => {
    expect(registerTurn("t1", "客户端A").ok).toBe(true);
    expect(registerTurn("t2", "客户端B").ok).toBe(true);
  });
});

describe("abortTurn 归属与幂等", () => {
  it("clientId 不匹配拒绝中止，且原轮的 signal 不被触发", () => {
    const reg = registerTurn("t1", "客户端A");
    expect(abortTurn("t1", "客户端B")).toBe("forbidden");
    expect(reg.ok === true && reg.signal.aborted).toBe(false);
  });

  it("命中即 abort signal；未命中（已完成/未知）幂等", async () => {
    const reg = registerTurn("t1", "客户端A");
    expect(abortTurn("t1", "客户端A")).toBe("settling");
    expect(reg.ok === true && reg.signal.aborted).toBe(true);
    // 连点第二下：条目还在（stopping），仍返回 settling，不重复 abort 也不报错
    expect(abortTurn("t1", "客户端A")).toBe("settling");

    await settleTurn("t1", { dataDir: dir });
    expect(abortTurn("t1", "客户端A")).toBe("not_found");
    expect(abortTurn("从来没有过的轮", "客户端A")).toBe("not_found");
  });
});

describe("recent-turns 有界环", () => {
  it("settle 落盘 turnId → conversationId，并清掉活跃条目", async () => {
    registerTurn("t1", "客户端A");
    await settleTurn("t1", { conversationId: "conv-1-abc", dataDir: dir });

    const ring = await readRecentTurns(dir);
    expect(ring).toHaveLength(1);
    expect(ring[0]).toMatchObject({ turnId: "t1", conversationId: "conv-1-abc" });
    expect(typeof ring[0].at).toBe("string");
    // 活跃表已清：同 client 可以立刻发新轮
    expect(registerTurn("t2", "客户端A").ok).toBe(true);
  });

  it("registerTurn 时的 conversationId 与回填都能进环（首轮建的会话也捞得回来）", async () => {
    registerTurn("t1", "客户端A", { conversationId: "conv-1-old" });
    noteTurnConversation("t1", "conv-1-new");
    await settleTurn("t1", { dataDir: dir });
    expect((await readRecentTurns(dir))[0].conversationId).toBe("conv-1-new");
  });

  it("最多 50 条，覆盖写（老的挤掉，新的在后）", async () => {
    for (let i = 0; i < 55; i++) {
      await settleTurn(`t${i}`, { conversationId: `conv-${i}`, dataDir: dir });
    }
    const ring = await readRecentTurns(dir);
    expect(ring).toHaveLength(50);
    expect(ring[0].turnId).toBe("t5");
    expect(ring[49].turnId).toBe("t54");
  });

  it("环写失败不抛（只读目录）——本轮结果不受观测层拖累", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerTurn("t1", "客户端A");
    await fs.chmod(dir, 0o500);
    await expect(settleTurn("t1", { conversationId: "conv-1-abc", dataDir: dir })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    // 活跃条目照样清掉，不会把 client 永久锁在 busy 上
    expect(registerTurn("t2", "客户端A").ok).toBe(true);
  });

  it("环文件损坏当空环，不抛", async () => {
    await fs.writeFile(path.join(dir, "recent-turns.json"), "{ 不是 JSON", "utf-8");
    expect(await readRecentTurns(dir)).toEqual([]);
    expect(await getTurnStatus("t1", dir)).toEqual({ status: "unknown" });
  });
});

// 调研回流轮：后台回报要靠它避让用户正在进行的那一轮
describe("hasActiveTurnForConversation", () => {
  it("这段会话有在途的轮就是忙；stopping 也算忙（还没收尾）；settle 后放行", async () => {
    expect(hasActiveTurnForConversation("conv-1-abc")).toBe(false);

    registerTurn("t1", "客户端A", { conversationId: "conv-1-abc" });
    expect(hasActiveTurnForConversation("conv-1-abc")).toBe(true);
    expect(hasActiveTurnForConversation("conv-1-别人")).toBe(false); // 别的会话不受牵连

    abortTurn("t1", "客户端A");
    expect(hasActiveTurnForConversation("conv-1-abc")).toBe(true);

    await settleTurn("t1", { conversationId: "conv-1-abc", dataDir: dir });
    expect(hasActiveTurnForConversation("conv-1-abc")).toBe(false);
  });

  it("首轮建会话后回填的归属也算数（noteTurnConversation）", () => {
    registerTurn("t1", "客户端A");
    expect(hasActiveTurnForConversation("conv-1-new")).toBe(false);
    noteTurnConversation("t1", "conv-1-new");
    expect(hasActiveTurnForConversation("conv-1-new")).toBe(true);
  });
});

describe("getTurnStatus 三态", () => {
  it("running（含 stopping）→ done（带 conversationId）→ unknown", async () => {
    registerTurn("t1", "客户端A", { conversationId: "conv-1-abc" });
    expect(await getTurnStatus("t1", dir)).toEqual({ status: "running", conversationId: "conv-1-abc" });

    abortTurn("t1", "客户端A");
    // 停止中还没收尾,对外仍是 running——不假装已完成
    expect((await getTurnStatus("t1", dir)).status).toBe("running");

    await settleTurn("t1", { conversationId: "conv-1-abc", dataDir: dir });
    expect(await getTurnStatus("t1", dir)).toEqual({ status: "done", conversationId: "conv-1-abc" });

    expect(await getTurnStatus("没见过的 turn", dir)).toEqual({ status: "unknown" });
  });

  it("环里没有 conversationId 时 done 也回得来（只是没得 refetch）", async () => {
    await settleTurn("t-no-conv", { dataDir: dir });
    expect(await getTurnStatus("t-no-conv", dir)).toEqual({ status: "done" });
  });
});
