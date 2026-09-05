/**
 * topic-angle.test.ts — 角度点选在桌面层的两个入口（角度卡 spec §1.4/§1.6）：
 * 聊天写稿闸口（chat-router 的 generate_script）与选卡通道（ipc 的 topic:select_angle）。
 *
 * 闸口那条是本刀的要害：**有候选卡却没选就不接单**。省掉这一轮往返，整条角度链就白建了
 * （创始人 2026-08-23 裁决点 1）。所以五条分支各一条用例，一条都不能靠「应该没问题」。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { buildChatTools, type ChatCard } from "./chat-router.js";
import { buildIpcHandlers } from "./ipc.js";
import { BRIEF_SCHEMA_VERSION, saveBrief, type AngleCard, type ResearchBrief } from "../modules/research/brief-store.js";
import {
  pendingPerspectives,
  topicHashOf,
  upsertJob,
  type ResearchJob,
} from "../modules/research/research-job-store.js";
import { getTopic, saveTopic, updateTopic, type Topic } from "../storage/local-store.js";

let testDir: string;

const TITLE = "AI 编程助手横评";
const DESC = "对比 5 个主流工具的真实提效";

const CARD: AngleCard = {
  id: "angle-1",
  angle: "算一笔维护账",
  thesis: "省下的编码时间被维护成本吃回去了",
  coreEvidenceIds: ["ev-1"],
  antiScope: "不写工具横评",
  audiencePain: "老板拿提效数字压 KPI",
  holdTrigger: "看到自己上周那笔返工账",
  hookDraft: "提效 55% 是真的，只是账没算完。",
};
const CARD_2: AngleCard = { ...CARD, id: "angle-2", thesis: "翻车集中在重构类任务", antiScope: "不做成本测算" };

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-angle-desktop-"));
  await fs.writeFile(
    path.join(testDir, "engine.json"),
    JSON.stringify({ apiKey: "test-key", baseUrl: "https://fake.local" }),
  );
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function makeBrief(over: Partial<ResearchBrief> = {}): ResearchBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    summary: "厂商口径与独立评测差了四倍。",
    perspectives: [],
    tensions: ["厂商宣称提效 55%，独立评测只测到 12%"],
    angleSuggestions: ["算一笔维护账"],
    angleCards: [CARD, CARD_2],
    evidence: [
      { claim: "提效幅度远低于厂商口径", quote: "平均完成时间缩短约 12%。", sourceUrl: "https://example.com/s" },
    ],
    assetPicks: [],
    missingPerspectives: [],
    gaps: [],
    generatedAt: "2026-08-24T10:00:00.000Z",
    revision: 1,
    topicHash: topicHashOf(TITLE, DESC),
    ...over,
  };
}

/** CAS 推进台账指针 = 这一版才是「当前生效简报」（P1 §3.0，两个入口都认它） */
async function adopt(topicId: string, briefRevision: number): Promise<void> {
  const job: ResearchJob = {
    topicId,
    status: "succeeded",
    startedAt: "2026-08-24T09:00:00.000Z",
    settledAt: "2026-08-24T10:00:00.000Z",
    perspectives: pendingPerspectives(),
    briefRevision,
    topicHash: topicHashOf(TITLE, DESC),
  };
  await upsertJob(job, testDir);
}

async function seed(brief: ResearchBrief | null = makeBrief()): Promise<Topic> {
  const topic = await saveTopic({ title: TITLE, description: DESC, tags: [] }, testDir);
  if (brief) {
    await saveBrief(topic.id, brief, testDir);
    await adopt(topic.id, brief.revision);
  }
  return topic;
}

// ─── 聊天闸口（§1.6）─────────────────────────────────────────────────────────

/** 每条分支都要看「有没有真的派活」，所以 startGenerate 一律打桩并断言调用次数 */
function tools(sink: ChatCard[] = []) {
  const startGenerate = vi.fn(async () => ({
    contentId: "c-new", runId: "run-1", completion: Promise.resolve(),
  }));
  // list 永远空：中断稿重写是另一条分支，这里不该被它抢先
  const content = vi.fn(async (p: Record<string, unknown>) =>
    p.action === "list" ? { ok: true, contents: [] } : { ok: true });
  return { sink, startGenerate, list: buildChatTools(sink, testDir, { startGenerate, content }) };
}

const run = (t: ReturnType<typeof tools>, args: Record<string, unknown>) =>
  t.list.find((x) => x.name === "generate_script")!.execute(args) as Promise<string>;

