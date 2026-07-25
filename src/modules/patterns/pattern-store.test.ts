import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  upsertPatternCard,
  updatePatternCard,
  deletePatternCard,
  listPatternCards,
  findPatternByCanonicalUrl,
  patternIdFor,
  type PatternCardInput,
} from "./pattern-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-patterns-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

function baseCard(overrides: Partial<PatternCardInput> = {}): PatternCardInput {
  return {
    sourceUrl: "https://www.douyin.com/video/123?utm_source=tg",
    canonicalUrl: "https://www.douyin.com/video/123",
    sourcePlatform: "douyin",
    applicablePlatforms: ["douyin", "wechat_video"],
    author: "某博主",
    title: "三步搞定选题",
    hook: "你以为选题难，其实是没有清单",
    structure: ["抛反常识结论", "给三步清单", "收尾留钩子"],
    whyItWorks: ["反常识开头压住划走"],
    themes: ["内容创作"],
    sourceInboxId: "inbox-001",
    ...overrides,
  };
}

async function journalLines(): Promise<string[]> {
  const raw = await fs.readFile(path.join(testDir, "patterns", "patterns.jsonl"), "utf-8");
  return raw.split("\n").filter((l) => l.trim());
}

describe("upsertPatternCard", () => {
  it("derives id from sourceInboxId and starts at revision 1", async () => {
    const card = await upsertPatternCard(baseCard(), testDir);
    expect(card.id).toBe("pat-inbox-001");
    expect(card.id).toBe(patternIdFor("inbox-001"));
    expect(card.revision).toBe(1);
    expect(card.createdAt).toBe(card.updatedAt);
    expect(card.deletedAt).toBeUndefined();
  });

  it("is idempotent per sourceInboxId: revision climbs, card count does not", async () => {
    const first = await upsertPatternCard(baseCard(), testDir);
    const second = await upsertPatternCard(baseCard({ title: "重拆后的标题" }), testDir);
    const third = await upsertPatternCard(baseCard({ title: "第三次" }), testDir);

    expect(second.id).toBe(first.id);
    expect([first.revision, second.revision, third.revision]).toEqual([1, 2, 3]);
    expect(third.createdAt).toBe(first.createdAt); // createdAt 锁在首次
    expect(third.updatedAt >= first.updatedAt).toBe(true);

    const cards = await listPatternCards({}, testDir);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("第三次");
    expect(await journalLines()).toHaveLength(3); // journal 追加，不改写
  });

  it("keeps separate cards for separate inbox items", async () => {
    await upsertPatternCard(baseCard(), testDir);
    await upsertPatternCard(
      baseCard({ sourceInboxId: "inbox-002", canonicalUrl: "https://x.com/i/status/9" }),
      testDir,
    );
    const cards = await listPatternCards({}, testDir);
    expect(cards.map((c) => c.id).sort()).toEqual(["pat-inbox-001", "pat-inbox-002"]);
  });

  it("drops store-managed fields smuggled in by the caller", async () => {
    const smuggled = {
      ...baseCard(),
      id: "pat-伪造",
      revision: 99,
      deletedAt: "2020-01-01T00:00:00.000Z",
    } as PatternCardInput;
    const card = await upsertPatternCard(smuggled, testDir);
    expect(card.id).toBe("pat-inbox-001");
    expect(card.revision).toBe(1);
    expect(card.deletedAt).toBeUndefined();
  });
});

describe("字段校验与截断", () => {
  it("truncates over-limit fields instead of erroring", async () => {
    const card = await upsertPatternCard(
      baseCard({
        hook: "钩".repeat(150),
        structure: ["步".repeat(80), "第二步", "第三步", "第四步", "第五步", "第六步", "第七步"],
        whyItWorks: ["理由一", "理由二", "理由三", "理由四"],
        themes: ["主题一", "主题二", "主题三", "主题四"],
      }),
      testDir,
    );
    expect(card.hook).toHaveLength(100);
    expect(card.structure).toHaveLength(6);
    expect(card.structure[0]).toHaveLength(50);
    expect(card.structure[6]).toBeUndefined();
    expect(card.whyItWorks).toEqual(["理由一", "理由二", "理由三"]);
    expect(card.themes).toEqual(["主题一", "主题二", "主题三"]);
  });

  it("leaves within-limit fields untouched", async () => {
    const card = await upsertPatternCard(baseCard(), testDir);
    expect(card.hook).toBe("你以为选题难，其实是没有清单");
    expect(card.structure).toHaveLength(3);
  });

  it("rejects cards below the minimum counts (nothing to truncate)", async () => {
    await expect(
      upsertPatternCard(baseCard({ structure: ["只有一步", "两步"] }), testDir),
    ).rejects.toThrow(/structure 需 ≥3/);
    await expect(upsertPatternCard(baseCard({ themes: [] }), testDir)).rejects.toThrow(
      /themes 需 ≥1/,
    );
    await expect(upsertPatternCard(baseCard({ whyItWorks: [] }), testDir)).rejects.toThrow(
      /whyItWorks 需 ≥1/,
    );
  });

  it("filters applicablePlatforms down to real output platforms and dedupes", async () => {
    const card = await upsertPatternCard(
      baseCard({
        applicablePlatforms: [
          "douyin",
          "douyin",
          "x",
          "web",
          "xiaohongshu",
        ] as PatternCardInput["applicablePlatforms"],
      }),
      testDir,
    );
    expect(card.applicablePlatforms).toEqual(["douyin", "xiaohongshu"]);
  });
});

