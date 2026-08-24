/**
 * 调研回流轮测试。两块：
 * 1. **回报文案**（纯函数）：四形态逐字锁死——它是总编辑读到的全部事实，
 *    少一块（比如没说缺哪个视角、没摆角度卡）他就只能含糊其辞。
 *    只断言我们自己拼的确定文案，模型说什么不在这里管。
 * 2. **回流轮编排**：会话忙时等 settle、会话已删就放弃、一个任务只回报一次、
 *    自己失败了留痕不重试。runTurn 全程打桩——这一层测的是纪律，不是模型。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  FOLLOWUP_PREFIX,
  buildFollowupMessage,
  resetFollowupState,
  runResearchFollowup,
  type FollowupReport,
} from "./chat-followup.js";
import type { runPersistedChatTurn } from "./chat-persist.js";
import { createConversation } from "../storage/conversation-store.js";
import { saveTopic } from "../storage/local-store.js";
import { readRecentEvents } from "./event-hub.js";
import { saveBrief, type AngleCard, type ResearchBrief } from "../modules/research/brief-store.js";
import {
  getJob,
  pendingPerspectives,
  topicHashOf,
  upsertJob,
  type ResearchJob,
} from "../modules/research/research-job-store.js";

let dir: string;

beforeEach(async () => {
  resetFollowupState();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-followup-"));
});

afterEach(async () => {
  resetFollowupState();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const card = (over: Partial<AngleCard> = {}): AngleCard => ({
  id: "angle-1",
  angle: "从工具链换代看这波裁员",
  thesis: "裁的不是人，是上一代工作流",
  coreEvidenceIds: ["ev-1"],
  antiScope: "不写宏观经济周期",
  audiencePain: "怕自己就是下一个",
  holdTrigger: "第三段给自查清单",
  hookDraft: "上周他还在开需求会",
  ...over,
});

const report = (over: Partial<FollowupReport> = {}): FollowupReport => ({
  topicTitle: "AI 编程助手横评",
  failed: false,
  briefRevision: 2,
  missingPerspectives: [],
  summary: "五个工具跑下来，差距在补全上下文长度",
  angleCards: [card()],
  gaps: [],
  ...over,
});

describe("buildFollowupMessage（回报文案四形态）", () => {
  it("成功：暗号开头 + 版本号 + 摘要 + 逐张角度卡（id/切入点/论点/禁区）", () => {
    const msg = buildFollowupMessage(report({ angleCards: [card(), card({ id: "angle-2", angle: "从招聘端看" })] }));
    expect(msg.startsWith(FOLLOWUP_PREFIX)).toBe(true);
    expect(msg).toContain("选题《AI 编程助手横评》深度调研完成(第 2 版简报)。");
    expect(msg).toContain("摘要:五个工具跑下来，差距在补全上下文长度");
    expect(msg).toContain("角度候选(2 张):");
    expect(msg).toContain("- angle-1 · 从工具链换代看这波裁员｜论点:裁的不是人，是上一代工作流｜不写:不写宏观经济周期");
    expect(msg).toContain("- angle-2 · 从招聘端看");
    expect(msg).not.toContain("缺"); // 视角全成时不提缺
  });

  it("partial：点名缺了哪个视角（中文标签，不是 counter 这种内部名）", () => {
    const msg = buildFollowupMessage(report({ missingPerspectives: ["counter", "benchmark"] }));
    expect(msg).toContain("(第 2 版简报,缺反方、对标视角)");
  });

  it("没出角度卡：把简报里的原因说出来，不假装无事发生", () => {
    const msg = buildFollowupMessage(
      report({ angleCards: [], gaps: ["配额耗尽", "本轮没挑出可引用的证据，未产出角度卡——请手写一句角度"] }),
    );
    expect(msg).toContain("角度候选:这轮没出角度卡——本轮没挑出可引用的证据，未产出角度卡——请手写一句角度");
    expect(msg).not.toContain("配额耗尽"); // 无关缺口不往回报里灌
  });

  it("没出角度卡且简报没写原因：说清「没写原因」，不留空", () => {
    const msg = buildFollowupMessage(report({ angleCards: [], gaps: [] }));
    expect(msg).toContain("角度候选:这轮没出角度卡——简报里没写原因,去选题卡看这份简报");
  });

  it("失败：带错误原文，不粉饰", () => {
    const msg = buildFollowupMessage(report({ failed: true, failReason: "搜索配额耗尽(quota)" }));
    expect(msg).toBe(`${FOLLOWUP_PREFIX}选题《AI 编程助手横评》调研失败:搜索配额耗尽(quota)`);
  });
});

// ─── 编排 ────────────────────────────────────────────────────────────────────

const brief = (over: Partial<ResearchBrief> = {}): ResearchBrief => ({
  schemaVersion: 1,
  summary: "简报摘要",
  perspectives: [],
  tensions: [],
  angleSuggestions: [],
  angleCards: [card()],
  evidence: [{ claim: "c", quote: "q", sourceUrl: "https://example.com" }],
  assetPicks: [],
  missingPerspectives: [],
  gaps: [],
  generatedAt: "2026-08-24T09:00:00.000Z",
  revision: 1,
  topicHash: topicHashOf("标题", "描述"),
  ...over,
});

/** 落一个「已完成、来源会话已回填」的任务，并把简报也写好 */
async function settledJob(over: Partial<ResearchJob> = {}, briefOver: Partial<ResearchBrief> = {}): Promise<ResearchJob> {
  const topic = await saveTopic({ title: "AI 编程助手横评", description: "对比 5 个主流工具", tags: [] }, dir);
  const job: ResearchJob = {
    topicId: topic.id,
    status: "succeeded",
    startedAt: "2026-08-24T08:00:00.000Z",
    settledAt: "2026-08-24T09:00:00.000Z",
    perspectives: pendingPerspectives(),
    topicHash: topicHashOf(topic.title, topic.description),
    briefRevision: 1,
    ...over,
  };
  await upsertJob(job, dir);
  if (job.status !== "failed") await saveBrief(topic.id, brief(briefOver), dir);
  return job;
}

