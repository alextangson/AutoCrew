import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { patternsDeleteHandler, patternsListHandler, patternsUpdateHandler } from "./pattern-handlers.js";
import { upsertPatternCard, type PatternCard, type PatternCardInput } from "../modules/patterns/pattern-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-pattern-handlers-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const here = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ _dataDir: testDir, ...extra });

function data(reply: Record<string, unknown>): Record<string, unknown> {
  expect(reply.ok).toBe(true);
  return reply.data as Record<string, unknown>;
}

async function seedCard(over: Partial<PatternCardInput> = {}): Promise<PatternCard> {
  return upsertPatternCard(
    {
      sourceUrl: "https://example.com/post",
      canonicalUrl: "https://example.com/post",
      sourcePlatform: "web",
      applicablePlatforms: ["douyin"],
      title: "三步讲清一个概念",
      hook: "别人都在讲结论，我先讲代价",
      structure: ["抛反常识", "拆三层原因", "给行动"],
      whyItWorks: ["前 3 秒制造认知冲突"],
      themes: ["AI 效率"],
      sourceInboxId: "inbox-1",
      ...over,
    },
    testDir,
  );
}

describe("patterns:list", () => {
  it("列出未删卡片；空库返回空表", async () => {
    expect(data(await patternsListHandler(here()))).toMatchObject({ cards: [], total: 0 });

    const card = await seedCard();

    const reply = await patternsListHandler(here());
    expect((data(reply).cards as PatternCard[]).map((c) => c.id)).toEqual([card.id]);
  });
});

describe("patterns:update", () => {
  it("补注与改适用平台：revision 递增", async () => {
    const card = await seedCard();

    const reply = await patternsUpdateHandler(
      here({ id: card.id, founder_note: "  钩子适合我的口播  ", applicable_platforms: ["douyin", "xiaohongshu"] }),
    );

    expect(data(reply).card).toMatchObject({
      founderNote: "钩子适合我的口播",
      applicablePlatforms: ["douyin", "xiaohongshu"],
      revision: card.revision + 1,
    });
  });

  it("空串清空备注（与「没传」区分开）", async () => {
    const card = await seedCard({ founderNote: "旧备注" });

    const reply = await patternsUpdateHandler(here({ id: card.id, founder_note: "" }));

    expect((data(reply).card as PatternCard).founderNote).toBe("");
  });

  it("未知平台当场拒，不静默丢", async () => {
    const card = await seedCard();

    expect(await patternsUpdateHandler(here({ id: card.id, applicable_platforms: ["douyin", "myspace"] }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("myspace"),
    });
  });

  it("白名单外的字段不构成修改——只传 title 等于什么都没传", async () => {
    const card = await seedCard();

    const reply = await patternsUpdateHandler(here({ id: card.id, title: "偷改标题" }));

    expect(reply.ok).toBe(false);
    const cards = data(await patternsListHandler(here())).cards as PatternCard[];
    expect(cards[0].title).toBe(card.title);
  });

  it("卡不存在报错", async () => {
    expect(await patternsUpdateHandler(here({ id: "pat-nope", founder_note: "x" }))).toMatchObject({ ok: false });
  });
});

describe("patterns:delete", () => {
  it("墓碑删除：列表看不到，重复删幂等", async () => {
    const card = await seedCard();

    expect((data(await patternsDeleteHandler(here({ id: card.id }))).card as PatternCard).deletedAt).toBeTruthy();
    expect(data(await patternsListHandler(here()))).toMatchObject({ total: 0 });
    expect(await patternsDeleteHandler(here({ id: card.id }))).toMatchObject({ ok: true });
  });

  it("卡不存在报错，不假装删掉了", async () => {
    expect(await patternsDeleteHandler(here({ id: "pat-nope" }))).toMatchObject({ ok: false });
  });
});
