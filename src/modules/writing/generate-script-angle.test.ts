/**
 * generate-script-angle.test.ts — 生效角度的解析与注入（角度卡 spec §1.3/§1.5/§1.6）。
 *
 * 骨架同 generate-script-brief.test.ts（全 mock、零网络）。这里验四件事：
 * 1. 优先级：手写 direction > 选中角度卡 > 无；
 * 2. 过期即无选择：简报重跑过、或选题文本改过，选中的卡一律不生效并留痕；
 * 3. 未经点选的稿子自己说出来：版本注记「未经角度点选」+ warn；
 * 4. 生效的卡同时进写稿 prompt 与审稿材料——写稿定了论点，审稿就按论点验收。
 *
 * 卡上的文字都是夹具写死的确定值；没有一条断言落在 LLM 生成的文本上。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateScript } from "./generate-script.js";
import { BRIEF_SCHEMA_VERSION, saveBrief, type AngleCard, type ResearchBrief } from "../research/brief-store.js";
import {
  pendingPerspectives,
  topicHashOf,
  upsertJob,
  type ResearchJob,
} from "../research/research-job-store.js";
import { getContent, saveTopic, updateTopic, type Topic } from "../../storage/local-store.js";
import type { LoopResult, LoopOptions } from "../../engine/loop.js";
import type { EngineConfig } from "../../engine/config.js";

let testDir: string;

const ENV_KEYS = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-genscript-angle-"));
  await fs.writeFile(
    path.join(testDir, "engine.json"),
    JSON.stringify({ apiKey: "sk-test", strongModel: "m-strong", fastModel: "m-fast" }),
  );
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const GOOD_PAYLOAD = {
  title: "AI 编程助手值不值",
  hook: "厂商说提效一半，实测只有一成",
  body: "把两组数字摆在一起看，差距出在任务类型上",
  cta: "关注我，下周拆解实测方法",
  hashtags: ["#AI编程"],
};

const TOPIC_TITLE = "AI 编程助手横评";
const TOPIC_DESC = "对比 5 个主流工具的真实提效";
const TEST_REQ = { topic: TOPIC_TITLE, platform: "douyin" as const };

const CARD: AngleCard = {
  id: "angle-1",
  angle: "算一笔维护账",
  thesis: "省下的编码时间被维护成本吃回去了，净收益接近于零",
  coreEvidenceIds: ["ev-1"],
  antiScope: "不写工具横评、不写怎么写 prompt",
  audiencePain: "老板拿提效数字压 KPI，自己却在给 AI 擦屁股",
  holdTrigger: "看到自己上周那笔返工账被算了出来",
  hookDraft: "提效 55% 是真的，只是账没算完。",
};
const CARD_2: AngleCard = { ...CARD, id: "angle-2", thesis: "翻车集中在重构类任务", antiScope: "不做成本测算" };

/** 写稿轮与审稿轮各捕获一次入参：注入面在写稿轮，材料面在审稿轮 */
interface Seen {
  write?: LoopOptions;
  review?: LoopOptions;
}

function capturingLoop(seen: Seen) {
  return async (_cfg: EngineConfig, opts: LoopOptions): Promise<LoopResult> => {
    const submit = (opts.tools ?? []).find((t) => t.name === "submit_script");
    if (!submit) {
      seen.review = opts; // 审稿轮：替身不出手，按「未经 AI 审稿」降级
      return { finalMessage: "", turns: 1, totalTokens: 0, toolCallCount: 0, stopReason: "no_tool_calls" };
    }
    seen.write = opts;
    await submit.execute(GOOD_PAYLOAD);
    return { finalMessage: "ok", turns: 2, totalTokens: 100, toolCallCount: 1, stopReason: "no_tool_calls" };
  };
}

