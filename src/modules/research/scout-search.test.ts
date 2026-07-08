/**
 * scout-search.test.ts — 侦查员主动搜集（IA v5 V5.3）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scoutInspiration } from "./scout-search.js";
import { saveSearchConfig } from "./search-provider.js";
import type { searchWeb } from "./search-provider.js";
import type { judgeRelevance } from "../radar/relevance.js";
import { saveProfile } from "../profile/creator-profile.js";
import { listTopics, saveTopic, softDeleteTopic } from "../../storage/local-store.js";

let dir: string;

async function seedProfile(industry: string): Promise<void> {
  const now = new Date().toISOString();
  await saveProfile({
    industry, platforms: ["wechat_mp"],
    audiencePersona: { core: { name: "小林", coreAnxiety: "焦虑", painPoints: ["不会切入", "成本太高"] }, calibratedAt: now },
    writingRules: [], styleBoundaries: { never: [], always: [] }, competitorAccounts: [],
    performanceHistory: [], styleCalibrated: true, createdAt: now, updatedAt: now,
  }, dir);
}

const RESULTS = [
  { title: "AI 部署踩坑实录", url: "https://a.com/1", snippet: "s1" },
  { title: "无关的娱乐新闻", url: "https://b.com/2", snippet: "s2" },
  { title: "企业 AI 成本账", url: "https://c.com/3", snippet: "s3" },
];

const mockSearch = (async () => RESULTS) as unknown as typeof searchWeb;
const mockJudge = (async (_i: string, _a: string, candidates: Array<{ title: string }>) =>
  candidates.map((c, index) => ({
    index,
    score: c.title.includes("无关") ? 2 : 9,
    reason: "命中定位",
  }))) as unknown as typeof judgeRelevance;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-scout-"));
  await saveSearchConfig({ provider: "bocha", apiKey: "sk-test" }, dir);
  await seedProfile("AI 技术");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("scoutInspiration", () => {
  it("happy path:显式 query → 搜索 → 语义过滤(阈值7) → 入灵感库(source=search:bocha)", async () => {
    const r = await scoutInspiration({ query: "AI 部署" }, dir, { searchImpl: mockSearch, judge: mockJudge });
    expect(r.queriesUsed).toEqual(["AI 部署"]);
    expect(r.found).toBe(3);
    expect(r.filter).toBe("llm");
    expect(r.saved.map((t) => t.title)).toEqual(["AI 部署踩坑实录", "企业 AI 成本账"]);
    const topics = await listTopics(dir);
    expect(topics.every((t) => t.source === "search:bocha")).toBe(true);
    expect(topics[0].link).toMatch(/^https:/);
  });

  it("不带 query → 按定位+核心画像痛点推导搜索词(确定性,零 token)", async () => {
    const r = await scoutInspiration({}, dir, { searchImpl: mockSearch, judge: mockJudge });
    expect(r.queriesUsed).toEqual(["AI 技术 最新动态", "AI 技术 不会切入", "AI 技术 成本太高"]);
  });

  it("查重:已有同标题/同链接(含回收站)不再入库,删过的灵感不许还魂", async () => {
    const t = await saveTopic({ title: "AI 部署踩坑实录", description: "d", tags: [], link: "https://a.com/1" }, dir);
    await softDeleteTopic(t.id, dir); // 进回收站
    const r = await scoutInspiration({ query: "AI 部署" }, dir, { searchImpl: mockSearch, judge: mockJudge });
    expect(r.saved.map((x) => x.title)).toEqual(["企业 AI 成本账"]);
    expect(r.skippedDuplicates).toBe(1);
  });

  it("语义评审不可用 → 用户显式动作不静默丢弃,全量保留并注明 filter=none", async () => {
    const nullJudge = (async () => null) as unknown as typeof judgeRelevance;
    const r = await scoutInspiration({ query: "AI" }, dir, { searchImpl: mockSearch, judge: nullJudge });
    expect(r.filter).toBe("none");
    expect(r.saved).toHaveLength(3);
    expect(r.saved[0].reason).toContain("未过滤");
  });

  it("未配置搜索 / 无定位 → 人话报错", async () => {
    await fs.rm(path.join(dir, "search.json"));
    await expect(scoutInspiration({}, dir)).rejects.toThrow(/未配置/);
    await saveSearchConfig({ provider: "bocha", apiKey: "k" }, dir);
    await seedProfile("");
    await expect(scoutInspiration({}, dir, { searchImpl: mockSearch })).rejects.toThrow(/定位/);
  });
});
