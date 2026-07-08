import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { intakeRadarTopics } from "./radar-intake.js";
import type { TopicCache } from "./topic-radar.js";
import { saveTopic, listTopics, softDeleteTopic } from "../../storage/local-store.js";
import { saveProfile } from "../profile/creator-profile.js";
import type { CreatorProfile } from "../profile/creator-profile.js";

let testDir: string;

function profileWith(industry: string): CreatorProfile {
  const now = new Date().toISOString();
  return {
    industry,
    platforms: ["wechat_mp"],
    audiencePersona: null,
    writingRules: [],
    styleBoundaries: { never: [], always: [] },
    competitorAccounts: [],
    performanceHistory: [],
    styleCalibrated: true,
    createdAt: now,
    updatedAt: now,
  };
}

async function seedCache(titles: Array<{ title: string; link: string }>): Promise<void> {
  const cache: TopicCache = {
    fetchedAt: new Date().toISOString(),
    items: titles.map((t, i) => ({
      title: t.title,
      link: t.link,
      source: i % 2 === 0 ? "36氪" : "爱范儿",
      publishedAt: new Date().toISOString(),
    })),
  };
  await fs.writeFile(path.join(testDir, "topic-radar.json"), JSON.stringify(cache));
}

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-intake-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("intakeRadarTopics", () => {
  it("saves only positioning-matched candidates, capped at 3, with reason/link/source", async () => {
    await saveProfile(profileWith("AI 效率工具"), testDir);
    await seedCache([
      { title: "AI 编程助手大更新", link: "https://a.example/1" },
      { title: "AI 芯片新格局", link: "https://a.example/2" },
      { title: "AI 搜索之战", link: "https://a.example/3" },
      { title: "AI 音乐生成器上线", link: "https://a.example/4" },
      { title: "楼市周报", link: "https://a.example/5" },
    ]);

    const result = await intakeRadarTopics(testDir);

    expect(result.saved).toHaveLength(3); // 4 条命中「AI」,cap=3
    expect(result.qualified).toBe(4);
    const topics = await listTopics(testDir);
    expect(topics).toHaveLength(3);
    for (const t of topics) {
      expect(t.reason).toContain("命中定位");
      expect(t.link).toMatch(/^https:/);
      expect(t.source).toMatch(/^radar:/);
      expect(t.tags).toContain("radar");
    }
    // 未命中定位的纯热点不入库
    expect(topics.some((t) => t.title === "楼市周报")).toBe(false);
  });

  it("does nothing without a positioning (no industry = no filter = no intake)", async () => {
    await seedCache([{ title: "AI 大新闻", link: "https://a.example/1" }]);
    const result = await intakeRadarTopics(testDir);
    expect(result.saved).toHaveLength(0);
    expect(await listTopics(testDir)).toHaveLength(0);
  });

  it("dedupes against existing topics including trashed ones (deleted ideas stay dead)", async () => {
    await saveProfile(profileWith("AI"), testDir);
    const kept = await saveTopic(
      { title: "AI 编程助手大更新", description: "d", tags: [], link: "https://a.example/1" },
      testDir,
    );
    const trashed = await saveTopic(
      { title: "AI 芯片新格局", description: "d", tags: [], link: "https://a.example/2" },
      testDir,
    );
    await softDeleteTopic(trashed.id, testDir);
    await seedCache([
      { title: "AI 编程助手大更新", link: "https://a.example/1" }, // dup by title+link
      { title: "AI 芯片新格局", link: "https://a.example/2" },     // dup vs trash
      { title: "AI 眼镜发布", link: "https://a.example/6" },        // fresh
    ]);

    const result = await intakeRadarTopics(testDir);

    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].title).toBe("AI 眼镜发布");
    expect(result.skippedDuplicates).toBe(2);
    const active = await listTopics(testDir);
    expect(active.map((t) => t.id)).toContain(kept.id);
    expect(active).toHaveLength(2); // kept + fresh（trashed 不还魂）
  });

  it("returns empty when radar cache is missing", async () => {
    await saveProfile(profileWith("AI"), testDir);
    const result = await intakeRadarTopics(testDir);
    expect(result.saved).toHaveLength(0);
  });
});