describe("generate_script 的角度闸口", () => {
  it("有候选卡且没选 → 不接单：回 needsAngle + 候选清单，同时推一张 angle_cards 卡", async () => {
    const topic = await seed();
    const t = tools();

    const out = JSON.parse(await run(t, { topic: TITLE, platform: "douyin", topic_id: topic.id }));

    expect(t.startGenerate).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, needsAngle: true });
    expect(out.cards.map((c: { id: string }) => c.id)).toEqual(["angle-1", "angle-2"]);
    expect(out.note).toContain("不要替用户选");
    expect(t.sink).toHaveLength(1);
    expect(t.sink[0].type).toBe("angle_cards");
    expect(t.sink[0].data).toMatchObject({ topicId: topic.id, revision: 1 });
  });

  it("带 angle_id → 落 topic.selectedAngle（存的是整张卡快照）并照常开写", async () => {
    const topic = await seed();
    const t = tools();

    const out = JSON.parse(
      await run(t, { topic: TITLE, platform: "douyin", topic_id: topic.id, angle_id: "angle-2" }),
    );

    expect(out).toMatchObject({ ok: true, pending: true, contentId: "c-new" });
    expect(t.startGenerate).toHaveBeenCalledOnce();
    const saved = await getTopic(topic.id, testDir);
    expect(saved?.selectedAngle).toMatchObject({ briefRevision: 1, angleId: "angle-2", card: CARD_2 });
  });

  it("angle_id 不在生效简报里 → 拒绝并让总编辑重念候选，不落选题、不开写", async () => {
    const topic = await seed();
    const t = tools();

    const out = JSON.parse(
      await run(t, { topic: TITLE, platform: "douyin", topic_id: topic.id, angle_id: "angle-9" }),
    );

    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain("angle-9");
    expect(t.startGenerate).not.toHaveBeenCalled();
    expect((await getTopic(topic.id, testDir))?.selectedAngle).toBeUndefined();
  });

  it("skip_reason（用户明说直接写）→ 放行开写，原话进 ScriptRequest 留痕", async () => {
    const topic = await seed();
    const t = tools();

    const out = JSON.parse(
      await run(t, { topic: TITLE, platform: "douyin", topic_id: topic.id, skip_reason: "用户说：别选角度，直接写" }),
    );

    expect(out).toMatchObject({ ok: true, pending: true });
    expect(t.startGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ angleSkipReason: "用户说：别选角度，直接写" }),
      testDir,
    );
  });

  it("direction（用户手写角度）→ 放行开写，原话进 ScriptRequest", async () => {
    const topic = await seed();
    const t = tools();

    await run(t, { topic: TITLE, platform: "douyin", topic_id: topic.id, direction: "从被裁掉的初级程序员视角写" });

    expect(t.startGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "从被裁掉的初级程序员视角写" }),
      testDir,
    );
  });

  it("没有简报 / 简报没有角度卡 / 没带 topic_id → 现状直写（§1.8 不硬出角度）", async () => {
    const bare = await seed(null);
    const noCards = await seed(makeBrief({ angleCards: undefined }));
    const cases: Array<[string, Record<string, unknown>]> = [
      ["没有简报", { topic: TITLE, platform: "douyin", topic_id: bare.id }],
      ["简报没有角度卡", { topic: TITLE, platform: "douyin", topic_id: noCards.id }],
      ["随手写没带 topic_id", { topic: TITLE, platform: "douyin" }],
    ];
    for (const [label, args] of cases) {
      const t = tools();
      const out = JSON.parse(await run(t, args));
      expect(out, label).toMatchObject({ ok: true, pending: true });
      expect(t.startGenerate, label).toHaveBeenCalledOnce();
      expect(t.sink, label).toHaveLength(0);
    }
  });

  it("之前选过且还作数 → 不再问一遍，直接开写", async () => {
    const topic = await seed();
    await updateTopic(
      topic.id,
      { selectedAngle: { briefRevision: 1, angleId: "angle-1", card: CARD, selectedAt: "2026-08-24T11:00:00.000Z" } },
      testDir,
    );
    const t = tools();

    const out = JSON.parse(await run(t, { topic: TITLE, platform: "douyin", topic_id: topic.id }));

    expect(out).toMatchObject({ ok: true, pending: true });
    expect(t.startGenerate).toHaveBeenCalledOnce();
  });

  it("中断稿重写排在闸口之前：崩掉那次原样重来，不再问一遍角度", async () => {
    const topic = await seed();
    const retryGenerate = vi.fn(async () => ({
      contentId: "c-stale", runId: "run-2", completion: Promise.resolve(),
    }));
    const content = vi.fn(async (p: Record<string, unknown>) =>
      p.action === "list"
        ? { ok: true, contents: [{ id: "c-stale", topicId: topic.id, platform: "douyin", lastError: "断流" }] }
        : { ok: true });
    const sink: ChatCard[] = [];
    const list = buildChatTools(sink, testDir, { content, retryGenerate });

    const out = JSON.parse(
      (await list.find((x) => x.name === "generate_script")!.execute({
        topic: TITLE, platform: "douyin", topic_id: topic.id,
      })) as string,
    );

    expect(out).toMatchObject({ ok: true, pending: true, contentId: "c-stale" });
    expect(retryGenerate).toHaveBeenCalledOnce();
    expect(sink).toHaveLength(0);
  });

  it("angle_id 与中断稿重写同轮到达：先落选题再重写——刚选的角度不许被重写路径吞掉", async () => {
    const topic = await seed();
    const retryGenerate = vi.fn(async () => ({
      contentId: "c-stale", runId: "run-2", completion: Promise.resolve(),
    }));
    const content = vi.fn(async (p: Record<string, unknown>) =>
      p.action === "list"
        ? { ok: true, contents: [{ id: "c-stale", topicId: topic.id, platform: "douyin", lastError: "断流" }] }
        : { ok: true });
    const list = buildChatTools([], testDir, { content, retryGenerate });

    const out = JSON.parse(
      (await list.find((x) => x.name === "generate_script")!.execute({
        topic: TITLE, platform: "douyin", topic_id: topic.id, angle_id: "angle-2",
      })) as string,
    );

    expect(out).toMatchObject({ ok: true, pending: true, contentId: "c-stale" });
    expect(retryGenerate).toHaveBeenCalledOnce(); // 仍走原地重写,没有新建
    const saved = await getTopic(topic.id, testDir);
    expect(saved?.selectedAngle).toMatchObject({ briefRevision: 1, angleId: "angle-2" }); // 选择先落了盘
  });
});

