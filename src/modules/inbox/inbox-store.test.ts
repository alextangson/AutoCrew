import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendItem,
  updateItem,
  listItems,
  getItem,
  findByCanonicalUrl,
  findByTextHash,
  canTransition,
  INBOX_TRANSITIONS,
  type InboxStatus,
} from "./inbox-store.js";
import { normalizeTextForHash } from "./url-canonical.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-inbox-store-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

const journalPath = () => path.join(dataDir, "inbox", "inbox.jsonl");

async function journalLines(): Promise<string[]> {
  const raw = await fs.readFile(journalPath(), "utf-8");
  return raw.split("\n").filter((l) => l.trim());
}

const tgItem = { source: "telegram" as const, url: "https://example.com/a", chatId: 42, updateId: 7 };

describe("appendItem", () => {
  it("fills id / receivedAt / status / attempts defaults and lands in <dataDir>/inbox/inbox.jsonl", async () => {
    const item = await appendItem(tgItem, dataDir);
    expect(item.id).toMatch(/^inbox-/);
    expect(item.status).toBe("pending");
    expect(item.attempts).toBe(0);
    expect(Number.isNaN(Date.parse(item.receivedAt))).toBe(false);
    expect(await journalLines()).toHaveLength(1);
  });

  it("accepts explicit id / status / attempts overrides", async () => {
    const item = await appendItem(
      { ...tgItem, id: "inbox-fixed", status: "blocked", attempts: 2 },
      dataDir,
    );
    expect(item).toMatchObject({ id: "inbox-fixed", status: "blocked", attempts: 2 });
  });

  it("returns an empty list when the journal does not exist yet", async () => {
    expect(await listItems(dataDir)).toEqual([]);
    expect(await getItem("nope", dataDir)).toBeNull();
  });
});

describe("latest-wins", () => {
  it("keeps only the newest record per id in the read view", async () => {
    const item = await appendItem(tgItem, dataDir);
    await updateItem(item.id, { status: "fetching", claimedAt: "2026-07-25T00:00:00.000Z" }, dataDir);
    await updateItem(item.id, { status: "digested", verdict: "both", targetIds: ["topic-1"] }, dataDir);

    const list = await listItems(dataDir);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "digested", verdict: "both", targetIds: ["topic-1"] });
  });

  it("never physically deletes — every revision stays in the append-only journal", async () => {
    const item = await appendItem(tgItem, dataDir);
    await updateItem(item.id, { status: "fetching" }, dataDir);
    await updateItem(item.id, { status: "rejected", failReason: "内容太薄" }, dataDir);

    expect(await journalLines()).toHaveLength(3);
    expect(await listItems(dataDir)).toHaveLength(1);
  });

  it("clears a field when the patch passes undefined (lease release)", async () => {
    const item = await appendItem(tgItem, dataDir);
    await updateItem(item.id, { status: "fetching", claimedAt: "2026-07-25T00:00:00.000Z" }, dataDir);
    const done = await updateItem(item.id, { status: "digested", claimedAt: undefined }, dataDir);
    expect(done?.claimedAt).toBeUndefined();
    expect((await getItem(item.id, dataDir))?.claimedAt).toBeUndefined();
  });

  it("refuses to rewrite identity fields (id / receivedAt / source)", async () => {
    const item = await appendItem(tgItem, dataDir);
    const patched = await updateItem(
      item.id,
      { receiptStatus: "sent", source: "extension", receivedAt: "1999-01-01T00:00:00.000Z" } as never,
      dataDir,
    );
    expect(patched).toMatchObject({
      id: item.id,
      source: "telegram",
      receivedAt: item.receivedAt,
      receiptStatus: "sent",
    });
  });

  it("returns null for an unknown id", async () => {
    expect(await updateItem("inbox-missing", { status: "digested" }, dataDir)).toBeNull();
  });

  it("sorts oldest-first and skips corrupt journal lines", async () => {
    await appendItem({ ...tgItem, id: "inbox-b", receivedAt: "2026-07-25T02:00:00.000Z" }, dataDir);
    await appendItem({ ...tgItem, id: "inbox-a", receivedAt: "2026-07-25T01:00:00.000Z" }, dataDir);
    await fs.appendFile(journalPath(), "{ this is not json\n", "utf-8");
    await fs.appendFile(journalPath(), '{"noId":true}\n', "utf-8");

    expect((await listItems(dataDir)).map((i) => i.id)).toEqual(["inbox-a", "inbox-b"]);
  });
});

