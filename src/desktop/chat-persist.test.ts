// src/desktop/chat-persist.test.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runPersistedChatTurn } from "./chat-persist.js";
import {
  createConversation,
  appendTurn,
  getConversation,
  listConversations,
} from "../storage/conversation-store.js";
import type { runChatTurn } from "./chat-router.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-persist-test-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const okTurn = (reply: string, cards: Record<string, unknown>[] = []) =>
  vi.fn(async () => ({ ok: true, data: { reply, cards, tokensUsed: 10 } })) as unknown as typeof runChatTurn;

describe("runPersistedChatTurn", () => {
  it("auto-creates conversation on first successful turn and persists the pair", async () => {
    const res = await runPersistedChatTurn({
      message: "帮我写口播",
      dataDir: dir,
      runTurn: okTurn("稿子来了", [{ type: "draft", data: {} }]),
    });
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(typeof data.conversationId).toBe("string");
    const conv = await getConversation(data.conversationId as string, dir);
    expect(conv!.meta.title).toBe("帮我写口播");
    expect(conv!.messages).toHaveLength(2);
    expect(conv!.messages[1].cards).toHaveLength(1);
  });

  it("never persists an empty assistant message", async () => {
    const res = await runPersistedChatTurn({ message: "执行任务", dataDir: dir, runTurn: okTurn("   ") });
    const id = (res.data as Record<string, unknown>).conversationId as string;
    const conv = await getConversation(id, dir);
    expect(conv!.messages[1].content).toContain("没有返回可显示说明");
  });

  it("does NOT create a conversation when the turn fails", async () => {
    const failTurn = vi.fn(async () => ({ ok: false, error: "boom" })) as unknown as typeof runChatTurn;
    const res = await runPersistedChatTurn({ message: "hi", dataDir: dir, runTurn: failTurn });
    expect(res.ok).toBe(false);
    expect(await listConversations(dir)).toEqual([]);
  });

  it("does NOT create a conversation on needsSetup", async () => {
    const setupTurn = vi.fn(async () => ({ ok: false, needsSetup: true, error: "no engine" })) as unknown as typeof runChatTurn;
    const res = await runPersistedChatTurn({ message: "hi", dataDir: dir, runTurn: setupTurn });
    expect(res.needsSetup).toBe(true);
    expect(await listConversations(dir)).toEqual([]);
  });

  it("loads prior messages as text-only history, windowed to 12", async () => {
    const meta = await createConversation("长会话", dir);
    for (let i = 0; i < 10; i++) {
      await appendTurn(
        meta.id,
        { content: `问${i}` },
        { content: `答${i}`, cards: [{ type: "draft", data: {} }] },
        dir,
      );
    }
    const spy = vi.fn(async () => ({ ok: true, data: { reply: "ok", cards: [], tokensUsed: 1 } }));
    await runPersistedChatTurn({
      message: "继续",
      conversationId: meta.id,
      dataDir: dir,
      runTurn: spy as unknown as typeof runChatTurn,
    });
    const call = spy.mock.calls[0][0] as { history: Array<Record<string, unknown>> };
    expect(call.history).toHaveLength(12);
    expect(call.history[0]).toEqual({ role: "user", content: "问4" });
    expect(call.history[11]).toEqual({ role: "assistant", content: "答9" });
    expect(call.history.every((m) => !("cards" in m))).toBe(true);
  });

  it("rejects unknown conversation id without running the turn", async () => {
    const spy = vi.fn();
    const res = await runPersistedChatTurn({
      message: "hi",
      conversationId: "conv-1-gone",
      dataDir: dir,
      runTurn: spy as unknown as typeof runChatTurn,
    });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("会话不存在");
    expect(spy).not.toHaveBeenCalled();
  });

  it("failure on an EXISTING conversation persists the pair with a failure note (防呆:失败留痕)", async () => {
    const meta = await createConversation("失败留痕", dir);
    await appendTurn(meta.id, { content: "初始" }, { content: "初始回" }, dir);

    const failTurn = vi.fn(async () => ({ ok: false, error: "relay 断流" })) as unknown as typeof runChatTurn;
    const res = await runPersistedChatTurn({
      message: "写一篇长文",
      conversationId: meta.id,
      dataDir: dir,
      runTurn: failTurn,
    });

    expect(res.ok).toBe(false);
    const conv = await getConversation(meta.id, dir);
    expect(conv!.messages).toHaveLength(4); // 失败轮也成对落盘
    expect(conv!.messages[2].content).toBe("写一篇长文");
    expect(conv!.messages[3].content).toContain("本轮执行失败");
    expect(conv!.messages[3].content).toContain("relay 断流");
  });

  it("needsSetup failure does NOT persist a failure note (配置态不是任务失败)", async () => {
    const meta = await createConversation("配置态", dir);
    await appendTurn(meta.id, { content: "a" }, { content: "b" }, dir);
    const setupTurn = vi.fn(async () => ({ ok: false, needsSetup: true, error: "no key" })) as unknown as typeof runChatTurn;
    await runPersistedChatTurn({ message: "hi", conversationId: meta.id, dataDir: dir, runTurn: setupTurn });
    const conv = await getConversation(meta.id, dir);
    expect(conv!.messages).toHaveLength(2);
  });

  it("appends to an existing conversation and echoes its id", async () => {
    const meta = await createConversation("续聊", dir);
    await appendTurn(meta.id, { content: "续聊" }, { content: "好" }, dir);
    const res = await runPersistedChatTurn({
      message: "再来",
      conversationId: meta.id,
      dataDir: dir,
      runTurn: okTurn("来了"),
    });
    expect((res.data as Record<string, unknown>).conversationId).toBe(meta.id);
    const conv = await getConversation(meta.id, dir);
    expect(conv!.messages).toHaveLength(4);
    expect(conv!.meta.turns).toBe(2);
  });

  it("serializes concurrent turns on the same conversation (no message dropped)", async () => {
    const meta = await createConversation("并发测试", dir);
    await appendTurn(meta.id, { content: "初始" }, { content: "初始回" }, dir);

    const delayedTurn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, data: { reply: "ok", cards: [], tokensUsed: 1 } };
    }) as unknown as typeof runChatTurn;

    await Promise.all([
      runPersistedChatTurn({ message: "问A", conversationId: meta.id, dataDir: dir, runTurn: delayedTurn }),
      runPersistedChatTurn({ message: "问B", conversationId: meta.id, dataDir: dir, runTurn: delayedTurn }),
    ]);

    const conv = await getConversation(meta.id, dir);
    expect(conv!.messages).toHaveLength(6); // 2 initial + 2+2 from concurrent
    expect(conv!.meta.turns).toBe(3);
  });

  it("rejecting persist propagates to caller, drains queue, no unhandledRejection", async () => {
    const meta = await createConversation("故障会话", dir);
    const convDir = path.join(dir, "conversations", meta.id);

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // 让 appendTurn 的原子写失败：会话目录只读 → 临时文件写不进
      await fs.chmod(convDir, 0o500);
      await expect(
        runPersistedChatTurn({
          message: "写不进",
          conversationId: meta.id,
          dataDir: dir,
          runTurn: okTurn("ok"),
        }),
      ).rejects.toThrow();
      await fs.chmod(convDir, 0o700);

      // 队列已排空 —— 同会话后续 turn 正常工作
      const res = await runPersistedChatTurn({
        message: "恢复",
        conversationId: meta.id,
        dataDir: dir,
        runTurn: okTurn("好"),
      });
      expect(res.ok).toBe(true);

      // 给 unhandledRejection 一个 tick 的机会触发，再断言没发生
      await new Promise((r) => setTimeout(r, 10));
      expect(rejections).toEqual([]);
    } finally {
      await fs.chmod(convDir, 0o700).catch(() => {});
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