describe("stats（解析器直供，不经 LLM）", () => {
  it("赞评藏转与 capturedAt 原样落盘并读回——shares 是抖音病毒性主信号，不许丢", async () => {
    const stats = { likes: 135, comments: 11, collects: 132, shares: 29, capturedAt: "2026-07-25T05:00:00.000Z" };
    await upsertPatternCard(baseCard({ stats }), testDir);

    const [reread] = await listPatternCards({}, testDir);
    expect(reread.stats).toEqual(stats);
  });

  it("没有 stats 的卡照常落库（通用抓取路径拿不到公开数据）", async () => {
    const card = await upsertPatternCard(baseCard(), testDir);
    expect(card.stats).toBeUndefined();
  });
});

describe("updatePatternCard", () => {
  it("applies whitelisted fields and bumps revision", async () => {
    const created = await upsertPatternCard(baseCard(), testDir);
    const updated = await updatePatternCard(
      created.id,
      { founderNote: "钩子可用，结构照搬", applicablePlatforms: ["xiaohongshu"] },
      testDir,
    );
    expect(updated.founderNote).toBe("钩子可用，结构照搬");
    expect(updated.applicablePlatforms).toEqual(["xiaohongshu"]);
    expect(updated.revision).toBe(created.revision + 1);
    expect(updated.title).toBe(created.title); // 内容字段不动
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it("rejects fields outside the whitelist", async () => {
    const created = await upsertPatternCard(baseCard(), testDir);
    await expect(
      updatePatternCard(
        created.id,
        { hook: "偷改钩子", founderNote: "顺带备注" } as never,
        testDir,
      ),
    ).rejects.toThrow(/被拒字段：hook/);

    const [card] = await listPatternCards({}, testDir);
    expect(card.hook).toBe(created.hook); // 整个 patch 被拒，白名单字段也没落盘
    expect(card.revision).toBe(created.revision);
  });

  it("normalizes applicablePlatforms on update too", async () => {
    const created = await upsertPatternCard(baseCard(), testDir);
    const updated = await updatePatternCard(
      created.id,
      { applicablePlatforms: ["bilibili", "不存在的平台"] as never },
      testDir,
    );
    expect(updated.applicablePlatforms).toEqual(["bilibili"]);
  });

  it("refuses to annotate a missing or tombstoned card", async () => {
    await expect(updatePatternCard("pat-不存在", { founderNote: "x" }, testDir)).rejects.toThrow(
      /不存在或已删除/,
    );
    const created = await upsertPatternCard(baseCard(), testDir);
    await deletePatternCard(created.id, testDir);
    await expect(updatePatternCard(created.id, { founderNote: "x" }, testDir)).rejects.toThrow(
      /不存在或已删除/,
    );
  });
});

describe("deletePatternCard（墓碑）", () => {
  it("hides the card from list but keeps it findable by canonicalUrl", async () => {
    const created = await upsertPatternCard(baseCard(), testDir);
    const tombstone = await deletePatternCard(created.id, testDir);

    expect(tombstone?.deletedAt).toBeTruthy();
    expect(tombstone?.revision).toBe(created.revision + 1);
    expect(await listPatternCards({}, testDir)).toEqual([]);

    const found = await findPatternByCanonicalUrl(created.canonicalUrl, testDir);
    expect(found?.id).toBe(created.id);
    expect(found?.deletedAt).toBeTruthy(); // 调用方据此走「已删过，需显式重拆」

    const withDeleted = await listPatternCards({ includeDeleted: true }, testDir);
    expect(withDeleted.map((c) => c.id)).toEqual([created.id]);
  });

  it("never physically removes a line from the journal", async () => {
    const created = await upsertPatternCard(baseCard(), testDir);
    await deletePatternCard(created.id, testDir);
    expect(await journalLines()).toHaveLength(2);
  });

  it("is idempotent and returns null for an unknown id", async () => {
    const created = await upsertPatternCard(baseCard(), testDir);
    const first = await deletePatternCard(created.id, testDir);
    const second = await deletePatternCard(created.id, testDir);
    expect(second?.revision).toBe(first?.revision);
    expect(await journalLines()).toHaveLength(2); // 二次删除不再追加
    expect(await deletePatternCard("pat-不存在", testDir)).toBeNull();
  });

  it("lets an explicit re-extraction revive the tombstone", async () => {
    const created = await upsertPatternCard(baseCard(), testDir);
    await deletePatternCard(created.id, testDir);

    const revived = await upsertPatternCard(baseCard({ title: "重拆" }), testDir);
    expect(revived.deletedAt).toBeUndefined();
    expect(revived.revision).toBe(3);
    expect((await listPatternCards({}, testDir)).map((c) => c.title)).toEqual(["重拆"]);
  });
});

describe("findPatternByCanonicalUrl", () => {
  it("returns null when nothing matches", async () => {
    await upsertPatternCard(baseCard(), testDir);
    expect(await findPatternByCanonicalUrl("https://example.com/nope", testDir)).toBeNull();
  });

  it("matches the canonical url, not the raw source url", async () => {
    const created = await upsertPatternCard(baseCard(), testDir);
    expect(await findPatternByCanonicalUrl(created.sourceUrl, testDir)).toBeNull();
    expect((await findPatternByCanonicalUrl(created.canonicalUrl, testDir))?.id).toBe(created.id);
  });
});

describe("listPatternCards", () => {
  it("sorts by updatedAt descending", async () => {
    await upsertPatternCard(baseCard({ sourceInboxId: "a", canonicalUrl: "u/a" }), testDir);
    await new Promise((r) => setTimeout(r, 5));
    await upsertPatternCard(baseCard({ sourceInboxId: "b", canonicalUrl: "u/b" }), testDir);
    await new Promise((r) => setTimeout(r, 5));
    await upsertPatternCard(baseCard({ sourceInboxId: "c", canonicalUrl: "u/c" }), testDir);
    await new Promise((r) => setTimeout(r, 5));
    await updatePatternCard("pat-a", { founderNote: "补注把 a 顶上去" }, testDir);

    const ids = (await listPatternCards({}, testDir)).map((c) => c.id);
    expect(ids).toEqual(["pat-a", "pat-c", "pat-b"]);
  });

  it("returns an empty list when the journal does not exist yet", async () => {
    expect(await listPatternCards({}, testDir)).toEqual([]);
    expect(await findPatternByCanonicalUrl("https://anything", testDir)).toBeNull();
  });

  it("skips corrupted lines instead of blanking the read view", async () => {
    await upsertPatternCard(baseCard(), testDir);
    const file = path.join(testDir, "patterns", "patterns.jsonl");
    await fs.appendFile(file, "{ 半行损坏的 json\n", "utf-8");
    const cards = await listPatternCards({}, testDir);
    expect(cards).toHaveLength(1);
  });
});

describe("latest-wins 重读", () => {
  it("replays the journal from disk into one latest card per id", async () => {
    await upsertPatternCard(baseCard(), testDir);
    await upsertPatternCard(baseCard({ title: "v2" }), testDir);
    await updatePatternCard("pat-inbox-001", { founderNote: "备注" }, testDir);
    await upsertPatternCard(
      baseCard({ sourceInboxId: "inbox-002", canonicalUrl: "u/2", title: "另一张" }),
      testDir,
    );
    await deletePatternCard("pat-inbox-002", testDir);

    expect(await journalLines()).toHaveLength(5);

    // 冷读：没有任何进程内缓存，全部从 journal 重放
    const live = await listPatternCards({}, testDir);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      id: "pat-inbox-001",
      title: "v2",
      founderNote: "备注",
      revision: 3,
    });

    const all = await listPatternCards({ includeDeleted: true }, testDir);
    expect(all).toHaveLength(2);
    expect(all.find((c) => c.id === "pat-inbox-002")?.deletedAt).toBeTruthy();
  });
});
