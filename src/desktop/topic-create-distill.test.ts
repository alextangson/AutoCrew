/**
 * `topic:create` 的碎片灵感提炼分支:长手动输入才提炼，提炼失败照原文落库并带 warning，
 * 短输入/非 manual 来源零行为变化（提炼函数一次都不该被调）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { topicCreateHandler } from "./ipc.js";
import type { DistilledIdea } from "../modules/radar/idea-distill.js";
import type { Topic } from "../storage/local-store.js";

let dataDir: string;

const LONG_IDEA =
  "我最近让 Claude Code 把公司的排班系统从头重写了一遍，两周就上线了，中间踩了不少坑，比如数据迁移和权限模型，感觉可以写一篇。";
const IDEA: DistilledIdea = {
  title: "我用 Claude Code 两周重写了排班系统",
  summary: "把老排班系统交给 AI 重写的完整过程与坑。",
  angles: ["数据迁移", "权限模型", "成本账"],
  scoreBreakdown: { audienceFit: 28, materialRichness: 20, novelty: 22, timeliness: 15 },
  totalScore: 85,
};

/** 记录提炼是否被调用 + 调用时拿到的原文 */
function fakeDistill(idea: DistilledIdea | null, calls: string[]) {
  return async (rawText: string): Promise<DistilledIdea | null> => {
    calls.push(rawText);
    return idea;
  };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-topic-distill-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("topicCreateHandler + 碎片灵感提炼", () => {
  it("长手动输入:提炼成功 → 标题换成提炼结果,原文留在 description,分数入库", async () => {
    const calls: string[] = [];
    const r = await topicCreateHandler({ title: LONG_IDEA, _dataDir: dataDir }, undefined, { distill: fakeDistill(IDEA, calls) });

    expect(calls).toEqual([LONG_IDEA]);
    expect(r.ok).toBe(true);
    expect(r.distilled).toBe(true);
    const topic = r.topic as Topic;
    expect(topic.title).toBe(IDEA.title);
    // 提炼摘要在前给卡片当可读正文,灵感原文永远完整保留为材料
    expect(topic.description).toContain(IDEA.summary);
    expect(topic.description).toContain(LONG_IDEA);
    expect(topic.description!.indexOf(IDEA.summary)).toBeLessThan(topic.description!.indexOf(LONG_IDEA));
    expect(topic.source).toBe("manual");
    expect(topic.score).toBe(85);
    expect(topic.scoreBreakdown).toEqual(IDEA.scoreBreakdown);
    expect(topic.angles).toEqual(IDEA.angles);
    expect(typeof topic.scoredAt).toBe("string");
    expect(topic.originalTitle).toBeUndefined(); // 那是海外原始英文标题的语义,别污染
  });

  it("用户自带 description 时原文拼接在后,两份都不丢", async () => {
    const r = await topicCreateHandler(
      { title: LONG_IDEA, description: "来自播客的笔记", _dataDir: dataDir },
      undefined,
      { distill: fakeDistill(IDEA, []) },
    );
    const topic = r.topic as Topic;
    expect(topic.description).toContain("来自播客的笔记");
    expect(topic.description).toContain(LONG_IDEA);
  });

  it("提炼返回 null → 照原文落库 + warning,绝不静默丢灵感", async () => {
    const r = await topicCreateHandler({ title: LONG_IDEA, _dataDir: dataDir }, undefined, { distill: fakeDistill(null, []) });

    expect(r.ok).toBe(true);
    expect(r.distilled).toBe(false);
    expect(typeof r.warning).toBe("string");
    expect((r.warning as string).length).toBeGreaterThan(0);
    const topic = r.topic as Topic;
    expect(topic.title).toBe(LONG_IDEA);
    expect(topic.score).toBeUndefined();
  });

  it("提炼抛错 → 同样照原文落库 + warning", async () => {
    const distill = async (): Promise<DistilledIdea | null> => {
      throw new Error("relay 502");
    };
    const r = await topicCreateHandler({ title: LONG_IDEA, _dataDir: dataDir }, undefined, { distill });

    expect(r.ok).toBe(true);
    expect(r.distilled).toBe(false);
    expect((r.topic as Topic).title).toBe(LONG_IDEA);
  });

  it("≤30 字短输入:不调提炼,返回保持现状（无 distilled 字段）", async () => {
    const calls: string[] = [];
    const short = "Claude Code 的 10 个隐藏用法"; // 22 码点
    expect([...short].length).toBeLessThanOrEqual(30);
    const r = await topicCreateHandler({ title: short, reason: "后台好多人在问", _dataDir: dataDir }, undefined, {
      distill: fakeDistill(IDEA, calls),
    });

    expect(calls).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.distilled).toBeUndefined();
    const topic = r.topic as Topic;
    expect(topic.title).toBe(short);
    expect(topic.description).toBe(short);
    expect(topic.reason).toBe("后台好多人在问");
  });

  it("非 manual 来源（雷达/收件箱）:再长也不提炼", async () => {
    const calls: string[] = [];
    const r = await topicCreateHandler({ title: LONG_IDEA, source: "radar:HN", _dataDir: dataDir }, undefined, {
      distill: fakeDistill(IDEA, calls),
    });

    expect(calls).toEqual([]);
    expect(r.distilled).toBeUndefined();
    expect((r.topic as Topic).title).toBe(LONG_IDEA);
    expect((r.topic as Topic).source).toBe("radar:HN");
  });

  it("空标题仍然直接拒绝", async () => {
    const r = await topicCreateHandler({ title: "   ", _dataDir: dataDir }, undefined, { distill: fakeDistill(IDEA, []) });
    expect(r.ok).toBe(false);
  });
});
