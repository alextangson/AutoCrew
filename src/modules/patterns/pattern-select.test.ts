/**
 * pattern-select.test.ts — 选卡矩阵（收件箱设计 §3.5）。
 *
 * 夹具直接写 journal：updatedAt / deletedAt 要精确可控，才能断言排序与墓碑。
 * 落库语义本身由 pattern-store.test.ts 覆盖，这里只测「挑哪几张、按什么序」。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { selectPatternsForScript, MAX_SCRIPT_PATTERNS } from "./pattern-select.js";
import type { PatternCard } from "./pattern-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-pattern-select-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function card(overrides: Partial<PatternCard> & { id: string }): PatternCard {
  return {
    sourceUrl: "https://www.douyin.com/video/1",
    canonicalUrl: "https://www.douyin.com/video/1",
    sourcePlatform: "douyin",
    applicablePlatforms: ["douyin"],
    title: "三步搞定选题",
    hook: "你以为选题难，其实是没有清单",
    structure: ["抛反常识结论", "给三步清单", "收尾留钩子"],
    whyItWorks: ["反常识开头压住划走"],
    themes: ["内容创作"],
    sourceInboxId: overrides.id.replace(/^pat-/, ""),
    revision: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

async function seed(cards: PatternCard[]): Promise<void> {
  await fs.mkdir(path.join(testDir, "patterns"), { recursive: true });
  await fs.writeFile(
    path.join(testDir, "patterns", "patterns.jsonl"),
    cards.map((c) => JSON.stringify(c)).join("\n") + "\n",
    "utf-8",
  );
}

const DOUYIN_TOPIC = { platform: "douyin" as const, topicText: "内容创作者怎么找选题" };

describe("selectPatternsForScript — 过滤", () => {
  it("平台不含当前目标平台 → 排除", async () => {
    await seed([
      card({ id: "pat-hit", applicablePlatforms: ["douyin", "wechat_video"] }),
      card({ id: "pat-miss", applicablePlatforms: ["xiaohongshu"] }),
    ]);
    const picked = await selectPatternsForScript(DOUYIN_TOPIC, testDir);
    expect(picked.map((c) => c.id)).toEqual(["pat-hit"]);
  });

  it("themes 与选题无交集 → 排除（平台匹配也不放行）", async () => {
    await seed([
      card({ id: "pat-hit", themes: ["内容创作"] }),
      card({ id: "pat-miss", themes: ["宠物用品", "露营装备"] }),
    ]);
    const picked = await selectPatternsForScript(DOUYIN_TOPIC, testDir);
    expect(picked.map((c) => c.id)).toEqual(["pat-hit"]);
  });

  it("墓碑卡不参与选卡", async () => {
    await seed([
      card({ id: "pat-live" }),
      card({ id: "pat-dead", deletedAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z" }),
    ]);
    const picked = await selectPatternsForScript(DOUYIN_TOPIC, testDir);
    expect(picked.map((c) => c.id)).toEqual(["pat-live"]);
  });

  it("全不匹配 → 空数组（不是兜底给最近几张）", async () => {
    await seed([card({ id: "pat-a", themes: ["宠物用品"] }), card({ id: "pat-b", applicablePlatforms: ["bilibili"] })]);
    expect(await selectPatternsForScript(DOUYIN_TOPIC, testDir)).toEqual([]);
  });

  it("选题文本为空 → 空数组（空串会跟任何主题都撞上）", async () => {
    await seed([card({ id: "pat-a" })]);
    expect(await selectPatternsForScript({ platform: "douyin", topicText: "   " }, testDir)).toEqual([]);
  });
});

describe("selectPatternsForScript — 双向子串匹配", () => {
  it("主题整体出现在选题里（theme ⊂ topicText）", async () => {
    await seed([card({ id: "pat-a", themes: ["选题"] })]);
    const picked = await selectPatternsForScript(
      { platform: "douyin", topicText: "普通人怎么做选题库" },
      testDir,
    );
    expect(picked.map((c) => c.id)).toEqual(["pat-a"]);
  });

  it("选题里的词落在主题里（topic 词 ⊂ theme）", async () => {
    await seed([card({ id: "pat-a", themes: ["副业赚钱方法论"] })]);
    const picked = await selectPatternsForScript(
      { platform: "douyin", topicText: "上班族的副业｜从零起步" },
      testDir,
    );
    expect(picked.map((c) => c.id)).toEqual(["pat-a"]);
  });

  it("大小写与空白不影响匹配（AI 工具 ≈ ai工具）", async () => {
    await seed([card({ id: "pat-a", themes: ["AI 工具"] })]);
    const picked = await selectPatternsForScript(
      { platform: "douyin", topicText: "三个ai工具帮你写稿" },
      testDir,
    );
    expect(picked.map((c) => c.id)).toEqual(["pat-a"]);
  });

  it("单字不构成匹配（「的」不该把无关卡拽进来）", async () => {
    await seed([card({ id: "pat-a", themes: ["的确良面料"] })]);
    const picked = await selectPatternsForScript(
      { platform: "douyin", topicText: "普通人 的 一天" },
      testDir,
    );
    expect(picked).toEqual([]);
  });
});

describe("selectPatternsForScript — 上限与排序", () => {
  it("按 updatedAt 降序，截断到上限 3 张", async () => {
    await seed([
      card({ id: "pat-1", updatedAt: "2026-07-01T00:00:00.000Z" }),
      card({ id: "pat-4", updatedAt: "2026-07-04T00:00:00.000Z" }),
      card({ id: "pat-2", updatedAt: "2026-07-02T00:00:00.000Z" }),
      card({ id: "pat-3", updatedAt: "2026-07-03T00:00:00.000Z" }),
    ]);
    const picked = await selectPatternsForScript(DOUYIN_TOPIC, testDir);
    expect(picked).toHaveLength(MAX_SCRIPT_PATTERNS);
    expect(picked.map((c) => c.id)).toEqual(["pat-4", "pat-3", "pat-2"]);
  });

  it("同 updatedAt 时次序稳定（重复调用结果一致）", async () => {
    const same = "2026-07-05T00:00:00.000Z";
    await seed([
      card({ id: "pat-x", updatedAt: same }),
      card({ id: "pat-y", updatedAt: same }),
      card({ id: "pat-z", updatedAt: same }),
    ]);
    const first = await selectPatternsForScript(DOUYIN_TOPIC, testDir);
    const second = await selectPatternsForScript(DOUYIN_TOPIC, testDir);
    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));
    expect(first).toHaveLength(3);
  });
});

describe("selectPatternsForScript — 读失败纪律", () => {
  it("patterns 目录不存在 = 正常空态，不抛", async () => {
    expect(await selectPatternsForScript(DOUYIN_TOPIC, testDir)).toEqual([]);
  });

  it("真读故障照抛（不静默当空库）", async () => {
    // patterns.jsonl 是目录 → EISDIR，属于「库坏了」而非「库还没有」
    await fs.mkdir(path.join(testDir, "patterns", "patterns.jsonl"), { recursive: true });
    await expect(selectPatternsForScript(DOUYIN_TOPIC, testDir)).rejects.toThrow();
  });
});
