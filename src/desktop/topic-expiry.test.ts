/**
 * topic-expiry.test.ts — 灵感库 3 天过期清理（创始人 2026-07-08 裁决）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expireStaleTopics, TOPIC_TTL_MS } from "./topic-expiry.js";
import { createWorkspace } from "./workspace-store.js";
import { saveTopic, listTopics, listTrash, saveContent, updateTopic } from "../storage/local-store.js";

let tmpHome: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-expiry-test-"));
  savedEnv = process.env.AUTOCREW_DATA_DIR;
  process.env.AUTOCREW_DATA_DIR = tmpHome;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.AUTOCREW_DATA_DIR;
  else process.env.AUTOCREW_DATA_DIR = savedEnv;
  await fs.rm(tmpHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** 直接改 topic 文件的 createdAt(saveTopic 总是写 now,测试需要旧时间戳) */
async function ageTopic(id: string, daysAgo: number, dataDir?: string): Promise<void> {
  const dir = dataDir ?? tmpHome;
  const p = path.join(dir, "topics", `${id}.json`);
  const t = JSON.parse(await fs.readFile(p, "utf-8"));
  t.createdAt = new Date(Date.now() - daysAgo * 24 * 3600_000).toISOString();
  await fs.writeFile(p, JSON.stringify(t, null, 2), "utf-8");
}

describe("expireStaleTopics", () => {
  it("超过 3 天未选用 → 移入回收站(软删可恢复);3 天内的不动", async () => {
    const stale = await saveTopic({ title: "过期灵感", description: "d", tags: [] });
    const fresh = await saveTopic({ title: "新鲜灵感", description: "d", tags: [] });
    await ageTopic(stale.id, 4);

    const r = await expireStaleTopics();

    expect(r.total).toBe(1);
    expect(r.expiredByWorkspace).toEqual({ default: 1 });
    const active = await listTopics();
    expect(active.map((t) => t.id)).toEqual([fresh.id]);
    const trash = await listTrash();
    expect(trash.topics.map((t) => t.id)).toEqual([stale.id]); // 可恢复,且参与查重防还魂
  });

  it("续期过的老灵感不被回收(深调研启动即续期一次)", async () => {
    const renewed = await saveTopic({ title: "正在深调研", description: "d", tags: [] });
    await ageTopic(renewed.id, 10);
    await updateTopic(renewed.id, { renewedAt: new Date().toISOString() });

    const r = await expireStaleTopics();

    expect(r.total).toBe(0);
    expect((await listTopics()).map((t) => t.id)).toEqual([renewed.id]);
  });

  it("有稿件血缘(content.topicId 指向)的到期灵感被保护,永不自动清理", async () => {
    const used = await saveTopic({ title: "被选上的灵感", description: "d", tags: [] });
    await ageTopic(used.id, 10);
    await saveContent({
      title: "由它写成的稿", body: "b", platform: "wechat_mp",
      status: "draft_ready", tags: [], hashtags: [], topicId: used.id,
    });

    const r = await expireStaleTopics();

    expect(r.total).toBe(0);
    expect(r.protectedByLineage).toBe(1);
    expect((await listTopics()).map((t) => t.id)).toEqual([used.id]);
  });

  it("多工作区全扫;事件落对应工作区 events.jsonl;ttl 可注入", async () => {
    const ws = await createWorkspace("Muse");
    const t = await saveTopic({ title: "子区旧灵感", description: "d", tags: [] }, ws.dataDir);
    await ageTopic(t.id, 1, ws.dataDir); // 1 天旧

    // 注入 12h ttl → 1 天旧的也过期
    const r = await expireStaleTopics({ ttlMs: 12 * 3600_000 });

    expect(r.expiredByWorkspace[ws.id]).toBe(1);
    const events = await fs.readFile(path.join(ws.dataDir, "events.jsonl"), "utf-8");
    expect(events).toMatch(/灵感库清理/);
    expect(TOPIC_TTL_MS).toBe(3 * 24 * 3600_000); // 默认 3 天(创始人裁决)钉死
  });
});

