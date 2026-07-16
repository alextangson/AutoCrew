import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { intakeRadarTopics, rescoreExistingTopics } from "./radar-intake.js";
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

  it("给 X 留评判池名额:不含关键词的关注观点仍能被 LLM 评到并入库", async () => {
    await saveProfile(profileWith("AI 工具"), testDir);
    // 25 条命中「AI」的非 X 新闻(撑爆池) + 2 条不含关键词的 X 观点(= X_POOL_RESERVE 名额)
    const items = [
      ...Array.from({ length: 25 }, (_, i) => ({ title: `AI 新闻 ${i}`, link: `https://n/${i}`, source: "Hacker News" })),
      { title: "重写一切的时代来了", link: "https://x/1", source: "X" },
      { title: "我加入了一家公司", link: "https://x/2", source: "X" },
    ];
    await fs.writeFile(
      path.join(testDir, "topic-radar.json"),
      JSON.stringify({ fetchedAt: new Date().toISOString(), items: items.map((it) => ({ ...it, publishedAt: new Date().toISOString() })) }),
    );

    let judged: string[] = [];
    const judge = (async (_ind: string, _aud: string, cands: Array<{ title: string; source: string }>) => {
      judged = cands.map((c) => c.title);
      // 只给 X 项高分——非 X 一律低分,证明入库的 X 是靠名额进池、靠 LLM 判过的
      return cands.map((c, index) => ({ index, score: c.source === "X" ? 9 : 3, reason: "t", titleZh: c.title }));
    }) as typeof import("./relevance.js").judgeRelevance;

    const result = await intakeRadarTopics(testDir, { judge });

    // X 观点(命中定位词=空)确实进了评判池,没被关键词粗筛挡在池外
    for (const t of ["重写一切的时代来了", "我加入了一家公司"]) {
      expect(judged).toContain(t);
    }
    // 且被判高相关 → 入库
    expect(result.saved.map((s) => s.title).sort()).toEqual(["我加入了一家公司", "重写一切的时代来了"].sort());
  });

  it("落选记忆:LLM 评过没过关的候选,下一轮不再回池重评", async () => {
    await saveProfile(profileWith("AI 工具"), testDir);
    await fs.writeFile(
      path.join(testDir, "topic-radar.json"),
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        items: [
          { title: "AI 好选题", link: "https://n/1", source: "Hacker News", publishedAt: new Date().toISOString() },
          { title: "AI 烂选题", link: "https://n/2", source: "Hacker News", publishedAt: new Date().toISOString() },
        ],
      }),
    );
    const judgedPerRound: string[][] = [];
    const judge = (async (_i: string, _a: string, cands: Array<{ title: string }>) => {
      judgedPerRound.push(cands.map((c) => c.title));
      // 只让「好选题」过关;「烂选题」被评但不返回 → 落选
      return cands
        .map((c, index) => ({ index, score: c.title.includes("好") ? 9 : 0, reason: "t", titleZh: c.title }))
        .filter((v) => v.score > 0);
    }) as typeof import("./relevance.js").judgeRelevance;

    await intakeRadarTopics(testDir, { judge }); // 第一轮:两条都被评
    await intakeRadarTopics(testDir, { judge }); // 第二轮:烂选题应被落选记忆挡住

    expect(judgedPerRound[0]).toContain("AI 烂选题");
    expect(judgedPerRound[1] ?? []).not.toContain("AI 烂选题"); // 不再重评
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
    // 已看过/删过的候选在送入评分前就排除，不再浪费本轮模型名额。
    expect(result.skippedDuplicates).toBe(0);
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

