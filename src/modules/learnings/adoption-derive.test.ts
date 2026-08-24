/**
 * adoption-derive.test.ts — 隐式采纳判定（发布时刻按改动量自动判一次）
 *
 * 全确定性层：相似度是纯函数，落库走临时 dataDir 的真实 local-store，无 LLM、无网络。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { bigramSimilarity, deriveAdoptionVerdict, deriveAndRecordAdoption } from "./adoption-derive.js";
import { saveContent, updateContent, recordAdoption, getContent } from "../../storage/local-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-adoption-derive-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const AI_BODY =
  "创业者找我聊的时候,十有八九第一句话是问该买哪个课。我的答案从来只有一个:先别买,把你上周真实卡住的那个问题写下来,再回来找我。";

describe("bigramSimilarity", () => {
  it("完全相同 → 1；毫无重叠 → 0", () => {
    expect(bigramSimilarity(AI_BODY, AI_BODY)).toBe(1);
    expect(bigramSimilarity("阿波次德鹅", "腹给哈鸡卡")).toBe(0);
  });

  it("空白差异不算改动", () => {
    expect(bigramSimilarity("第一句话。 第二句话。", "第一句话。\n\n第二句话。")).toBe(1);
  });

  it("不足 2 字符的一边：相等回 1，否则 0", () => {
    expect(bigramSimilarity("好", "好")).toBe(1);
    expect(bigramSimilarity("好", "坏")).toBe(0);
    expect(bigramSimilarity("", "")).toBe(1);
    expect(bigramSimilarity("", AI_BODY)).toBe(0);
  });

  it("小改的相似度明显高于整篇重写", () => {
    const lightEdit = AI_BODY.replace("十有八九", "十次里有九次");
    const rewritten = "今天讲三个工具:第一个用来做会议纪要,第二个批量改图,第三个把网页转成播客。都免费。";
    expect(bigramSimilarity(AI_BODY, lightEdit)).toBeGreaterThan(bigramSimilarity(AI_BODY, rewritten));
  });
});

describe("deriveAdoptionVerdict", () => {
  it("一字未改 → adopted（空白归一后相等也算）", () => {
    expect(deriveAdoptionVerdict(AI_BODY, AI_BODY)).toBe("adopted");
    // 段落之间换行变空格、首尾多出空白：不是改稿
    expect(deriveAdoptionVerdict("第一段。 第二段。", "  第一段。\n\n第二段。\n")).toBe("adopted");
  });

  it("小修小补 → light_edit", () => {
    const edited = AI_BODY.replace("十有八九", "十次里有九次").replace("先别买", "先别急着买");
    expect(deriveAdoptionVerdict(AI_BODY, edited)).toBe("light_edit");
  });

  it("整篇换掉 → rewritten", () => {
    const rewritten = "今天讲三个工具:第一个用来做会议纪要,第二个批量改图,第三个把网页转成播客。都免费,链接放评论区。";
    expect(deriveAdoptionVerdict(AI_BODY, rewritten)).toBe("rewritten");
  });

  it("空串边界：两边都空 → adopted；基线空而成稿非空 → rewritten", () => {
    expect(deriveAdoptionVerdict("", "")).toBe("adopted");
    expect(deriveAdoptionVerdict("", AI_BODY)).toBe("rewritten");
  });
});

/**
 * 时间戳全部钉死在远过去：真实流程里占位→成稿差分钟级，测试若靠壁钟只差毫秒，
 * 全量并发跑时事件循环挤压会让两个时间戳挤成同一刻，最近邻基线就锚错（曾真实翻车）。
 * 钉在 2020 年也保证测试中后续真实落盘的人改版本（now=今天）永远离稿成时刻最远。
 */
const READY_AT = "2020-01-01T00:00:00.000Z";
const PLACEHOLDER_AT = "2019-12-31T23:55:00.000Z";
const AI_SAVED_AT = "2020-01-01T00:00:00.010Z";

/** 造一篇「占位稿 v1 → AI 成稿 v2（盖 draftReadyAt）」的稿件，与 generate-script 的落盘顺序一致 */
async function mkGeneratedDraft(aiBody = AI_BODY) {
  const placeholder = await saveContent(
    { title: "占位", body: "正在生成…", platform: "wechat_mp", status: "drafting", tags: [] },
    testDir,
  );
  const updated = await updateContent(
    placeholder.id,
    { title: "AI 标题", body: aiBody, status: "draft_ready", draftReadyAt: READY_AT },
    testDir,
  );
  const metaPath = path.join(testDir, "contents", updated!.id, "meta.json");
  const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
  meta.versions[0].savedAt = PLACEHOLDER_AT;
  meta.versions[1].savedAt = AI_SAVED_AT;
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  return (await getContent(updated!.id, testDir))!;
}

describe("deriveAndRecordAdoption", () => {
  it("draftReadyAt 锚定基线：占位稿 v1 不参与比较，人手小改判 light_edit", async () => {
    const draft = await mkGeneratedDraft();
    const edited = AI_BODY.replace("十有八九", "十次里有九次");
    await updateContent(draft.id, { body: edited }, testDir);

    const record = await deriveAndRecordAdoption(draft.id, testDir);
    expect(record?.verdict).toBe("light_edit");
    expect(record?.derived).toBe(true);

    const saved = await getContent(draft.id, testDir);
    expect(saved?.adoption?.verdict).toBe("light_edit");
    expect(saved?.adoption?.derived).toBe(true);
    expect(saved?.adoption?.recordedAt).toBeTruthy();
  });

  it("AI 成稿原样发出去 → adopted（占位稿 v1 若当基线会误判成 rewritten）", async () => {
    const draft = await mkGeneratedDraft();
    const record = await deriveAndRecordAdoption(draft.id, testDir);
    expect(record?.verdict).toBe("adopted");
  });

  it("只判一次：第二次调用回 null，判定不被新改动冲掉", async () => {
    const draft = await mkGeneratedDraft();
    const first = await deriveAndRecordAdoption(draft.id, testDir);
    expect(first?.verdict).toBe("adopted");

    await updateContent(draft.id, { body: "发布后又整篇重写了一遍,内容完全不同的另一篇稿子。" }, testDir);
    expect(await deriveAndRecordAdoption(draft.id, testDir)).toBeNull();
    expect((await getContent(draft.id, testDir))?.adoption?.verdict).toBe("adopted");
  });

  it("已有手动裁决 → 不覆盖，也不补 derived 标记", async () => {
    const draft = await mkGeneratedDraft();
    await recordAdoption(draft.id, "rewritten", testDir);

    expect(await deriveAndRecordAdoption(draft.id, testDir)).toBeNull();
    const saved = await getContent(draft.id, testDir);
    expect(saved?.adoption?.verdict).toBe("rewritten");
    expect(saved?.adoption?.derived).toBeUndefined();
  });

  it("旧稿无 draftReadyAt → 回落 v1 当基线（已知偏严边界）", async () => {
    const legacy = await saveContent(
      { title: "老稿", body: AI_BODY, platform: "wechat_mp", status: "draft_ready", tags: [] },
      testDir,
    );
    await updateContent(legacy.id, { body: AI_BODY.replace("十有八九", "十次里有九次") }, testDir);

    const record = await deriveAndRecordAdoption(legacy.id, testDir);
    expect(record?.verdict).toBe("light_edit");
  });

  it("稿件不存在 → null，不抛", async () => {
    expect(await deriveAndRecordAdoption("content-nope", testDir)).toBeNull();
  });
});