/** 打桩的一轮对话：记下收到什么，回一个成功 */
function stubTurn() {
  return vi.fn(async () => ({ ok: true, data: { reply: "看了简报", conversationId: "x" } })) as unknown as
    typeof runPersistedChatTurn;
}

describe("runResearchFollowup", () => {
  it("正常路径：以系统身份跑一轮、盖已回报戳、把落点报给 SSE 出口", async () => {
    const conv = await createConversation("派活那段", dir);
    const job = await settledJob({ originConversationId: conv.id });
    const runTurn = stubTurn();
    const delivered: Array<{ conversationId: string; topicId: string }> = [];

    const outcome = await runResearchFollowup(job, {
      dataDir: dir,
      runTurn,
      isBusy: () => false,
      onDelivered: (e) => delivered.push(e),
    });

    expect(outcome).toBe("delivered");
    const call = (runTurn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(call.conversationId).toBe(conv.id);
    expect(call.origin).toBe("system");
    expect(String(call.message)).toContain(FOLLOWUP_PREFIX);
    expect(String(call.message)).toContain("AI 编程助手横评");
    expect(delivered).toEqual([{ conversationId: conv.id, topicId: job.topicId }]);
    expect((await getJob(job.topicId, dir))?.followupAt).toBeTruthy();
  });

  it("一个任务只回报一次：followupAt 已盖的再触发直接跳过", async () => {
    const conv = await createConversation("派活那段", dir);
    const job = await settledJob({ originConversationId: conv.id });
    const runTurn = stubTurn();

    await runResearchFollowup(job, { dataDir: dir, runTurn, isBusy: () => false });
    const after = (await getJob(job.topicId, dir))!;
    const again = await runResearchFollowup(after, { dataDir: dir, runTurn, isBusy: () => false });

    expect(again).toBe("skipped");
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("没有来源会话（面板按钮/写稿闸口派的）：一句话都不发", async () => {
    const job = await settledJob();
    const runTurn = stubTurn();
    expect(await runResearchFollowup(job, { dataDir: dir, runTurn, isBusy: () => false })).toBe("skipped");
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("会话已删：静默放弃，不复活回收站里的对话", async () => {
    const job = await settledJob({ originConversationId: "conv-1-gone" });
    const runTurn = stubTurn();
    expect(await runResearchFollowup(job, { dataDir: dir, runTurn, isBusy: () => false })).toBe("skipped");
    expect(runTurn).not.toHaveBeenCalled();
    expect((await getJob(job.topicId, dir))?.followupAt).toBeUndefined();
  });

  it("会话正忙：等它 settle 再插话（不打断用户那一轮）", async () => {
    const conv = await createConversation("正在聊", dir);
    const job = await settledJob({ originConversationId: conv.id });
    const runTurn = stubTurn();
    let busyPolls = 0;

    const outcome = await runResearchFollowup(job, {
      dataDir: dir,
      runTurn,
      isBusy: () => ++busyPolls <= 3, // 前三次问都在忙，第四次空了
      sleep: async () => undefined,
    });

    expect(outcome).toBe("delivered");
    expect(busyPolls).toBe(4);
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("会话一直忙到上限：放弃并留痕，不硬插进去（简报仍在选题卡上）", async () => {
    const conv = await createConversation("一直在聊", dir);
    const job = await settledJob({ originConversationId: conv.id });
    const runTurn = stubTurn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let clock = 0;

    const outcome = await runResearchFollowup(job, {
      dataDir: dir,
      runTurn,
      isBusy: () => true,
      sleep: async () => undefined,
      now: () => (clock += 60_000), // 每问一次推进一分钟，十分钟必到头
    });

    expect(outcome).toBe("skipped");
    expect(runTurn).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain("放弃回报");
    warn.mockRestore();
  });

  it("失败的调研也回报，正文带错误原文", async () => {
    const conv = await createConversation("派活那段", dir);
    const job = await settledJob({
      originConversationId: conv.id,
      status: "failed",
      failReason: "四视角全军覆没：搜索 provider 502",
      briefRevision: undefined,
    });
    const runTurn = stubTurn();

    expect(await runResearchFollowup(job, { dataDir: dir, runTurn, isBusy: () => false })).toBe("delivered");
    const call = (runTurn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(String(call.message)).toContain("调研失败:四视角全军覆没：搜索 provider 502");
  });

  it("状态是成功但简报读不出来：照实说是「读不出来」，不发一条空回报", async () => {
    const conv = await createConversation("派活那段", dir);
    const topic = await saveTopic({ title: "没简报的选题", description: "d", tags: [] }, dir);
    const job: ResearchJob = {
      topicId: topic.id,
      status: "succeeded",
      startedAt: "2026-08-24T08:00:00.000Z",
      perspectives: pendingPerspectives(),
      topicHash: topicHashOf(topic.title, topic.description),
      originConversationId: conv.id,
    };
    await upsertJob(job, dir);
    const runTurn = stubTurn();

    await runResearchFollowup(job, { dataDir: dir, runTurn, isBusy: () => false });
    const call = (runTurn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(String(call.message)).toContain("简报读不出来");
  });

  it("回流轮自己失败：warn + 工作日志留痕，不重试、不盖已回报戳", async () => {
    const conv = await createConversation("派活那段", dir);
    const job = await settledJob({ originConversationId: conv.id });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runTurn = vi.fn(async () => ({ ok: false, error: "relay 断流" })) as unknown as typeof runPersistedChatTurn;

    const outcome = await runResearchFollowup(job, { dataDir: dir, runTurn, isBusy: () => false });

    expect(outcome).toBe("failed");
    expect(runTurn).toHaveBeenCalledTimes(1); // 不重试
    expect((await getJob(job.topicId, dir))?.followupAt).toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).toContain("relay 断流");
    warn.mockRestore();

    const labels = (await readRecentEvents(dir)).map((e) => e.label);
    expect(labels.some((l) => l.includes("调研回报没发出去"))).toBe(true);
  });

  it("同一任务并发触发：只跑一轮（进程内在途集合兜底）", async () => {
    const conv = await createConversation("派活那段", dir);
    const job = await settledJob({ originConversationId: conv.id });
    let calls = 0;
    const runTurn = vi.fn(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, data: {} };
    }) as unknown as typeof runPersistedChatTurn;

    const outcomes = await Promise.all([
      runResearchFollowup(job, { dataDir: dir, runTurn, isBusy: () => false }),
      runResearchFollowup(job, { dataDir: dir, runTurn, isBusy: () => false }),
    ]);

    expect(calls).toBe(1);
    expect(outcomes.filter((o) => o === "delivered")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "skipped")).toHaveLength(1);
  });
});