function makeBrief(over: Partial<ResearchBrief> = {}): ResearchBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    summary: "厂商口径与独立评测差了四倍。",
    perspectives: [],
    tensions: ["厂商宣称提效 55%，独立评测只测到 12%"],
    angleSuggestions: ["算一笔维护账"],
    angleCards: [CARD, CARD_2],
    evidence: [
      {
        claim: "独立评测的提效幅度远低于厂商口径",
        quote: "在受控实验中，参与者平均完成时间缩短约 12%。",
        sourceUrl: "https://www.example.com/study/1",
      },
    ],
    assetPicks: [],
    missingPerspectives: [],
    gaps: [],
    generatedAt: "2026-08-24T10:00:00.000Z",
    revision: 1,
    topicHash: topicHashOf(TOPIC_TITLE, TOPIC_DESC),
    ...over,
  };
}

/** 选题 + 简报 + 指向它的 job（写稿时简报块与角度卡都该生效） */
async function seedResearched(brief = makeBrief()): Promise<Topic> {
  const topic = await saveTopic({ title: TOPIC_TITLE, description: TOPIC_DESC, tags: [] }, testDir);
  await saveBrief(topic.id, brief, testDir);
  const job: ResearchJob = {
    topicId: topic.id,
    status: "succeeded",
    startedAt: "2026-08-24T09:00:00.000Z",
    settledAt: "2026-08-24T10:00:00.000Z",
    perspectives: pendingPerspectives(),
    briefRevision: brief.revision,
    topicHash: topicHashOf(TOPIC_TITLE, TOPIC_DESC),
  };
  await upsertJob(job, testDir);
  return topic;
}

async function pick(topicId: string, card: AngleCard, briefRevision = 1): Promise<void> {
  await updateTopic(
    topicId,
    { selectedAngle: { briefRevision, angleId: card.id, card, selectedAt: "2026-08-24T11:00:00.000Z" } },
    testDir,
  );
}

async function write(
  req: Parameters<typeof generateScript>[0],
  warns: string[] = [],
): Promise<{ seen: Seen; contentId: string; note?: string }> {
  const seen: Seen = {};
  const res = await generateScript(req, testDir, {
    runLoopImpl: capturingLoop(seen),
    onWarn: (m) => warns.push(m),
  });
  const saved = await getContent(res.contentId, testDir);
  return { seen, contentId: res.contentId, note: saved?.versions?.at(-1)?.note };
}

// ─── 优先级（§1.3）────────────────────────────────────────────────────────────

describe("生效角度的优先级：direction > 选中卡 > 无", () => {
  it("选了卡 → 卡进 prompt；审稿材料也拿到同一张卡", async () => {
    const topic = await seedResearched();
    await pick(topic.id, CARD_2);

    const { seen } = await write({ ...TEST_REQ, topicId: topic.id });

    expect(seen.write!.userMessage).toContain("【本稿切入点");
    expect(seen.write!.userMessage).toContain(CARD_2.thesis);
    expect(seen.review!.userMessage).toContain(CARD_2.thesis);
    expect(seen.review!.userMessage).toContain(CARD_2.antiScope);
    // 审稿判据随之加严：定了论点就按论点验收
    expect(seen.review!.systemPrompt).toContain("thesis 没被论证");
  });

  it("手写 direction 压过选中的卡：卡的字一个都不注入，也不算「未经点选」", async () => {
    const topic = await seedResearched();
    await pick(topic.id, CARD);

    const { seen, note } = await write({
      ...TEST_REQ,
      topicId: topic.id,
      direction: "从被裁掉的初级程序员视角写",
    });

    expect(seen.write!.userMessage).toContain("从被裁掉的初级程序员视角写");
    expect(seen.write!.userMessage).not.toContain(CARD.thesis);
    expect(note).toBe("AI 完成初稿");
  });

  it("有候选卡但没选 → prompt 里没有切入点块，版本注记标「未经角度点选」并 warn", async () => {
    const topic = await seedResearched();
    const warns: string[] = [];

    const { seen, note } = await write({ ...TEST_REQ, topicId: topic.id }, warns);

    expect(seen.write!.userMessage).not.toContain("【本稿切入点");
    expect(note).toBe("AI 完成初稿（未经角度点选）");
    expect(warns.some((w) => w.includes("未经角度点选开写"))).toBe(true);
  });

  it("简报没有角度卡（旧简报 / 无证据降级）→ 不算绕闸口，注记与改动前一字不差", async () => {
    const topic = await seedResearched(makeBrief({ angleCards: undefined }));

    const { seen, note } = await write({ ...TEST_REQ, topicId: topic.id });

    expect(seen.write!.userMessage).not.toContain("【本稿切入点");
    expect(note).toBe("AI 完成初稿");
  });

  it("压根没有 topicId（随手写一篇）→ 角度链整条不参与", async () => {
    const { seen, note } = await write(TEST_REQ);
    expect(seen.write!.userMessage).not.toContain("【本稿切入点");
    expect(note).toBe("AI 完成初稿");
  });
});