// ─── 选卡通道（§1.4）─────────────────────────────────────────────────────────

describe("topic:select_angle / topic:clear_angle", () => {
  const call = (channel: "topic:select_angle" | "topic:clear_angle", payload: Record<string, unknown>) =>
    buildIpcHandlers()[channel]({ ...payload, _dataDir: testDir });

  it("点选：落原卡快照 + 指针", async () => {
    const topic = await seed();

    const res = await call("topic:select_angle", { topic_id: topic.id, brief_revision: 1, angle_id: "angle-1" });

    expect(res.ok).toBe(true);
    const saved = await getTopic(topic.id, testDir);
    expect(saved?.selectedAngle).toMatchObject({ briefRevision: 1, angleId: "angle-1", card: CARD });
  });

  it("brief_revision 不是生效版 → 拒（用户手上是过期候选）", async () => {
    const topic = await seed();
    await saveBrief(topic.id, makeBrief({ revision: 2 }), testDir);
    await adopt(topic.id, 2);

    const res = await call("topic:select_angle", { topic_id: topic.id, brief_revision: 1, angle_id: "angle-1" });

    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("v2");
    expect((await getTopic(topic.id, testDir))?.selectedAngle).toBeUndefined();
  });

  it("angle_id 不存在 / 选题不存在 / 没有简报 → 各自人话拒绝", async () => {
    const topic = await seed();
    expect(
      String((await call("topic:select_angle", { topic_id: topic.id, brief_revision: 1, angle_id: "angle-9" })).error),
    ).toContain("angle-9");

    const bare = await seed(null);
    expect(
      String((await call("topic:select_angle", { topic_id: bare.id, brief_revision: 1, angle_id: "angle-1" })).error),
    ).toContain("还没有可用简报");

    expect(
      String(
        (await call("topic:select_angle", { topic_id: "topic-nope00", brief_revision: 1, angle_id: "angle-1" })).error,
      ),
    ).toContain("not found");
  });

  it("改写：文字随便改，证据引用改不出简报里没有的（Batch 2 的改写动作走这条）", async () => {
    const topic = await seed();
    const rewritten = { ...CARD, thesis: "创始人自己改过的论点", antiScope: "创始人自己写的禁区" };

    const ok = await call("topic:select_angle", {
      topic_id: topic.id, brief_revision: 1, angle_id: "angle-1", card: rewritten,
    });
    expect(ok.ok).toBe(true);
    expect((await getTopic(topic.id, testDir))?.selectedAngle?.card.thesis).toBe("创始人自己改过的论点");

    const bad = await call("topic:select_angle", {
      topic_id: topic.id, brief_revision: 1, angle_id: "angle-1", card: { ...CARD, coreEvidenceIds: ["ev-7"] },
    });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("ev-7");

    const empty = await call("topic:select_angle", {
      topic_id: topic.id, brief_revision: 1, angle_id: "angle-1", card: { ...CARD, thesis: "  " },
    });
    expect(String(empty.error)).toContain("thesis");
  });

  it("清除：字段从盘上消失，写稿回到「未经角度点选」", async () => {
    const topic = await seed();
    await call("topic:select_angle", { topic_id: topic.id, brief_revision: 1, angle_id: "angle-1" });

    const res = await call("topic:clear_angle", { topic_id: topic.id });

    expect(res.ok).toBe(true);
    const saved = await getTopic(topic.id, testDir);
    expect(saved).not.toHaveProperty("selectedAngle");
  });
});