// ─── 等选角豁免（角度卡 spec §1.7）───────────────────────────────────────────
//
// 调研跑完、角度卡摆着等创始人挑,这条选题是**正在办的事**,不是没人要的灵感。
// 以简报 generatedAt 为续期锚:选完角度就恢复正常计时——选完还不写才是真放下了。

const ANGLE_CARD = {
  id: "angle-1",
  angle: "算一笔维护账",
  thesis: "省下的编码时间被维护成本吃回去了",
  coreEvidenceIds: ["ev-1"],
  antiScope: "不写工具横评",
  audiencePain: "老板拿提效数字压 KPI",
  holdTrigger: "看到自己上周那笔返工账",
  hookDraft: "提效 55% 是真的，只是账没算完。",
};

/** 一份最小可读简报（isBriefShape 只查注入/展示要用的字段） */
async function seedBrief(
  topicId: string,
  opts: { daysAgo: number; withCards?: boolean; dataDir?: string },
): Promise<void> {
  const brief = {
    schemaVersion: 1,
    summary: "s",
    perspectives: [],
    tensions: [],
    angleSuggestions: ["a", "b"],
    ...(opts.withCards === false ? {} : { angleCards: [ANGLE_CARD] }),
    evidence: [],
    assetPicks: [],
    missingPerspectives: [],
    gaps: [],
    generatedAt: new Date(Date.now() - opts.daysAgo * 24 * 3600_000).toISOString(),
    revision: 1,
    topicHash: "h",
  };
  const dir = path.join(opts.dataDir ?? tmpHome, "research", "briefs");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${topicId}.v1.json`), JSON.stringify(brief), "utf-8");
}

describe("等选角豁免", () => {
  it("简报刚出、角度卡等着挑 → 以 generatedAt 续期，不被 3 天回收误杀", async () => {
    const waiting = await saveTopic({ title: "等选角度", description: "d", tags: [] });
    await ageTopic(waiting.id, 10);
    await seedBrief(waiting.id, { daysAgo: 0 });

    const r = await expireStaleTopics();

    expect(r.total).toBe(0);
    expect((await listTopics()).map((t) => t.id)).toEqual([waiting.id]);
  });

  it("已选角度 → 照常计时（选完还不写就是真放下了）", async () => {
    const picked = await saveTopic({ title: "选完没动", description: "d", tags: [] });
    await ageTopic(picked.id, 10);
    await seedBrief(picked.id, { daysAgo: 0 });
    await updateTopic(picked.id, {
      selectedAngle: { briefRevision: 1, angleId: "angle-1", card: ANGLE_CARD, selectedAt: new Date().toISOString() },
    });

    const r = await expireStaleTopics();

    expect(r.total).toBe(1);
    expect((await listTrash()).topics.map((t) => t.id)).toEqual([picked.id]);
  });

  it("简报本身也旧了（角度摆了 10 天没人挑）→ 豁免到期，照常回收", async () => {
    const stale = await saveTopic({ title: "角度也放凉了", description: "d", tags: [] });
    await ageTopic(stale.id, 10);
    await seedBrief(stale.id, { daysAgo: 10 });

    expect((await expireStaleTopics()).total).toBe(1);
  });

  it("简报没有角度卡（旧简报/无证据降级）→ 没有等待可言，照常回收", async () => {
    const noCards = await saveTopic({ title: "简报没角度卡", description: "d", tags: [] });
    await ageTopic(noCards.id, 10);
    await seedBrief(noCards.id, { daysAgo: 0, withCards: false });

    expect((await expireStaleTopics()).total).toBe(1);
  });

  it("简报文件坏了 → 按「没有简报」处理，豁免加不上但也不阻断清理", async () => {
    const broken = await saveTopic({ title: "坏简报", description: "d", tags: [] });
    await ageTopic(broken.id, 10);
    const dir = path.join(tmpHome, "research", "briefs");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${broken.id}.v1.json`), "{ 半条 JSON", "utf-8");

    expect((await expireStaleTopics()).total).toBe(1);
  });
});