describe("state machine", () => {
  it("allows the normal flow and the recovery edges", () => {
    expect(canTransition("pending", "fetching")).toBe(true);
    expect(canTransition("fetching", "digested")).toBe(true);
    expect(canTransition("fetching", "failed")).toBe(true);
    expect(canTransition("fetching", "blocked")).toBe(true);
    expect(canTransition("fetching", "rejected")).toBe(true);
    expect(canTransition("fetching", "pending")).toBe(true); // lease 回收
    expect(canTransition("failed", "fetching")).toBe(true); // 重试
    expect(canTransition("blocked", "fetching")).toBe(true); // 唤醒
    expect(canTransition("digested", "pending")).toBe(true); // 一键重新入库
    expect(canTransition("rejected", "pending")).toBe(true);
  });

  it("rejects skipping and terminal-to-terminal jumps", () => {
    expect(canTransition("pending", "digested")).toBe(false);
    expect(canTransition("digested", "fetching")).toBe(false);
    expect(canTransition("digested", "rejected")).toBe(false);
    expect(canTransition("rejected", "digested")).toBe(false);
    expect(canTransition("blocked", "digested")).toBe(false);
  });

  it("allows same-status writes so unrelated fields can be patched mid-flight", () => {
    for (const s of Object.keys(INBOX_TRANSITIONS) as InboxStatus[]) {
      expect(canTransition(s, s)).toBe(true);
    }
  });

  it("throws on an illegal transition instead of silently corrupting the ledger", async () => {
    const item = await appendItem(tgItem, dataDir);
    await expect(updateItem(item.id, { status: "digested" }, dataDir)).rejects.toThrow(
      /状态迁移非法：pending → digested/,
    );
    expect((await getItem(item.id, dataDir))?.status).toBe("pending");
    expect(await journalLines()).toHaveLength(1);
  });
});

describe("dedupe lookups", () => {
  it("finds the earliest item with the same canonicalUrl", async () => {
    const first = await appendItem(
      { ...tgItem, canonicalUrl: "https://x.com/i/status/1", receivedAt: "2026-07-25T01:00:00.000Z" },
      dataDir,
    );
    await appendItem(
      { ...tgItem, canonicalUrl: "https://x.com/i/status/1", receivedAt: "2026-07-25T03:00:00.000Z" },
      dataDir,
    );
    await appendItem({ ...tgItem, canonicalUrl: "https://x.com/i/status/2" }, dataDir);

    const hit = await findByCanonicalUrl("https://x.com/i/status/1", dataDir);
    expect(hit?.id).toBe(first.id);
  });

  it("still matches after the original item reached a terminal status", async () => {
    const first = await appendItem({ ...tgItem, canonicalUrl: "https://x.com/i/status/9" }, dataDir);
    await updateItem(first.id, { status: "fetching" }, dataDir);
    await updateItem(first.id, { status: "digested" }, dataDir);
    expect((await findByCanonicalUrl("https://x.com/i/status/9", dataDir))?.id).toBe(first.id);
  });

  it("returns null for a miss or an empty key", async () => {
    await appendItem({ ...tgItem, canonicalUrl: "https://x.com/i/status/1" }, dataDir);
    expect(await findByCanonicalUrl("https://x.com/i/status/404", dataDir)).toBeNull();
    expect(await findByCanonicalUrl("", dataDir)).toBeNull();
  });

  it("matches text notes by normalized hash inside the 7-day window", async () => {
    const note = await appendItem({ source: "telegram", text: "  做一期\n关于 AI 的选题  " }, dataDir);
    const hit = await findByTextHash(normalizeTextForHash("做一期 关于 AI 的选题"), dataDir);
    expect(hit?.id).toBe(note.id);
  });

  it("ignores text notes older than the window", async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await appendItem({ source: "telegram", text: "老笔记", receivedAt: old }, dataDir);
    expect(await findByTextHash(normalizeTextForHash("老笔记"), dataDir)).toBeNull();
    expect(await findByTextHash(normalizeTextForHash("老笔记"), dataDir, 30)).not.toBeNull();
  });

  it("does not confuse a url item with a text note", async () => {
    await appendItem({ ...tgItem, note: "顺手记一句" }, dataDir);
    expect(await findByTextHash(normalizeTextForHash("顺手记一句"), dataDir)).toBeNull();
  });
});