// ─── 单一简报快照（P1 spec §3.0）──────────────────────────────────────────────

describe("两个入口都只认 job.briefRevision 指针", () => {
  /** 生效的是 v1，磁盘上另躺一份从未被采纳的 v2（重跑落了盘却没结算成） */
  async function seedOrphanV2(): Promise<{ topic: Topic; orphanCard: AngleCard }> {
    const topic = await seed();
    const orphanCard: AngleCard = { ...CARD, id: "angle-9", thesis: "只有孤儿 v2 才有的论点" };
    await saveBrief(topic.id, makeBrief({ revision: 2, angleCards: [orphanCard] }), testDir);
    return { topic, orphanCard };
  }

  it("聊天闸口：念的是 v1 的候选，卡片也标 v1——不是磁盘最大版", async () => {
    const { topic } = await seedOrphanV2();
    const t = tools();

    const out = JSON.parse(await run(t, { topic: TITLE, platform: "douyin", topic_id: topic.id }));

    expect(out.cards.map((c: { id: string }) => c.id)).toEqual(["angle-1", "angle-2"]);
    expect(t.sink[0].data).toMatchObject({ topicId: topic.id, revision: 1 });
  });

  it("聊天闸口：v2 才有的 angle_id 选不了；v1 的选得了并落 briefRevision 1", async () => {
    const { topic, orphanCard } = await seedOrphanV2();

    const bad = JSON.parse(
      await run(tools(), { topic: TITLE, platform: "douyin", topic_id: topic.id, angle_id: orphanCard.id }),
    );
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("v1");

    const ok = JSON.parse(
      await run(tools(), { topic: TITLE, platform: "douyin", topic_id: topic.id, angle_id: "angle-2" }),
    );
    expect(ok).toMatchObject({ ok: true, pending: true });
    expect((await getTopic(topic.id, testDir))?.selectedAngle).toMatchObject({ briefRevision: 1, angleId: "angle-2" });
  });

  it("选卡 IPC：brief_revision 比对的是指针版 v1——报 2 反而被拒", async () => {
    const { topic } = await seedOrphanV2();
    const call = (payload: Record<string, unknown>) =>
      buildIpcHandlers()["topic:select_angle"]({ ...payload, _dataDir: testDir });

    const stale = await call({ topic_id: topic.id, brief_revision: 2, angle_id: "angle-1" });
    expect(stale.ok).toBe(false);
    expect(String(stale.error)).toContain("当前 v1");

    const ok = await call({ topic_id: topic.id, brief_revision: 1, angle_id: "angle-1" });
    expect(ok.ok).toBe(true);
    expect((await getTopic(topic.id, testDir))?.selectedAngle).toMatchObject({ briefRevision: 1, card: CARD });
  });

  it("有简报文件但台账没指针 → 两个入口都当「没有简报」", async () => {
    const topic = await saveTopic({ title: TITLE, description: DESC, tags: [] }, testDir);
    await saveBrief(topic.id, makeBrief(), testDir);

    // 闸口：没有候选就没有闸口，直接放行开写
    const t = tools();
    const out = JSON.parse(await run(t, { topic: TITLE, platform: "douyin", topic_id: topic.id }));
    expect(out).toMatchObject({ ok: true, pending: true });
    expect(t.sink).toHaveLength(0);

    // 选卡 IPC：人话拒绝，不拿盘上那份顶上
    const res = await buildIpcHandlers()["topic:select_angle"]({
      topic_id: topic.id, brief_revision: 1, angle_id: "angle-1", _dataDir: testDir,
    });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("还没有可用简报");
  });
});
