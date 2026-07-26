/**
 * brief-store.test.ts — 简报存储（深调研 §5）：不可变版本 / 原子发布 / 坏文件可见降级。
 *
 * 被断言的都是确定性层：版本号分配、文件内容、损坏时的返回值与告警——没有 LLM 参与。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BRIEF_SCHEMA_VERSION,
  BriefExistsError,
  briefPath,
  briefsDir,
  loadBrief,
  loadLatestBrief,
  nextBriefRevision,
  saveBrief,
  type ResearchBrief,
} from "./brief-store.js";

let dataDir: string;
const TOPIC = "topic-abc123";

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-brief-store-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function makeBrief(over: Partial<ResearchBrief> = {}): ResearchBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    summary: "四路指向一致：工具好用但维护成本被低估。",
    perspectives: [
      {
        name: "audience",
        insights: [
          { text: "独立开发者关心的是维护账", sourceIds: ["p1"] },
          { text: "新手更在意上手速度", sourceIds: ["s1"] },
        ],
        evidence: [],
        assetPicks: [],
        gaps: [],
      },
    ],
    tensions: [],
    angleSuggestions: ["算一笔维护账", "从翻车案例倒推"],
    evidence: [{ claim: "使用率高", quote: "62% 的开发者每天使用", sourceUrl: "https://example.com/a" }],
    assetPicks: [],
    missingPerspectives: [],
    gaps: [],
    generatedAt: "2026-07-26T08:00:00.000Z",
    revision: 1,
    topicHash: "hash-1",
    ...over,
  };
}

describe("版本分配", () => {
  it("空目录首版为 1，之后按磁盘上的最大版本 +1", async () => {
    expect(await nextBriefRevision(TOPIC, dataDir)).toBe(1);

    await saveBrief(TOPIC, makeBrief({ revision: 1 }), dataDir);
    expect(await nextBriefRevision(TOPIC, dataDir)).toBe(2);

    await saveBrief(TOPIC, makeBrief({ revision: 2 }), dataDir);
    expect(await nextBriefRevision(TOPIC, dataDir)).toBe(3);
  });

  it("版本号按数值比大小，不是字符串（v10 > v9）", async () => {
    await saveBrief(TOPIC, makeBrief({ revision: 9 }), dataDir);
    await saveBrief(TOPIC, makeBrief({ revision: 10 }), dataDir);
    expect(await nextBriefRevision(TOPIC, dataDir)).toBe(11);
    expect((await loadLatestBrief(TOPIC, dataDir))?.revision).toBe(10);
  });

  it("别的选题的简报不参与本选题的版本分配", async () => {
    await saveBrief("topic-other", makeBrief({ revision: 7 }), dataDir);
    expect(await nextBriefRevision(TOPIC, dataDir)).toBe(1);
  });

  it("非法选题 id 直接拒绝（它会变成路径片段）", async () => {
    await expect(nextBriefRevision("../../etc", dataDir)).rejects.toThrow(/非法选题 id/);
  });
});

describe("不可变版本", () => {
  it("同版本重复写 → 抛 BriefExistsError，磁盘上仍是第一份", async () => {
    await saveBrief(TOPIC, makeBrief({ summary: "第一版" }), dataDir);
    await expect(saveBrief(TOPIC, makeBrief({ summary: "偷偷改写" }), dataDir)).rejects.toBeInstanceOf(
      BriefExistsError,
    );
    expect((await loadBrief(TOPIC, 1, dataDir))?.summary).toBe("第一版");
  });

  it("写完不留 tmp 残渣，目录里只有正式版本文件", async () => {
    await saveBrief(TOPIC, makeBrief({ revision: 1 }), dataDir);
    await saveBrief(TOPIC, makeBrief({ revision: 2 }), dataDir);
    const names = await fs.readdir(briefsDir(dataDir));
    expect(names.sort()).toEqual([`${TOPIC}.v1.json`, `${TOPIC}.v2.json`]);
  });

  it("重跑出 v2 后 v1 逐字不变", async () => {
    await saveBrief(TOPIC, makeBrief({ revision: 1, summary: "v1 的判断" }), dataDir);
    const v1Raw = await fs.readFile(briefPath(TOPIC, 1, dataDir), "utf-8");

    await saveBrief(TOPIC, makeBrief({ revision: 2, summary: "v2 的判断" }), dataDir);

    expect(await fs.readFile(briefPath(TOPIC, 1, dataDir), "utf-8")).toBe(v1Raw);
    expect((await loadBrief(TOPIC, 1, dataDir))?.summary).toBe("v1 的判断");
    expect((await loadLatestBrief(TOPIC, dataDir))?.summary).toBe("v2 的判断");
  });
});

describe("读侧降级", () => {
  it("没有简报 → null，且不告警（正常空态）", async () => {
    const warns: string[] = [];
    expect(await loadLatestBrief(TOPIC, dataDir, (m) => warns.push(m))).toBeNull();
    expect(await loadBrief(TOPIC, 3, dataDir, (m) => warns.push(m))).toBeNull();
    expect(warns).toEqual([]);
  });

  it("坏 JSON → null + onWarn 可见，不抛", async () => {
    await fs.mkdir(briefsDir(dataDir), { recursive: true });
    await fs.writeFile(briefPath(TOPIC, 1, dataDir), "{ 半条 JSON", "utf-8");

    const warns: string[] = [];
    expect(await loadLatestBrief(TOPIC, dataDir, (m) => warns.push(m))).toBeNull();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(`${TOPIC}.v1.json`);
  });

  it("未知 schemaVersion → null + onWarn（不猜字段语义）", async () => {
    await fs.mkdir(briefsDir(dataDir), { recursive: true });
    await fs.writeFile(
      briefPath(TOPIC, 1, dataDir),
      JSON.stringify({ ...makeBrief(), schemaVersion: 99 }),
      "utf-8",
    );

    const warns: string[] = [];
    expect(await loadBrief(TOPIC, 1, dataDir, (m) => warns.push(m))).toBeNull();
    expect(warns[0]).toContain("schemaVersion");
  });

  it("字段残缺 → null + onWarn", async () => {
    await fs.mkdir(briefsDir(dataDir), { recursive: true });
    await fs.writeFile(
      briefPath(TOPIC, 1, dataDir),
      JSON.stringify({ schemaVersion: BRIEF_SCHEMA_VERSION, summary: "只有摘要" }),
      "utf-8",
    );

    const warns: string[] = [];
    expect(await loadBrief(TOPIC, 1, dataDir, (m) => warns.push(m))).toBeNull();
    expect(warns[0]).toContain("残缺");
  });

  it("最新一版损坏时不回落旧版：坏了就是没有（旧版仍可按 revision 精确读出）", async () => {
    await saveBrief(TOPIC, makeBrief({ revision: 1, summary: "好的 v1" }), dataDir);
    await fs.writeFile(briefPath(TOPIC, 2, dataDir), "坏文件", "utf-8");

    const warns: string[] = [];
    expect(await loadLatestBrief(TOPIC, dataDir, (m) => warns.push(m))).toBeNull();
    expect(warns).toHaveLength(1);
    expect((await loadBrief(TOPIC, 1, dataDir))?.summary).toBe("好的 v1");
  });

  it("目录里的杂物不冒充版本（tmp 残留 / 别的后缀）", async () => {
    await saveBrief(TOPIC, makeBrief({ revision: 1 }), dataDir);
    await fs.writeFile(path.join(briefsDir(dataDir), `${TOPIC}.v2.json.tmp-1`), "x", "utf-8");
    await fs.writeFile(path.join(briefsDir(dataDir), `${TOPIC}.vX.json`), "x", "utf-8");

    expect(await nextBriefRevision(TOPIC, dataDir)).toBe(2);
    expect((await loadLatestBrief(TOPIC, dataDir))?.revision).toBe(1);
  });
});
