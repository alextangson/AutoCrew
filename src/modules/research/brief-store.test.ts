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
  evidenceByRef,
  evidenceRefId,
  loadBrief,
  loadLatestBrief,
  nextBriefRevision,
  saveBrief,
  tensionByRef,
  tensionRefId,
  isAngleCardV3,
  type AngleCard,
  type AngleCardV3,
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

// ─── 角度卡（角度卡 spec §1.3）───────────────────────────────────────────────
//
// 这一组守的是 2026-08-24 的裁决：angleCards 是**全可选新字段，schemaVersion 保持 1**。
// 升版本 = 读侧把存量简报全部当「无简报」，那是拿几百份既有材料换一个字段名分——
// 所以「旧简报照常读得出来」这条必须有机器验证，不能靠记性。

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

describe("角度卡随简报落盘", () => {
  it("带 angleCards 落盘 → 原样读回（schemaVersion 仍是 1）", async () => {
    await saveBrief(TOPIC, makeBrief({ angleCards: [CARD, { ...CARD, id: "angle-2" }] }), dataDir);

    const loaded = await loadLatestBrief(TOPIC, dataDir);
    expect(loaded?.schemaVersion).toBe(1);
    expect(loaded?.angleCards).toEqual([CARD, { ...CARD, id: "angle-2" }]);
  });

  it("旧简报（没有 angleCards 字段）照常读出来，字段缺席即缺席", async () => {
    await saveBrief(TOPIC, makeBrief({ revision: 1 }), dataDir);

    const loaded = await loadLatestBrief(TOPIC, dataDir);
    expect(loaded?.summary).toBe("四路指向一致：工具好用但维护成本被低估。");
    expect(loaded?.angleCards).toBeUndefined();
    expect(loaded).not.toHaveProperty("angleCards");
  });

  // ─── 卡 v3（P1 spec §3.1）：判别字段 cardVersion，schemaVersion 仍是 1 ──────
  const CARD_V3: AngleCardV3 = {
    cardVersion: 3,
    id: "angle-2",
    angle: "验收标准换一个",
    thesis: "该被考核的不是生成速度，而是改完之后谁能读懂",
    evidenceLevel: "grounded",
    coreEvidenceIds: ["ev-1"],
    antiScope: "不谈选型、不谈价格",
    hookDraft: "你们验收 AI 代码的那一条标准，可能正好是错的。",
    primaryPersona: "convert",
    misconception: "以为验收看的是速度",
    mechanism: "生成快省的是打字，读不懂付的是维护，所以验收要验可读性",
    payoff: "你会知道验收该验哪一条，今天就把它加进 checklist",
    nextAction: "在验收清单里加一条「谁能读懂」",
    counterResponse: "有人会说读不懂就重写——重写的成本正是这条要防的",
    personaGains: { grow: "听懂验收在验什么", trust: "有可复用的清单", convert: "落地时少踩一次" },
    elements: ["新奇点", "美点"],
    firsthandAnchor: {
      kind: "brief_evidence",
      chunkId: "ev-1",
      excerptHash: "0123456789abcdef",
      quote: "62% 的开发者每天使用",
    },
    evidenceNeeds: ["验收清单的公开范例", "读不懂导致重写的案例"],
    structure: "single-point",
    score: 5,
    scoreReasons: ["元素 2", "有简报证据（grounded）", "第一手锚点校验通过"],
  };

  it("v2 与 v3 卡混在一份简报里 → 原样读回，schemaVersion 仍是 1", async () => {
    await saveBrief(TOPIC, makeBrief({ angleCards: [CARD, CARD_V3] }), dataDir);

    const loaded = await loadLatestBrief(TOPIC, dataDir);
    expect(loaded?.schemaVersion).toBe(1);
    expect(loaded?.angleCards).toEqual([CARD, CARD_V3]);
    expect(isAngleCardV3(loaded!.angleCards![0])).toBe(false);
    expect(isAngleCardV3(loaded!.angleCards![1])).toBe(true);
    // 判别只认 cardVersion：v2 卡没有这个字段，读回来也不许被补上
    expect(loaded!.angleCards![0]).not.toHaveProperty("cardVersion");
  });

  it("ownMaterialRefs 是新增可选字段：给了原样读回，不给就缺席", async () => {
    await saveBrief(TOPIC, makeBrief({ ownMaterialRefs: [{ id: "om:c1:video:3:0", excerptHash: "abc123" }] }), dataDir);
    const loaded = await loadLatestBrief(TOPIC, dataDir);
    expect(loaded?.ownMaterialRefs).toEqual([{ id: "om:c1:video:3:0", excerptHash: "abc123" }]);
    expect(loaded?.schemaVersion).toBe(1);
  });

  it("angleCards 不是数组 → 按「无简报」降级并告警（读侧全按数组遍历）", async () => {
    const broken = { ...makeBrief(), angleCards: "两张卡" };
    await fs.mkdir(briefsDir(dataDir), { recursive: true });
    await fs.writeFile(briefPath(TOPIC, 1, dataDir), JSON.stringify(broken), "utf-8");

    const warns: string[] = [];
    expect(await loadBrief(TOPIC, 1, dataDir, (m) => warns.push(m))).toBeNull();
    expect(warns.join("")).toContain("字段残缺");
  });

  it("证据/张力点按位置解引用：越界、格式不对、非字符串一律 null", () => {
    const brief = makeBrief({ tensions: ["张力甲", "张力乙"] });
    expect(evidenceRefId(0)).toBe("ev-1");
    expect(tensionRefId(1)).toBe("tension-2");
    expect(evidenceByRef(brief.evidence, "ev-1")?.claim).toBe("使用率高");
    expect(tensionByRef(brief.tensions, "tension-2")).toBe("张力乙");

    for (const bad of ["ev-0", "ev-2", "ev-x", "1", "", "tension-1", null, 3]) {
      expect(evidenceByRef(brief.evidence, bad)).toBeNull();
    }
    expect(tensionByRef(brief.tensions, "tension-3")).toBeNull();
  });
});
