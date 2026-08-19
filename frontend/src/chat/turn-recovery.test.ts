/**
 * 断线恢复判定（对话控制面设计 §Phase 3）：三态各有明确出口，
 * 以及 pending turn 的读写在存储不可用时不许把对话搞崩。
 */
import { describe, it, expect } from "vitest";
import {
  decideRecovery,
  readPendingTurn,
  writePendingTurn,
  clearPendingTurn,
  randomId,
  type PendingStore,
} from "./turn-recovery";

function fakeStore(initial: Record<string, string> = {}): PendingStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
  };
}

describe("decideRecovery", () => {
  it("done：按服务端返回的 conversationId 重拉（首轮建的新会话也捞得回来）", () => {
    expect(decideRecovery({ turnId: "t1" }, { status: "done", conversationId: "conv-1-new" })).toEqual({
      action: "reload",
      conversationId: "conv-1-new",
    });
  });

  it("done 但服务端没给 conversationId：退回本地记着的那个", () => {
    expect(decideRecovery({ turnId: "t1", conversationId: "conv-1-old" }, { status: "done" })).toEqual({
      action: "reload",
      conversationId: "conv-1-old",
    });
  });

  it("done 且两边都没有会话：只重拉列表，不带 id", () => {
    expect(decideRecovery({ turnId: "t1" }, { status: "done" })).toEqual({ action: "reload" });
  });

  it("running：明说还在跑（消息没蒸发）", () => {
    const r = decideRecovery({ turnId: "t1" }, { status: "running" });
    expect(r.action).toBe("wait");
    expect(r.action === "wait" && r.notice).toContain("还在跑");
  });

  it("unknown：明说结果丢了可重发，不假装还在跑", () => {
    const r = decideRecovery({ turnId: "t1" }, { status: "unknown" });
    expect(r.action).toBe("lost");
    expect(r.action === "lost" && r.notice).toContain("重发");
  });
});

describe("pending turn 存取", () => {
  it("写入 → 读回 → 清掉", () => {
    const store = fakeStore();
    writePendingTurn({ turnId: "t1", conversationId: "conv-1-abc" }, store);
    expect(readPendingTurn(store)).toEqual({ turnId: "t1", conversationId: "conv-1-abc" });
    clearPendingTurn(store);
    expect(readPendingTurn(store)).toBeNull();
  });

  it("坏数据/缺 turnId 一律当没有", () => {
    expect(readPendingTurn(fakeStore({ "autocrew.chat.pendingTurn": "{ 不是 JSON" }))).toBeNull();
    expect(readPendingTurn(fakeStore({ "autocrew.chat.pendingTurn": JSON.stringify({ conversationId: "conv-1" }) }))).toBeNull();
    expect(readPendingTurn(fakeStore())).toBeNull();
  });

  it("存储不可用（隐私模式）时读写都不抛", () => {
    const broken: PendingStore = {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("SecurityError"); },
      removeItem: () => { throw new Error("SecurityError"); },
    };
    expect(() => writePendingTurn({ turnId: "t1" }, broken)).not.toThrow();
    expect(readPendingTurn(broken)).toBeNull();
    expect(() => clearPendingTurn(broken)).not.toThrow();
    expect(() => writePendingTurn({ turnId: "t1" }, null)).not.toThrow();
  });
});

describe("randomId", () => {
  it("每次不同且非空（crypto.randomUUID 不可用时也要有值）", () => {
    const ids = new Set(Array.from({ length: 50 }, () => randomId()));
    expect(ids.size).toBe(50);
    expect([...ids].every((id) => id.length > 8)).toBe(true);
  });
});
