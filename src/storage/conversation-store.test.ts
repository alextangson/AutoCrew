// src/storage/conversation-store.test.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  makeTitle,
  createConversation,
  getConversation,
} from "./conversation-store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-conv-test-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
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
