/**
 * topic-expiry.test.ts — 灵感库过期清理（创始人 2026-07-08 裁决；2026-10-25 改 7 天 + 星级 / 捞回豁免 + 上线日起算）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expireStaleTopics, TOPIC_TTL_MS } from "./topic-expiry.js";
import { createWorkspace } from "./workspace-store.js";
import { saveTopic, listTopics, listTrash, saveContent, updateTopic } from "../storage/local-store.js";
import {
  pendingPerspectives,
  upsertJob,
  type ResearchJob,
} from "../modules/research/research-job-store.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";

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
  await seedAgingStart(dir, 365); // 上线日标记早于一切：这些用例只测老化本身
  const p = path.join(dir, "topics", `${id}.json`);
  const t = JSON.parse(await fs.readFile(p, "utf-8"));
  t.createdAt = new Date(Date.now() - daysAgo * 24 * 3600_000).toISOString();
  await fs.writeFile(p, JSON.stringify(t, null, 2), "utf-8");
}

async function seedAgingStart(dir: string, daysAgo: number): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "topic-aging-v7.json"), JSON.stringify({ startedAt: new Date(Date.now() - daysAgo * 24 * 3600_000).toISOString() }));
}

describe("expireStaleTopics", () => {
  it("回归：会议记录读不出时不清带会议位的选题，并留下可见记录", async () => {
    const slotted = await saveTopic({ title: "片单", description: "d", tags: [] });
    const plain = await saveTopic({ title: "普通", description: "d", tags: [] });
    await ageTopic(slotted.id, 8);
    await ageTopic(plain.id, 8);
    await updateTopic(slotted.id, { meetingSlot: { meetingDate: "2026-09-25", slotId: "s1" } });
    await fs.writeFile(path.join(tmpHome, "meetings"), "不是目录");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await expireStaleTopics()).total).toBe(1);
    expect((await listTopics()).map((t) => t.id)).toEqual([slotted.id]);
    expect(warn.mock.calls.flat().join("")).toContain("会议记录读不出");
    warn.mockRestore();
  });

  it("会议位选题豁免到下次开会为止；下次没再选中就恢复正常过期（选题会边界 8）", async () => {
    const { saveMeetingCas } = await import("../modules/meetings/meeting-store.js");
    const slotted = await saveTopic({ title: "本周片单", description: "d", tags: [] });
    await ageTopic(slotted.id, 8);
    await updateTopic(slotted.id, { meetingSlot: { meetingDate: "2026-09-25", slotId: "s1" } });
    await saveMeetingCas({ date: "2026-09-25", slots: [], rejected: [], reviews: [] }, 0, tmpHome);
    expect((await expireStaleTopics()).total).toBe(0);
    await saveMeetingCas({ date: "2026-10-02", slots: [], rejected: [], reviews: [] }, 0, tmpHome);
    expect((await expireStaleTopics()).total).toBe(1);
    expect((await listTopics()).map((t) => t.id)).not.toContain(slotted.id);
  });

  it("超过 7 天未选用 → 移入回收站(软删可恢复);7 天内的不动", async () => {
    const stale = await saveTopic({ title: "过期灵感", description: "d", tags: [] });
    const fresh = await saveTopic({ title: "新鲜灵感", description: "d", tags: [] });
    await ageTopic(stale.id, 8);
    await ageTopic(fresh.id, 6);

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
    await saveContent({ _provenance: HUMAN_WRITE,
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
    expect(TOPIC_TTL_MS).toBe(7 * 24 * 3600_000); // 默认 7 天(spec §6 Q5)钉死
  });

  it("≥3 星不老化；1–2 星不会出现在活跃列表；捞回过的不老化", async () => {
    const three = await saveTopic({ title: "三星", description: "d", tags: [] });
    const restored = await saveTopic({ title: "捞回的", description: "d", tags: [] });
    const plain = await saveTopic({ title: "没打星", description: "d", tags: [] });
    for (const t of [three, restored, plain]) await ageTopic(t.id, 30);
    await updateTopic(three.id, { stars: 3 });
    await updateTopic(restored.id, { restoredAt: new Date().toISOString() });
    const r = await expireStaleTopics();
    expect(r.total).toBe(1);
    expect((await listTopics()).map((t) => t.id).sort()).toEqual([three.id, restored.id].sort());
  });

  it("上线前的旧选题从上线日起算 7 天：第一次清理写标记，不一上线就清；7 天后照清", async () => {
    const old = await saveTopic({ title: "上线前的旧选题", description: "d", tags: [] });
    const p = path.join(tmpHome, "topics", `${old.id}.json`);
    const t = JSON.parse(await fs.readFile(p, "utf-8"));
    t.createdAt = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    await fs.writeFile(p, JSON.stringify(t));
    expect((await expireStaleTopics()).total).toBe(0);
    const marker = JSON.parse(await fs.readFile(path.join(tmpHome, "topic-aging-v7.json"), "utf-8"));
    expect(Number.isFinite(new Date(marker.startedAt).getTime())).toBe(true);
    expect((await expireStaleTopics({ now: Date.now() + 6 * 24 * 3600_000 })).total).toBe(0);
    expect((await expireStaleTopics({ now: Date.now() + 8 * 24 * 3600_000 })).total).toBe(1);
  });

  it("过期 ≠ 不喜欢：过期进回收站的不带星，不产生负反馈", async () => {
    const { loadStarAdjustments } = await import("../modules/radar/topic-stars.js");
    const t = await saveTopic({ title: "过期", description: "d", tags: [], source: "radar:HN" });
    await ageTopic(t.id, 8);
    expect((await expireStaleTopics()).total).toBe(1);
    expect((await loadStarAdjustments()).size).toBe(0);
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

/** 台账指针：豁免认的是 job.briefRevision 指向的那版（P1 §3.0），落一份就够 */
async function seedJob(topicId: string, briefRevision: number | undefined, dataDir?: string): Promise<void> {
  const job: ResearchJob = {
    topicId,
    status: "succeeded",
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    settledAt: new Date().toISOString(),
    perspectives: pendingPerspectives(),
    ...(briefRevision === undefined ? {} : { briefRevision }),
    topicHash: "h",
  };
  await upsertJob(job, dataDir ?? tmpHome);
}