describe("LLM semantic filter (unified intel layer)", () => {
  it("persists Chinese title, 100-point breakdown, summary and writing angles", async () => {
    await saveProfile(profileWith("AI 效率工具"), testDir);
    await seedCache([{ title: "Show HN: A visual debugger for AI agents", link: "https://a.example/1" }]);
    const judge = async () => [
      {
        index: 0,
        score: 8.4,
        totalScore: 84,
        scoreBreakdown: { audienceFit: 28, materialRichness: 18, novelty: 22, timeliness: 16 },
        titleZh: "AI Agent 调试终于有可视化工具了",
        summaryZh: "一款面向 AI Agent 的可视化调试工具发布，适合验证它能否降低排查循环与工具调用问题的成本。",
        angles: ["实测安装和首个调试流程", "与日志排查方法对比", "哪些团队值得接入"],
        reason: "正中 AI 工具用户的调试痛点",
      },
    ];
    const result = await intakeRadarTopics(testDir, { judge });
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0]).toMatchObject({
      title: "AI Agent 调试终于有可视化工具了",
      originalTitle: "Show HN: A visual debugger for AI agents",
      score: 84,
      scoreBreakdown: { materialRichness: 18 },
    });
    expect(result.saved[0].description).toContain("可视化调试工具");
    expect(result.saved[0].angles).toHaveLength(3);
  });

  it("continue collection evaluates unseen candidates instead of returning the same batch", async () => {
    await saveProfile(profileWith("AI"), testDir);
    await seedCache([
      { title: "AI 候选一", link: "https://a.example/1" },
      { title: "AI 候选二", link: "https://a.example/2" },
      { title: "AI 候选三", link: "https://a.example/3" },
      { title: "AI 候选四", link: "https://a.example/4" },
    ]);
    const seenBatches: string[][] = [];
    const judge = async (_positioning, _audience, candidates) => {
      seenBatches.push(candidates.map((c) => c.title));
      return candidates.map((_, index) => ({ index, score: 8, totalScore: 80, reason: "值得写" }));
    };
    const first = await intakeRadarTopics(testDir, { judge, limit: 2 });
    const second = await intakeRadarTopics(testDir, { judge, limit: 2 });
    expect(first.saved).toHaveLength(2);
    expect(second.saved).toHaveLength(2);
    expect(seenBatches[1]).not.toEqual(seenBatches[0]);
    expect(new Set((await listTopics(testDir)).map((t) => t.link)).size).toBe(4);
  });

  it("uses LLM verdicts as primary filter — works for positioning words absent from titles", async () => {
    await saveProfile(profileWith("职场成长"), testDir); // 标题里不会出现的定位
    await seedCache([
      { title: "大厂裁员潮下的自救指南", link: "https://a.example/1" },
      { title: "楼市周报", link: "https://a.example/2" },
    ]);
    const judge = async (positioning, _aud, candidates) => {
      expect(positioning).toBe("职场成长");
      expect(candidates).toHaveLength(2);
      return [
        { index: 0, score: 9, reason: "裁员潮正是职场成长受众的核心焦虑" },
        { index: 1, score: 2, reason: "" },
      ];
    };
    const result = await intakeRadarTopics(testDir, { judge });

    expect(result.filter).toBe("llm");
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].title).toBe("大厂裁员潮下的自救指南");
    expect(result.saved[0].reason).toContain("核心焦虑"); // LLM 理由直接上卡
  });

  it("falls back to keyword filter when judge returns null (engine unavailable)", async () => {
    await saveProfile(profileWith("AI"), testDir);
    await seedCache([{ title: "AI 编程新品", link: "https://a.example/1" }]);
    const result = await intakeRadarTopics(testDir, { judge: async () => null });
    expect(result.filter).toBe("keyword");
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].reason).toContain("命中定位");
  });

  it("does not auto-save English-only candidates when the scoring model is unavailable", async () => {
    await saveProfile(profileWith("AI"), testDir);
    await seedCache([{ title: "Show HN: AI workflow engine", link: "https://a.example/1" }]);
    const result = await intakeRadarTopics(testDir, { judge: async () => null });
    expect(result.saved).toHaveLength(0);
  });
});

describe("rescoreExistingTopics", () => {
  it("upgrades existing English radar topics in place", async () => {
    await saveProfile(profileWith("AI 工具"), testDir);
    const old = await saveTopic(
      {
        title: "A new observability tool for AI agents",
        description: "Tracing agent tool calls",
        tags: ["radar"],
        source: "radar:Hacker News",
        link: "https://a.example/old",
      },
      testDir,
    );
    const judge = async () => [
      {
        index: 0,
        score: 8.1,
        totalScore: 81,
        scoreBreakdown: { audienceFit: 27, materialRichness: 18, novelty: 20, timeliness: 16 },
        titleZh: "AI Agent 可观测性工具值不值得接入",
        summaryZh: "新工具聚焦 Agent 工具调用链路追踪，可从接入成本、问题定位速度和数据完整性三个方面验证。",
        angles: ["接入实测", "与普通日志对比", "适用团队判断"],
        reason: "适合做真实接入验证",
      },
    ];
    const result = await rescoreExistingTopics(testDir, { judge });
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].id).toBe(old.id);
    expect(result.updated[0]).toMatchObject({
      title: "AI Agent 可观测性工具值不值得接入",
      originalTitle: "A new observability tool for AI agents",
      score: 81,
    });
  });
});
