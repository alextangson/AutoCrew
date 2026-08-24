// src/storage/conversation-store.test.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  makeTitle,
  createConversation,
  getConversation,
  appendTurn,
  listConversations,
  deleteConversation,
} from "./conversation-store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-conv-test-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("makeTitle", () => {
  it("uses the full message when short", () => {
    expect(makeTitle("帮我写一条抖音口播")).toBe("帮我写一条抖音口播");
  });

  it("truncates at 30 code points with ellipsis (CJK-safe)", () => {
    const msg = "这".repeat(31);
    const title = makeTitle(msg);
    expect(Array.from(title)).toHaveLength(31); // 30 字 + …
    expect(title.endsWith("…")).toBe(true);
  });

  it("collapses whitespace", () => {
    expect(makeTitle("  写  一条\n口播  ")).toBe("写 一条 口播");
  });

  it('returns fallback for empty string', () => {
    expect(makeTitle("")).toBe("（空白会话）");
  });
});

describe("createConversation / getConversation", () => {
  it("creates meta + empty messages, readable back", async () => {
    const meta = await createConversation("帮我写 Excel 快捷键口播", dir);
    expect(meta.id).toMatch(/^conv-\d+-[a-z0-9]+$/);
    expect(meta.title).toBe("帮我写 Excel 快捷键口播");
    expect(meta.turns).toBe(0);
    const conv = await getConversation(meta.id, dir);
    expect(conv).not.toBeNull();
    expect(conv!.meta.id).toBe(meta.id);
    expect(conv!.messages).toEqual([]);
  });

  it("binds contentId when given, omits the key otherwise", async () => {
    const bound = await createConversation("改这篇", dir, "content-42");
    expect(bound.contentId).toBe("content-42");
    expect((await getConversation(bound.id, dir))!.meta.contentId).toBe("content-42");
    const free = await createConversation("随便聊", dir);
    expect(free).not.toHaveProperty("contentId");
  });

  it("keeps the binding across appendTurn (续聊不该把归属聊丢)", async () => {
    const meta = await createConversation("改这篇", dir, "content-42");
    const updated = await appendTurn(meta.id, { content: "再改" }, { content: "好" }, dir);
    expect(updated!.contentId).toBe("content-42");
  });

  it("returns null for unknown id", async () => {
    expect(await getConversation("conv-123-abcdef", dir)).toBeNull();
  });

  it("rejects path-traversal ids", async () => {
    expect(await getConversation("../contents", dir)).toBeNull();
    expect(await getConversation("conv-1-x/../../y", dir)).toBeNull();
  });

  it("returns null for corrupt meta.json", async () => {
    const meta = await createConversation("hello", dir);
    await fs.writeFile(
      path.join(dir, "conversations", meta.id, "meta.json"),
      "{ not json",
      "utf-8",
    );
    expect(await getConversation(meta.id, dir)).toBeNull();
  });
});

describe("appendTurn", () => {
  it("appends user+assistant pair, bumps turns and updatedAt", async () => {
    const meta = await createConversation("第一轮", dir);
    const updated = await appendTurn(
      meta.id,
      { content: "第一轮" },
      { content: "好的，稿子来了", cards: [{ type: "draft", data: { title: "x" } }] },
      dir,
    );
    expect(updated).not.toBeNull();
    expect(updated!.turns).toBe(1);
    const conv = await getConversation(meta.id, dir);
    expect(conv!.messages).toHaveLength(2);
    expect(conv!.messages[0]).toMatchObject({ role: "user", content: "第一轮" });
    expect(conv!.messages[1].role).toBe("assistant");
    expect(conv!.messages[1].cards).toHaveLength(1);
  });

  it("omits cards key when empty", async () => {
    const meta = await createConversation("无卡轮", dir);
    await appendTurn(meta.id, { content: "无卡轮" }, { content: "回复", cards: [] }, dir);
    const conv = await getConversation(meta.id, dir);
    expect(conv!.messages[1]).not.toHaveProperty("cards");
  });

  it("returns null for missing conversation", async () => {
    expect(await appendTurn("conv-1-gone", { content: "a" }, { content: "b" }, dir)).toBeNull();
  });
});

describe("listConversations", () => {
  it("sorts by updatedAt desc and skips corrupt entries", async () => {
    const a = await createConversation("旧会话", dir);
    await new Promise((r) => setTimeout(r, 5));
    const b = await createConversation("新会话", dir);
    // 损坏第三个
    const c = await createConversation("坏会话", dir);
    await fs.writeFile(path.join(dir, "conversations", c.id, "meta.json"), "broken", "utf-8");
    const list = await listConversations(dir);
    expect(list.map((m) => m.id)).toEqual([b.id, a.id]);
  });

  it("updatedAt bump reorders list — older conv sorts first after appendTurn", async () => {
    const a = await createConversation("旧会话", dir);
    await new Promise((r) => setTimeout(r, 5));
    const b = await createConversation("新会话", dir);
    // b was created later → b should sort first now
    const before = await listConversations(dir);
    expect(before.map((m) => m.id)).toEqual([b.id, a.id]);
    // append to a — its updatedAt should now be newer than b's createdAt
    await new Promise((r) => setTimeout(r, 5));
    await appendTurn(a.id, { content: "续问" }, { content: "续答" }, dir);
    const after = await listConversations(dir);
    expect(after.map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it("returns [] when nothing exists", async () => {
    expect(await listConversations(dir)).toEqual([]);
  });
});

describe("deleteConversation", () => {
  it("removes the directory and returns true", async () => {
    const meta = await createConversation("待删", dir);
    expect(await deleteConversation(meta.id, dir)).toBe(true);
    expect(await getConversation(meta.id, dir)).toBeNull();
  });

  it("returns false for unknown or invalid id", async () => {
    expect(await deleteConversation("conv-1-nothere", dir)).toBe(false);
    expect(await deleteConversation("../contents", dir)).toBe(false);
  });
});