/** 一份最小可读简报（isBriefShape 只查注入/展示要用的字段） */
async function seedBrief(
  topicId: string,
  opts: { daysAgo: number; withCards?: boolean; dataDir?: string; revision?: number; adopt?: boolean },
): Promise<void> {
  const revision = opts.revision ?? 1;
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
    revision,
    topicHash: "h",
  };
  const dir = path.join(opts.dataDir ?? tmpHome, "research", "briefs");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${topicId}.v${revision}.json`), JSON.stringify(brief), "utf-8");
  // adopt:false = 只落文件不推指针（重跑落了盘却没结算成的孤儿版本）
  if (opts.adopt !== false) await seedJob(topicId, revision, opts.dataDir);
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
    await seedJob(broken.id, 1);

    expect((await expireStaleTopics()).total).toBe(1);
  });

  // ── 单一简报快照（P1 §3.0）─────────────────────────────────────────────────

  it("盘上有更新的孤儿 v2（重跑没结算成）→ 豁免仍按指针指的 v1 算，不被白续期", async () => {
    const orphan = await saveTopic({ title: "孤儿 v2", description: "d", tags: [] });
    await ageTopic(orphan.id, 10);
    // 生效那版（v1）的角度卡已经放凉 10 天 → 豁免到期
    await seedBrief(orphan.id, { daysAgo: 10, revision: 1 });
    // 磁盘最大版是刚落的 v2，但从未被采纳：拿它续期等于给没结果的选题白加三天
    await seedBrief(orphan.id, { daysAgo: 0, revision: 2, adopt: false });

    expect((await expireStaleTopics()).total).toBe(1);
  });

  it("没有台账指针（简报文件孤零零躺着）→ 按「没有简报」处理，照常回收", async () => {
    const noPointer = await saveTopic({ title: "无指针", description: "d", tags: [] });
    await ageTopic(noPointer.id, 10);
    await seedBrief(noPointer.id, { daysAgo: 0, adopt: false });

    expect((await expireStaleTopics()).total).toBe(1);
  });
});