// ─── 过期即无选择（§1.3）──────────────────────────────────────────────────────

describe("选择过期", () => {
  it("简报重跑过（选的是 v1，最新是 v2）→ 按没选处理并留痕", async () => {
    const topic = await seedResearched();
    await pick(topic.id, CARD, 1);
    await saveBrief(topic.id, makeBrief({ revision: 2, generatedAt: "2026-08-24T12:00:00.000Z" }), testDir);
    const warns: string[] = [];

    const { seen, note } = await write({ ...TEST_REQ, topicId: topic.id }, warns);

    expect(seen.write!.userMessage).not.toContain(CARD.thesis);
    expect(note).toBe("AI 完成初稿（未经角度点选）");
    expect(warns.some((w) => w.includes("选中的角度已过期"))).toBe(true);
  });

  it("选题文本被改过（简报 topicHash 对不上）→ 同样按没选处理", async () => {
    const topic = await seedResearched();
    await pick(topic.id, CARD);
    await updateTopic(topic.id, { title: "改了标题的同一条选题" }, testDir);
    const warns: string[] = [];

    const { seen } = await write({ ...TEST_REQ, topicId: topic.id }, warns);

    expect(seen.write!.userMessage).not.toContain(CARD.thesis);
    expect(warns.some((w) => w.includes("选中的角度已过期"))).toBe(true);
  });

  it("选题被删（简报还在）→ 不注入角度，不炸", async () => {
    const topic = await seedResearched();
    await pick(topic.id, CARD);
    await fs.rm(path.join(testDir, "topics", `${topic.id}.json`), { force: true });

    const { seen, note } = await write({ ...TEST_REQ, topicId: topic.id });

    expect(seen.write!.userMessage).not.toContain(CARD.thesis);
    expect(note).toBe("AI 完成初稿（未经角度点选）");
  });
});

// ─── 跳过留痕（§1.6）──────────────────────────────────────────────────────────

describe("显式跳过", () => {
  it("angleSkipReason 落 run-log（原话可回溯），但一个字都不进 prompt", async () => {
    const topic = await seedResearched();
    const warns: string[] = [];

    const { seen, note } = await write(
      { ...TEST_REQ, topicId: topic.id, angleSkipReason: "用户说：别选角度了，直接写" },
      warns,
    );

    expect(warns.some((w) => w.includes("用户明说跳过角度点选") && w.includes("直接写"))).toBe(true);
    expect(seen.write!.userMessage).not.toContain("别选角度了");
    // 跳过是显式动作，但这稿确实没经过角度闸口——注记照实说
    expect(note).toBe("AI 完成初稿（未经角度点选）");
  });

  it("既没带上简报也没点角度 → 两条注记并列出现，不互相覆盖", async () => {
    const topic = await seedResearched();
    const seen: Seen = {};

    // 闸口跑不了 = 这稿没等到本轮新简报（wroteWithoutBrief）；盘上那份旧简报的角度卡照样没选
    const res = await generateScript({ ...TEST_REQ, topicId: topic.id }, testDir, {
      runLoopImpl: capturingLoop(seen),
      onWarn: () => {},
      ensureBriefImpl: async () => ({ state: "unavailable", note: "搜索 key 没配" }),
    });

    const saved = await getContent(res.contentId, testDir);
    expect(saved?.versions?.at(-1)?.note).toBe("AI 完成初稿（未带调研简报、未经角度点选）");
    expect(res.wroteWithoutBrief).toBe(true);
    expect(res.wroteWithoutAngle).toBe(true);
  });
});
