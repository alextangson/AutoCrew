# 闭环骨架（Flywheel Skeleton）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建成 draft↔outcome 带标签数据集的 schema + 回填 verify + CSV 历史导入 + 打标工具——PRD v3 §3 钦定的"护城河本体、第一公民交付物"，同时补齐 §11 第 0 步 dogfood 缺的唯一一块代码。

**Architecture:** 新建 `src/modules/flywheel/`（outcome schema / append-only journal 存储 / CSV 导入），作为表现数据的唯一写入路径（single source of truth）；`quality-baseline` 改为从 outcome store 读取（legacy `profile.performanceHistory` 作为空库 fallback）；新工具 `autocrew_flywheel` 注册进 OpenClaw 插件宿主（index.ts），供创始人 dogfood 使用。落 PRD §5 三条约束：append-only journal、幂等键、verify 后入库。

**Tech Stack:** TypeScript (ESM, `.js` import suffix), vitest, @sinclair/typebox（工具 schema），零新依赖（CSV 解析自写 ~40 行）。

**计划序列上下文（v1 共多份计划，本份是第 1 份）：**
1. **闭环骨架（本计划）**——不依赖任何未决 spike，产出 dogfood 立即可用的软件
2. 引擎 spike（并行，见 `2026-06-10-engine-spike.md`，决策型计划非 TDD）
3. 赛道包抽取（口播 playbook → 声明式包）← 依赖无
4. 薄 loop 引擎 + 进程内生成 ← 依赖 spike 裁决
5. 浏览器扩展通道 / LLM 风格建模 / 桌面壳 ← 后续

---

## File Structure

| 文件 | 职责 |
|---|---|
| Create `src/modules/flywheel/outcome-schema.ts` | PerformanceOutcome 类型、verify 规则（值域/日期/异常）、幂等键、标题归一化、口播 reward 配置 |
| Create `src/modules/flywheel/outcome-schema.test.ts` | schema 与 verify 规则测试 |
| Create `src/modules/flywheel/outcome-store.ts` | append-only JSONL journal（`<dataDir>/outcomes.jsonl`）、幂等 recordOutcome、latest-wins 读取、draft 双因子匹配 |
| Create `src/modules/flywheel/outcome-store.test.ts` | 存储幂等性、暴涨检测、匹配测试 |
| Create `src/modules/flywheel/csv-import.ts` | CSV 解析（BOM/引号/CRLF）、中文数字格式解析（`1.2万`/`12.3%`）、三平台列名映射配置、导入编排 |
| Create `src/modules/flywheel/csv-import.test.ts` | 解析器与端到端导入测试 |
| Create `src/tools/flywheel.ts` | `autocrew_flywheel` 工具（import_csv / record / report） |
| Create `src/tools/flywheel.test.ts` | 工具 execute 函数测试 |
| Modify `src/modules/analytics/quality-baseline.ts:123-142,285-301` | buildBaseline 改读 outcome store；trackPerformance 写穿 recordOutcome |
| Modify `index.ts:22-23,~98` | 注册新工具 |
| Create `docs/dogfood-runbook.md` | 创始人每周 dogfood 操作手册 + 列名映射校准说明 |

**设计决定（已锁定，不要在执行中重开）：**
- outcome store 是表现数据**唯一写入路径**；`creator-profile.performanceHistory` 降级为只读 legacy fallback（不删，老数据不丢）。
- 幂等键 = `platform : (contentId 或 归一化标题+发布日期) : metricDate`。同键后写覆盖先写（更新鲜的同日快照）。
- 历史回灌的条目允许 `contentId: null`（AutoCrew 诞生前的作品）——进 baseline 的 avgMetrics，不进 traits 分析。
- verify 不过 = 拒收（硬错误）；可疑（播放 0 但有互动 / 播放量暴涨）= 收下但 `needsReview: true`，工具 report 里列出转人工。
- 平台 CSV 列名映射是**数据不是代码**：默认映射按已知后台字段名写，创始人 dogfood 第一次导入时按真实导出文件校准（改配置数组，见 runbook）。

---

### Task 1: Outcome Schema 与 verify 规则

**Files:**
- Create: `src/modules/flywheel/outcome-schema.ts`
- Test: `src/modules/flywheel/outcome-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/flywheel/outcome-schema.test.ts
import { describe, it, expect } from "vitest";
import {
  validateOutcome,
  outcomeKey,
  normalizeTitle,
  KOUBO_REWARD,
  type OutcomeMetrics,
} from "./outcome-schema.js";

describe("normalizeTitle", () => {
  it("strips punctuation, whitespace and lowercases", () => {
    expect(normalizeTitle("5个护肤技巧，让你皮肤变好！")).toBe("5个护肤技巧让你皮肤变好");
    expect(normalizeTitle("  AI Agent 入门 (2026) ")).toBe("aiagent入门2026");
  });
  it("strips emoji", () => {
    expect(normalizeTitle("🔥爆款标题🔥")).toBe("爆款标题");
  });
});

describe("validateOutcome", () => {
  const base = {
    metrics: { views: 1000, completionRate: 35.2 } as OutcomeMetrics,
    publishedAt: "2026-06-01T10:00:00.000Z",
    metricDate: "2026-06-08",
  };

  it("accepts valid outcome", () => {
    const v = validateOutcome(base);
    expect(v.ok).toBe(true);
    expect(v.needsReview).toBe(false);
  });

  it("rejects completionRate outside 0-100", () => {
    const v = validateOutcome({ ...base, metrics: { completionRate: 135 } });
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toContain("完播率");
  });

  it("rejects negative metrics", () => {
    const v = validateOutcome({ ...base, metrics: { views: -5 } });
    expect(v.ok).toBe(false);
  });

  it("rejects metricDate earlier than publishedAt", () => {
    const v = validateOutcome({ ...base, metricDate: "2026-05-20" });
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toContain("早于发布");
  });

  it("rejects empty metrics", () => {
    const v = validateOutcome({ ...base, metrics: {} });
    expect(v.ok).toBe(false);
  });

  it("flags zero views with engagement as needsReview, not rejection", () => {
    const v = validateOutcome({ ...base, metrics: { views: 0, likes: 30 } });
    expect(v.ok).toBe(true);
    expect(v.needsReview).toBe(true);
    expect(v.reasons.join()).toContain("播放为 0");
  });

  it("accepts null publishedAt (historical import without publish time)", () => {
    const v = validateOutcome({ ...base, publishedAt: null });
    expect(v.ok).toBe(true);
  });
});

describe("outcomeKey", () => {
  it("uses contentId when present", () => {
    const key = outcomeKey({
      contentId: "c123",
      platform: "douyin",
      platformTitle: "标题A",
      publishedAt: "2026-06-01T10:00:00.000Z",
      metricDate: "2026-06-08",
    });
    expect(key).toBe("douyin:c123:2026-06-08");
  });

  it("falls back to normalized title + publish date for historical items", () => {
    const key = outcomeKey({
      contentId: null,
      platform: "douyin",
      platformTitle: "5个护肤技巧！",
      publishedAt: "2026-06-01T10:00:00.000Z",
      metricDate: "2026-06-08",
    });
    expect(key).toBe("douyin:5个护肤技巧@2026-06-01:2026-06-08");
  });

  it("same content same metricDate yields same key (idempotency basis)", () => {
    const a = { contentId: "c1", platform: "douyin", platformTitle: "x", publishedAt: null, metricDate: "2026-06-08" };
    expect(outcomeKey(a)).toBe(outcomeKey({ ...a }));
  });
});

describe("KOUBO_REWARD", () => {
  it("primary signal is completion rate (口播赛道)", () => {
    expect(KOUBO_REWARD.primary).toBe("completionRate");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/flywheel/outcome-schema.test.ts`
Expected: FAIL — `Cannot find module './outcome-schema.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/modules/flywheel/outcome-schema.ts
/**
 * Outcome Schema — draft↔outcome 带标签数据集的核心 schema（PRD v3 §3 第一公民交付物）。
 *
 * 一条 PerformanceOutcome = 某平台上某条作品在某个数据日期的表现快照。
 * verify 规则（PRD §6）：值域/日期校验不过 = 拒收；可疑值收下但标 needsReview 转人工。
 */

export interface OutcomeMetrics {
  views?: number;
  /** 完播率，百分比 0-100 */
  completionRate?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  favorites?: number;
  follows?: number;
}

export type OutcomeSource = "csv" | "paste" | "auto";

export interface PerformanceOutcome {
  /** AutoCrew content id；历史回灌（AutoCrew 诞生前的作品）为 null */
  contentId: string | null;
  platform: string;
  /** 平台上显示的标题（匹配与审计用） */
  platformTitle: string;
  /** 平台发布时间 ISO；历史导入可能缺失 */
  publishedAt: string | null;
  /** 本快照对应的数据日期 YYYY-MM-DD */
  metricDate: string;
  metrics: OutcomeMetrics;
  source: OutcomeSource;
  recordedAt: string;
  needsReview: boolean;
  reviewReasons: string[];
}

export interface OutcomeValidation {
  /** false = 拒收 */
  ok: boolean;
  needsReview: boolean;
  reasons: string[];
}

/** 口播赛道 reward signal（赛道包抽取后改从包读，接口保持此形状） */
export const KOUBO_REWARD = {
  primary: "completionRate",
  secondary: ["favorites", "follows"],
} as const;

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, "");
}

export function validateOutcome(input: {
  metrics: OutcomeMetrics;
  publishedAt: string | null;
  metricDate: string;
}): OutcomeValidation {
  const reasons: string[] = [];
  const m = input.metrics;
  const values = Object.values(m).filter((v): v is number => typeof v === "number");

  if (values.length === 0) {
    return { ok: false, needsReview: false, reasons: ["没有任何指标值"] };
  }
  if (values.some((v) => v < 0)) {
    reasons.push("存在负数指标");
  }
  if (m.completionRate !== undefined && (m.completionRate < 0 || m.completionRate > 100)) {
    reasons.push(`完播率 ${m.completionRate} 超出 0-100`);
  }
  if (input.publishedAt) {
    const pubDate = input.publishedAt.slice(0, 10);
    if (input.metricDate < pubDate) {
      reasons.push(`数据日期 ${input.metricDate} 早于发布日期 ${pubDate}`);
    }
  }
  if (reasons.length > 0) {
    return { ok: false, needsReview: false, reasons };
  }

  // 可疑但不拒收 → needsReview 转人工
  const review: string[] = [];
  const engagement = (m.likes || 0) + (m.comments || 0) + (m.shares || 0) + (m.favorites || 0);
  if (m.views === 0 && engagement > 0) {
    review.push("播放为 0 但有互动，疑似读错字段");
  }
  return { ok: true, needsReview: review.length > 0, reasons: review };
}

/** 幂等键：platform : (contentId 或 归一化标题@发布日期) : metricDate */
export function outcomeKey(o: {
  contentId: string | null;
  platform: string;
  platformTitle: string;
  publishedAt: string | null;
  metricDate: string;
}): string {
  const item = o.contentId
    ? o.contentId
    : `${normalizeTitle(o.platformTitle)}@${o.publishedAt ? o.publishedAt.slice(0, 10) : "unknown"}`;
  return `${o.platform}:${item}:${o.metricDate}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/flywheel/outcome-schema.test.ts`
Expected: PASS（13 tests）

- [ ] **Step 5: Commit**

```bash
git add src/modules/flywheel/outcome-schema.ts src/modules/flywheel/outcome-schema.test.ts
git commit -m "feat: outcome schema + verify rules — moat dataset first-class citizen (PRD v3 §3)"
```

---

### Task 2: Outcome Store — append-only journal + 幂等写入

**Files:**
- Create: `src/modules/flywheel/outcome-store.ts`
- Test: `src/modules/flywheel/outcome-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/flywheel/outcome-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordOutcome, listOutcomes, getOutcomesForContent } from "./outcome-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-flywheel-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

const baseInput = {
  contentId: "c1",
  platform: "douyin",
  platformTitle: "5个护肤技巧",
  publishedAt: "2026-06-01T10:00:00.000Z",
  metricDate: "2026-06-08",
  metrics: { views: 1000, completionRate: 35 },
  source: "csv" as const,
};

describe("recordOutcome", () => {
  it("records a valid outcome", async () => {
    const r = await recordOutcome(baseInput, testDir);
    expect(r.ok).toBe(true);
    expect(r.replaced).toBe(false);
    const all = await listOutcomes(testDir);
    expect(all).toHaveLength(1);
    expect(all[0].contentId).toBe("c1");
    expect(all[0].recordedAt).toBeTruthy();
  });

  it("rejects invalid outcome (completionRate > 100)", async () => {
    const r = await recordOutcome({ ...baseInput, metrics: { completionRate: 200 } }, testDir);
    expect(r.ok).toBe(false);
    expect(await listOutcomes(testDir)).toHaveLength(0);
  });

  it("is idempotent: same key overwrites, latest wins", async () => {
    await recordOutcome(baseInput, testDir);
    const r2 = await recordOutcome(
      { ...baseInput, metrics: { views: 1500, completionRate: 36 } },
      testDir,
    );
    expect(r2.replaced).toBe(true);
    const all = await listOutcomes(testDir);
    expect(all).toHaveLength(1);
    expect(all[0].metrics.views).toBe(1500);
  });

  it("different metricDate creates a new snapshot, not a replace", async () => {
    await recordOutcome(baseInput, testDir);
    await recordOutcome({ ...baseInput, metricDate: "2026-06-09" }, testDir);
    expect(await listOutcomes(testDir)).toHaveLength(2);
  });

  it("flags view-count spike vs platform median as needsReview", async () => {
    // 5 条普通数据建立中位数 ~1000
    for (let i = 0; i < 5; i++) {
      await recordOutcome(
        { ...baseInput, contentId: `c${i}`, metricDate: "2026-06-08", metrics: { views: 1000 + i } },
        testDir,
      );
    }
    const spike = await recordOutcome(
      { ...baseInput, contentId: "c-spike", metrics: { views: 100000 } },
      testDir,
    );
    expect(spike.ok).toBe(true);
    expect(spike.outcome?.needsReview).toBe(true);
    expect(spike.outcome?.reviewReasons.join()).toContain("中位数");
  });
});

describe("getOutcomesForContent", () => {
  it("returns only outcomes linked to the content id", async () => {
    await recordOutcome(baseInput, testDir);
    await recordOutcome({ ...baseInput, contentId: "c2", platformTitle: "另一篇" }, testDir);
    const got = await getOutcomesForContent("c1", testDir);
    expect(got).toHaveLength(1);
    expect(got[0].contentId).toBe("c1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/flywheel/outcome-store.test.ts`
Expected: FAIL — `Cannot find module './outcome-store.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/modules/flywheel/outcome-store.ts
/**
 * Outcome Store — append-only JSONL journal（PRD v3 §5 持久化约束：追加式、幂等、可冷启动重放）。
 *
 * 文件：<dataDir>/outcomes.jsonl，一行一条 PerformanceOutcome。
 * 幂等：同 outcomeKey 后写覆盖先写（读取时 latest-wins），journal 本身永不改写。
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  validateOutcome,
  outcomeKey,
  type PerformanceOutcome,
  type OutcomeMetrics,
  type OutcomeSource,
} from "./outcome-schema.js";

const OUTCOMES_FILE = "outcomes.jsonl";

function getDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

function outcomesPath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), OUTCOMES_FILE);
}

async function readJournal(dataDir?: string): Promise<PerformanceOutcome[]> {
  try {
    const raw = await fs.readFile(outcomesPath(dataDir), "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as PerformanceOutcome);
  } catch {
    return [];
  }
}

/** latest-wins：同幂等键只保留 journal 中最后一条 */
export async function listOutcomes(dataDir?: string): Promise<PerformanceOutcome[]> {
  const journal = await readJournal(dataDir);
  const byKey = new Map<string, PerformanceOutcome>();
  for (const o of journal) {
    byKey.set(outcomeKey(o), o);
  }
  return Array.from(byKey.values());
}

export async function getOutcomesForContent(
  contentId: string,
  dataDir?: string,
): Promise<PerformanceOutcome[]> {
  return (await listOutcomes(dataDir)).filter((o) => o.contentId === contentId);
}

export interface RecordResult {
  ok: boolean;
  outcome?: PerformanceOutcome;
  replaced: boolean;
  error?: string;
}

export async function recordOutcome(
  input: {
    contentId: string | null;
    platform: string;
    platformTitle: string;
    publishedAt: string | null;
    metricDate: string;
    metrics: OutcomeMetrics;
    source: OutcomeSource;
  },
  dataDir?: string,
): Promise<RecordResult> {
  const validation = validateOutcome(input);
  if (!validation.ok) {
    return { ok: false, replaced: false, error: validation.reasons.join("；") };
  }

  const existing = await listOutcomes(dataDir);
  const key = outcomeKey(input);
  const replaced = existing.some((o) => outcomeKey(o) === key);

  // 暴涨检测：同平台已有 ≥5 条数据时，views > 20 × 中位数 → needsReview
  const reviewReasons = [...validation.reasons];
  let needsReview = validation.needsReview;
  const peers = existing
    .filter((o) => o.platform === input.platform && typeof o.metrics.views === "number")
    .map((o) => o.metrics.views as number)
    .sort((a, b) => a - b);
  if (peers.length >= 5 && typeof input.metrics.views === "number") {
    const median = peers[Math.floor(peers.length / 2)];
    if (median > 0 && input.metrics.views > median * 20) {
      needsReview = true;
      reviewReasons.push(`播放量 ${input.metrics.views} 超过平台中位数 ${median} 的 20 倍，确认非读错字段`);
    }
  }

  const outcome: PerformanceOutcome = {
    ...input,
    recordedAt: new Date().toISOString(),
    needsReview,
    reviewReasons,
  };

  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(outcomesPath(dataDir), JSON.stringify(outcome) + "\n", "utf-8");
  return { ok: true, outcome, replaced };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/flywheel/outcome-store.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 5: Commit**

```bash
git add src/modules/flywheel/outcome-store.ts src/modules/flywheel/outcome-store.test.ts
git commit -m "feat: append-only outcome journal with idempotent writes and spike review"
```

---

### Task 3: Draft 双因子匹配（标题相似度 + 发布时间窗）

**Files:**
- Modify: `src/modules/flywheel/outcome-store.ts`（追加 matchDraft + diceSimilarity）
- Test: `src/modules/flywheel/outcome-store.test.ts`（追加 describe 块）

- [ ] **Step 1: Write the failing test（追加到 outcome-store.test.ts 末尾）**

```typescript
// 追加 import：
import { matchDraft, diceSimilarity } from "./outcome-store.js";
import { saveContent, updateContent } from "../../storage/local-store.js";

describe("diceSimilarity", () => {
  it("identical strings = 1", () => {
    expect(diceSimilarity("护肤技巧分享", "护肤技巧分享")).toBe(1);
  });
  it("unrelated strings ≈ 0", () => {
    expect(diceSimilarity("护肤技巧分享", "汽车保养指南")).toBeLessThan(0.2);
  });
  it("minor truncation stays high", () => {
    expect(diceSimilarity("5个护肤技巧让你皮肤变好", "5个护肤技巧让你皮肤变")).toBeGreaterThan(0.8);
  });
});

describe("matchDraft", () => {
  async function publishContent(title: string, publishedAt: string) {
    const c = await saveContent(
      { title, body: "正文", platform: "douyin", status: "published", tags: [] },
      testDir,
    );
    await updateContent(c.id, { publishedAt }, testDir);
    return c;
  }

  it("matches by exact normalized title", async () => {
    const c = await publishContent("5个护肤技巧！", "2026-06-01T10:00:00.000Z");
    const hit = await matchDraft("douyin", "5个护肤技巧", null, testDir);
    expect(hit?.id).toBe(c.id);
  });

  it("matches fuzzy title within 48h publish window", async () => {
    const c = await publishContent("5个护肤技巧让你皮肤变好", "2026-06-01T10:00:00.000Z");
    const hit = await matchDraft("douyin", "5个护肤技巧让你皮肤变好了", "2026-06-02T09:00:00.000Z", testDir);
    expect(hit?.id).toBe(c.id);
  });

  it("rejects fuzzy match outside 48h window", async () => {
    await publishContent("5个护肤技巧让你皮肤变好", "2026-06-01T10:00:00.000Z");
    const hit = await matchDraft("douyin", "5个护肤技巧让你皮肤变好了", "2026-06-20T09:00:00.000Z", testDir);
    expect(hit).toBeNull();
  });

  it("returns null for unknown title (historical item)", async () => {
    await publishContent("完全无关的标题", "2026-06-01T10:00:00.000Z");
    const hit = await matchDraft("douyin", "AutoCrew 诞生前的老视频", null, testDir);
    expect(hit).toBeNull();
  });

  it("does not match drafts of another platform", async () => {
    await publishContent("跨平台同标题", "2026-06-01T10:00:00.000Z");
    const hit = await matchDraft("xiaohongshu", "跨平台同标题", null, testDir);
    expect(hit).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/flywheel/outcome-store.test.ts`
Expected: FAIL — `matchDraft is not exported` / `diceSimilarity is not exported`

- [ ] **Step 3: Write the implementation（追加到 outcome-store.ts 末尾）**

```typescript
// 文件头追加 import：
import { listContents, type Content } from "../../storage/local-store.js";
import { normalizeTitle } from "./outcome-schema.js";

/** bigram Dice 系数，0-1 */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const set = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      set.set(bg, (set.get(bg) || 0) + 1);
    }
    return set;
  };
  const aB = bigrams(a);
  const bB = bigrams(b);
  let overlap = 0;
  for (const [bg, count] of aB) {
    overlap += Math.min(count, bB.get(bg) || 0);
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

const FUZZY_THRESHOLD = 0.6;
const STRICT_THRESHOLD = 0.8;
const TIME_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * draft↔outcome 双因子匹配（PRD §6 verify）：
 * 归一化标题精确命中 → 直接匹配；
 * 模糊命中（dice ≥ 0.6）→ 需发布时间窗 ±48h 佐证；双方任一缺发布时间则要求 dice ≥ 0.8。
 */
export async function matchDraft(
  platform: string,
  platformTitle: string,
  publishedAt: string | null,
  dataDir?: string,
): Promise<Content | null> {
  const contents = await listContents(dataDir);
  const candidates = contents.filter(
    (c) => c.status === "published" && c.platform === platform,
  );
  const target = normalizeTitle(platformTitle);

  let best: { content: Content; score: number } | null = null;
  for (const c of candidates) {
    const score = diceSimilarity(normalizeTitle(c.title), target);
    if (score === 1) return c;
    if (!best || score > best.score) best = { content: c, score };
  }
  if (!best || best.score < FUZZY_THRESHOLD) return null;

  const draftTime = best.content.publishedAt ? Date.parse(best.content.publishedAt) : null;
  const itemTime = publishedAt ? Date.parse(publishedAt) : null;
  if (draftTime !== null && itemTime !== null) {
    return Math.abs(draftTime - itemTime) <= TIME_WINDOW_MS ? best.content : null;
  }
  return best.score >= STRICT_THRESHOLD ? best.content : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/flywheel/outcome-store.test.ts`
Expected: PASS（15 tests）

- [ ] **Step 5: Commit**

```bash
git add src/modules/flywheel/outcome-store.ts src/modules/flywheel/outcome-store.test.ts
git commit -m "feat: two-factor draft matching — normalized title similarity + 48h publish window"
```

---

### Task 4: CSV 解析器 + 中文数字格式

**Files:**
- Create: `src/modules/flywheel/csv-import.ts`（本任务只写 parseCsv / parseMetricNumber）
- Test: `src/modules/flywheel/csv-import.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/flywheel/csv-import.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseCsv, parseMetricNumber } from "./csv-import.js";

describe("parseCsv", () => {
  it("parses headers and rows", () => {
    const rows = parseCsv("标题,播放量\n护肤技巧,1234\n汽车保养,5678");
    expect(rows).toHaveLength(2);
    expect(rows[0]["标题"]).toBe("护肤技巧");
    expect(rows[1]["播放量"]).toBe("5678");
  });

  it("strips UTF-8 BOM and handles CRLF", () => {
    const rows = parseCsv("﻿标题,播放量\r\n护肤技巧,1234\r\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]["标题"]).toBe("护肤技巧");
  });

  it("handles quoted fields containing commas", () => {
    const rows = parseCsv('标题,播放量\n"护肤，进阶版",1234');
    expect(rows[0]["标题"]).toBe("护肤，进阶版");
  });

  it("handles escaped quotes inside quoted fields", () => {
    const rows = parseCsv('标题,播放量\n"他说""真香""",99');
    expect(rows[0]["标题"]).toBe('他说"真香"');
  });

  it("skips blank lines", () => {
    const rows = parseCsv("标题,播放量\n护肤,1\n\n汽车,2\n");
    expect(rows).toHaveLength(2);
  });
});

describe("parseMetricNumber", () => {
  it("parses plain numbers and comma separators", () => {
    expect(parseMetricNumber("1234")).toBe(1234);
    expect(parseMetricNumber("1,234")).toBe(1234);
  });
  it("parses 万 and w suffix", () => {
    expect(parseMetricNumber("1.2万")).toBe(12000);
    expect(parseMetricNumber("3.4w")).toBe(34000);
  });
  it("parses percentage as plain number (completionRate semantics)", () => {
    expect(parseMetricNumber("12.3%")).toBe(12.3);
  });
  it("returns undefined for empty or non-numeric", () => {
    expect(parseMetricNumber("")).toBeUndefined();
    expect(parseMetricNumber("-")).toBeUndefined();
    expect(parseMetricNumber(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/flywheel/csv-import.test.ts`
Expected: FAIL — `Cannot find module './csv-import.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/modules/flywheel/csv-import.ts
/**
 * CSV 导入 — 三大平台创作者中心导出文件 → PerformanceOutcome。
 *
 * 列名映射是数据不是代码：PLATFORM_MAPPINGS 按已知后台字段名写默认值，
 * 首次 dogfood 用真实导出文件校准（见 docs/dogfood-runbook.md）。
 */

/** 极简 CSV 解析：BOM/CRLF/引号字段/转义引号。平台导出不含换行内嵌字段，不支持也不需要。 */
export function parseCsv(text: string): Record<string, string>[] {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];

  const parseLine = (line: string): string[] => {
    const fields: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    fields.push(cur);
    return fields.map((f) => f.trim());
  };

  const headers = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const fields = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = fields[i] ?? "";
    });
    return row;
  });
}

/** "1.2万"→12000, "3.4w"→34000, "12.3%"→12.3, "1,234"→1234, ""/"-"→undefined */
export function parseMetricNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim().replace(/,/g, "");
  if (!s || s === "-") return undefined;
  const wan = /^([\d.]+)\s*[万w]$/i.exec(s);
  if (wan) return Math.round(parseFloat(wan[1]) * 10000);
  const pct = /^([\d.]+)\s*%$/.exec(s);
  if (pct) return parseFloat(pct[1]);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/flywheel/csv-import.test.ts`
Expected: PASS（9 tests）

- [ ] **Step 5: Commit**

```bash
git add src/modules/flywheel/csv-import.ts src/modules/flywheel/csv-import.test.ts
git commit -m "feat: CSV parser handling BOM/quotes/CRLF and Chinese metric formats"
```

---

### Task 5: 平台列名映射 + 导入编排

**Files:**
- Modify: `src/modules/flywheel/csv-import.ts`（追加映射与 importPerformanceCsv；Step 0 加固 parseMetricNumber）
- Modify: `src/modules/flywheel/outcome-schema.ts`（Step 0：负数检查豁免 follows）
- Test: `src/modules/flywheel/csv-import.test.ts` + `src/modules/flywheel/outcome-schema.test.ts`

- [ ] **Step 0（评审新增，随本任务落地）：解析与校验加固**

(a) `parseMetricNumber` 防垃圾前缀——"1.2亿"→1.2、"2026-06-01 10:00"→2026 这类"貌似合理的错误数字"是全管线唯一能静默入库的坏数据路径。替换实现：

```typescript
/** "1.2万"→12000, "3.4w"→34000, "1.2亿"→120000000, "12.3%"→12.3, "1,234"→1234；非完整数字 token → undefined */
export function parseMetricNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim().replace(/,/g, "");
  if (!s || s === "-") return undefined;
  const yi = /^(-?\d+(?:\.\d+)?)\s*亿$/.exec(s);
  if (yi) return Math.round(parseFloat(yi[1]) * 100000000);
  const wan = /^(-?\d+(?:\.\d+)?)\s*[万w]$/i.exec(s);
  if (wan) return Math.round(parseFloat(wan[1]) * 10000);
  const pct = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (pct) return parseFloat(pct[1]);
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return undefined;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}
```

测试追加（csv-import.test.ts 的 parseMetricNumber describe）："1.2亿"→120000000；"1.2.3万"→undefined；"2026-06-01 10:00"→undefined；".万"→undefined；"0"→0；"-5"→-5。

(b) `validateOutcome`（outcome-schema.ts）：粉丝增量可合法为负（掉粉日），负数检查豁免 `follows`，把 `values.some((v) => v < 0)` 的检查改为：

```typescript
  const hasIllegalNegative = Object.entries(m).some(
    ([k, v]) => typeof v === "number" && v < 0 && k !== "follows",
  );
  if (hasIllegalNegative) {
    reasons.push("存在负数指标");
  }
```

测试追加（outcome-schema.test.ts）：`{follows: -12, views: 100}` → ok:true；`{views: -5}` 仍拒收。

(c) `validateOutcome` 增加小数比例完播率启发——0.325 这种原始比例值落在合法区间内但是 100 倍失真（主 reward signal），必须转人工。在 needsReview 段追加：

```typescript
  if (m.completionRate !== undefined && m.completionRate > 0 && m.completionRate < 1) {
    review.push(`完播率 ${m.completionRate} 低于 1%，确认导出值不是小数比例（如 0.325 = 32.5%）`);
  }
```

测试追加：`{views: 100, completionRate: 0.32}` → ok:true 且 needsReview:true。

- [ ] **Step 1: Write the failing test（追加到 csv-import.test.ts 末尾）**

```typescript
// 追加 import：
import { importPerformanceCsv, PLATFORM_MAPPINGS } from "./csv-import.js";
import { saveContent, updateContent } from "../../storage/local-store.js";
import { listOutcomes } from "./outcome-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-csv-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

const DOUYIN_CSV = `﻿作品名称,发布时间,播放量,完播率,点赞量,评论量,分享量,收藏量,粉丝增量
5个护肤技巧,2026-06-01 10:00,1.2万,32.5%,300,45,20,80,15
AutoCrew 之前的老视频,2025-12-01 09:00,5000,28%,100,10,5,30,3
坏数据行,2026-06-01 10:00,-,-,-,-,-,-,-`;

describe("importPerformanceCsv", () => {
  it("imports rows, matches drafts, marks historical, rejects empty", async () => {
    const c = await saveContent(
      { title: "5个护肤技巧", body: "正文", platform: "douyin", status: "published", tags: [] },
      testDir,
    );
    await updateContent(c.id, { publishedAt: "2026-06-01T10:30:00.000Z" }, testDir);

    const report = await importPerformanceCsv("douyin", DOUYIN_CSV, "2026-06-08", testDir);

    expect(report.total).toBe(3);
    expect(report.imported).toBe(2);
    expect(report.matched).toBe(1);
    expect(report.historical).toBe(1);
    expect(report.rejected).toHaveLength(1);

    const outcomes = await listOutcomes(testDir);
    expect(outcomes).toHaveLength(2);
    const matched = outcomes.find((o) => o.contentId === c.id);
    expect(matched?.metrics.views).toBe(12000);
    expect(matched?.metrics.completionRate).toBe(32.5);
    expect(matched?.metrics.follows).toBe(15);
    const historical = outcomes.find((o) => o.contentId === null);
    expect(historical?.platformTitle).toBe("AutoCrew 之前的老视频");
  });

  it("re-import of same file replaces instead of duplicating (idempotent)", async () => {
    await importPerformanceCsv("douyin", DOUYIN_CSV, "2026-06-08", testDir);
    const second = await importPerformanceCsv("douyin", DOUYIN_CSV, "2026-06-08", testDir);
    expect(second.replaced).toBe(2);
    expect(await listOutcomes(testDir)).toHaveLength(2);
  });

  it("errors on unknown platform", async () => {
    await expect(importPerformanceCsv("bilibili", DOUYIN_CSV, "2026-06-08", testDir)).rejects.toThrow(
      /没有.*映射/,
    );
  });
});

describe("PLATFORM_MAPPINGS", () => {
  it("covers the three v1 platforms", () => {
    expect(Object.keys(PLATFORM_MAPPINGS).sort()).toEqual(["douyin", "wechat_video", "xiaohongshu"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/flywheel/csv-import.test.ts`
Expected: FAIL — `importPerformanceCsv is not exported`

- [ ] **Step 3: Write the implementation（追加到 csv-import.ts 末尾）**

```typescript
// 文件头追加 import：
import { recordOutcome, matchDraft } from "./outcome-store.js";
import type { OutcomeMetrics, PerformanceOutcome } from "./outcome-schema.js";

/** 每个指标列出已知的列名别名；首个命中的别名生效。校准 = 编辑这里的数组。 */
export interface CsvColumnMapping {
  title: string[];
  publishedAt: string[];
  metricDate?: string[];
  views: string[];
  completionRate?: string[];
  likes?: string[];
  comments?: string[];
  shares?: string[];
  favorites?: string[];
  follows?: string[];
}

export const PLATFORM_MAPPINGS: Record<string, CsvColumnMapping> = {
  douyin: {
    title: ["作品名称", "作品标题", "标题"],
    publishedAt: ["发布时间"],
    metricDate: ["数据日期", "统计日期"],
    views: ["播放量", "播放次数"],
    completionRate: ["完播率"],
    likes: ["点赞量", "点赞数"],
    comments: ["评论量", "评论数"],
    shares: ["分享量", "转发量"],
    favorites: ["收藏量", "收藏数"],
    follows: ["粉丝增量", "涨粉量"],
  },
  wechat_video: {
    title: ["内容", "标题", "动态内容"],
    publishedAt: ["发布时间"],
    metricDate: ["数据日期", "统计日期"],
    views: ["播放量", "播放次数"],
    completionRate: ["完播率"],
    likes: ["喜欢数", "点赞数"],
    comments: ["评论数"],
    shares: ["分享数", "转发数"],
    favorites: ["收藏数"],
    follows: ["新增关注数", "净增关注"],
  },
  xiaohongshu: {
    title: ["笔记标题", "标题"],
    publishedAt: ["发布时间", "首次发布时间"],
    metricDate: ["数据日期", "统计日期"],
    views: ["观看量", "浏览量", "曝光量"],
    completionRate: ["完播率"],
    likes: ["点赞", "点赞数"],
    comments: ["评论", "评论数"],
    shares: ["分享", "分享数"],
    favorites: ["收藏", "收藏数"],
    follows: ["涨粉", "新增关注"],
  },
};

function pick(row: Record<string, string>, aliases: string[] | undefined): string | undefined {
  if (!aliases) return undefined;
  for (const a of aliases) {
    if (row[a] !== undefined && row[a] !== "") return row[a];
  }
  return undefined;
}

/** "2026-06-01 10:00" / "2026/6/1" → ISO；解析失败返回 null */
function parsePublishTime(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = Date.parse(raw.replace(/\//g, "-"));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** "2026/6/8"、"2026-06-08 12:00" → "2026-06-08"；缺失或解析失败用 defaultDate（schema 强制 YYYY-MM-DD）。
 *  不经 Date 往返——本地时区（Asia/Shanghai）会把 "2026-6-8" 偏成前一天（评审实证）。 */
function normalizeMetricDate(raw: string | undefined, defaultDate: string): string {
  if (!raw) return defaultDate;
  const d = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(raw.trim());
  if (!d) return defaultDate;
  return `${d[1]}-${d[2].padStart(2, "0")}-${d[3].padStart(2, "0")}`;
}

export interface ImportReport {
  total: number;
  imported: number;
  replaced: number;
  matched: number;
  historical: number;
  needsReview: PerformanceOutcome[];
  rejected: Array<{ row: number; title: string; error: string }>;
}

export async function importPerformanceCsv(
  platform: string,
  csvText: string,
  defaultMetricDate: string,
  dataDir?: string,
): Promise<ImportReport> {
  const mapping = PLATFORM_MAPPINGS[platform];
  if (!mapping) {
    throw new Error(`平台 ${platform} 没有 CSV 列名映射（已支持：${Object.keys(PLATFORM_MAPPINGS).join("/")}）`);
  }

  const rows = parseCsv(csvText);
  const report: ImportReport = {
    total: rows.length,
    imported: 0,
    replaced: 0,
    matched: 0,
    historical: 0,
    needsReview: [],
    rejected: [],
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const title = pick(row, mapping.title) || "(无标题)";
    const publishedAt = parsePublishTime(pick(row, mapping.publishedAt));
    const metricDate = normalizeMetricDate(pick(row, mapping.metricDate), defaultMetricDate);

    const metrics: OutcomeMetrics = {
      views: parseMetricNumber(pick(row, mapping.views)),
      completionRate: parseMetricNumber(pick(row, mapping.completionRate)),
      likes: parseMetricNumber(pick(row, mapping.likes)),
      comments: parseMetricNumber(pick(row, mapping.comments)),
      shares: parseMetricNumber(pick(row, mapping.shares)),
      favorites: parseMetricNumber(pick(row, mapping.favorites)),
      follows: parseMetricNumber(pick(row, mapping.follows)),
    };

    const draft = await matchDraft(platform, title, publishedAt, dataDir);
    const result = await recordOutcome(
      { contentId: draft?.id ?? null, platform, platformTitle: title, publishedAt, metricDate, metrics, source: "csv" },
      dataDir,
    );

    if (!result.ok) {
      report.rejected.push({ row: i + 2, title, error: result.error || "未知错误" });
      continue;
    }
    report.imported++;
    if (result.replaced) report.replaced++;
    if (draft) report.matched++;
    else report.historical++;
    if (result.outcome?.needsReview) report.needsReview.push(result.outcome);
  }

  return report;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/flywheel/csv-import.test.ts`
Expected: PASS

- [ ] **Step 5: 对账（评审新增）——confirm_published 后重导入不得双计**

问题：某行首次导入时未匹配（historical，title 键），之后该稿 confirm_published，再次导入同一 CSV 会以 contentId 键写入新条目——两个键并存，listOutcomes 双计同一平台条目。

修改 `src/modules/flywheel/outcome-store.ts` 的 `listOutcomes`，latest-wins 去重后丢弃"已有同 title 键打标版本"的历史条目：

```typescript
export async function listOutcomes(dataDir?: string): Promise<PerformanceOutcome[]> {
  const journal = await readJournal(dataDir);
  const byKey = new Map<string, PerformanceOutcome>();
  for (const o of journal) {
    byKey.set(outcomeKey(o), o);
  }
  const deduped = Array.from(byKey.values());
  // 对账：同一平台条目（标题@发布日期）存在任何打标（contentId 非空）版本时，
  // 丢弃该条目的全部历史（contentId 为空）版本——跨数据日期也不双计（评审修订：
  // 否则 confirm_published 前的周一快照与之后的周二快照会被 baseline 当成两个作品）。
  const matchedTitleKeys = new Set(
    deduped
      .filter((o) => o.contentId !== null)
      .map((o) => outcomeKey({ ...o, contentId: null, metricDate: "" })),
  );
  return deduped.filter(
    (o) => o.contentId !== null || !matchedTitleKeys.has(outcomeKey({ ...o, metricDate: "" })),
  );
}
```

测试（追加到 csv-import.test.ts 的 importPerformanceCsv describe 块）：

```typescript
  it("re-import after confirm_published supersedes the historical entry (no double count)", async () => {
    const CSV = `作品名称,发布时间,播放量,完播率\n护肤新稿,2026-06-01 10:00,1000,30%`;
    await importPerformanceCsv("douyin", CSV, "2026-06-08", testDir); // 未匹配 → historical
    const c = await saveContent(
      { title: "护肤新稿", body: "正文", platform: "douyin", status: "published", tags: [] },
      testDir,
    );
    await updateContent(c.id, { publishedAt: "2026-06-01T10:00:00.000Z" }, testDir);
    const second = await importPerformanceCsv("douyin", CSV, "2026-06-08", testDir); // 匹配 → contentId 键
    expect(second.matched).toBe(1);
    const outcomes = await listOutcomes(testDir);
    const forTitle = outcomes.filter((o) => o.platformTitle === "护肤新稿");
    expect(forTitle).toHaveLength(1);
    expect(forTitle[0].contentId).toBe(c.id);
  });
```

运行 store 测试 + csv 测试确认全部通过。

- [ ] **Step 6: Commit**

```bash
git add src/modules/flywheel/csv-import.ts src/modules/flywheel/csv-import.test.ts src/modules/flywheel/outcome-store.ts
git commit -m "feat: platform CSV import — column mapping as data, draft matching, reconciliation"
```

---

### Task 6: quality-baseline 改读 outcome store

**Files:**
- Modify: `src/modules/analytics/quality-baseline.ts:123-142`（buildBaseline 数据来源）、`:285-301`（trackPerformance 写穿）
- Test: Create `src/modules/analytics/quality-baseline.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/analytics/quality-baseline.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildBaseline, trackPerformance } from "./quality-baseline.js";
import { recordOutcome, listOutcomes } from "../flywheel/outcome-store.js";
import { saveContent, updateContent } from "../../storage/local-store.js";
import { addPerformanceEntry } from "../profile/creator-profile.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-baseline-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

async function seedOutcome(contentId: string | null, title: string, views: number, metricDate: string) {
  await recordOutcome(
    {
      contentId,
      platform: "douyin",
      platformTitle: title,
      publishedAt: "2026-06-01T10:00:00.000Z",
      metricDate,
      metrics: { views, completionRate: 30 },
      source: "csv",
    },
    testDir,
  );
}

describe("buildBaseline from outcome store", () => {
  it("builds baseline from outcome store entries (including historical)", async () => {
    await seedOutcome("c1", "标题一", 1000, "2026-06-08");
    await seedOutcome("c2", "标题二", 2000, "2026-06-08");
    await seedOutcome(null, "历史作品", 3000, "2026-06-08");

    const baseline = await buildBaseline(testDir);
    expect(baseline.sampleSize).toBe(3);
    expect(baseline.avgMetrics.views).toBe(2000);
  });

  it("uses only the latest snapshot per item, not every metricDate", async () => {
    await seedOutcome("c1", "标题一", 1000, "2026-06-07");
    await seedOutcome("c1", "标题一", 1500, "2026-06-08"); // 同一作品的更新快照
    await seedOutcome("c2", "标题二", 2000, "2026-06-08");
    await seedOutcome("c3", "标题三", 3000, "2026-06-08");

    const baseline = await buildBaseline(testDir);
    expect(baseline.sampleSize).toBe(3); // c1 只算一次
    expect(baseline.avgMetrics.views).toBe(Math.round((1500 + 2000 + 3000) / 3));
  });

  it("falls back to legacy profile.performanceHistory when outcome store empty", async () => {
    for (const [id, views] of [["a", 100], ["b", 200], ["c", 300]] as const) {
      await addPerformanceEntry({ contentId: id, platform: "douyin", metrics: { views } }, testDir);
    }
    const baseline = await buildBaseline(testDir);
    expect(baseline.sampleSize).toBe(3);
    expect(baseline.avgMetrics.views).toBe(200);
  });
});

describe("trackPerformance writes through outcome store", () => {
  it("records into outcome journal with source=paste", async () => {
    const c = await saveContent(
      { title: "手动回填的稿子", body: "正文", platform: "douyin", status: "published", tags: [] },
      testDir,
    );
    await updateContent(c.id, { publishedAt: "2026-06-01T10:00:00.000Z" }, testDir);

    const r = await trackPerformance(c.id, { views: 500, likes: 20 }, testDir);
    expect(r.ok).toBe(true);

    const outcomes = await listOutcomes(testDir);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].contentId).toBe(c.id);
    expect(outcomes[0].source).toBe("paste");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/analytics/quality-baseline.test.ts`
Expected: FAIL — baseline 仍读 profile（前两个用例 sampleSize 为 0），trackPerformance 用例 outcomes 为空

- [ ] **Step 3: Modify quality-baseline.ts**

文件头追加 import：

```typescript
import { listOutcomes, recordOutcome } from "../flywheel/outcome-store.js";
import { outcomeKey } from "../flywheel/outcome-schema.js";
```

`buildBaseline` 内（原 124-129 行）把数据来源段替换为：

```typescript
  const [contents, profile] = await Promise.all([
    listContents(dataDir),
    loadProfile(dataDir),
  ]);

  // Outcome store 是唯一真实来源；为空时 fallback 到 legacy profile.performanceHistory。
  // 多个 metricDate 快照只取每个作品最新一份，避免重复计权。
  const outcomes = await listOutcomes(dataDir);
  const latestByItem = new Map<string, (typeof outcomes)[number]>();
  for (const o of outcomes) {
    const itemKey = outcomeKey({ ...o, metricDate: "" });
    const prev = latestByItem.get(itemKey);
    if (!prev || o.metricDate > prev.metricDate) latestByItem.set(itemKey, o);
  }
  const fromOutcomes: PerformanceEntry[] = Array.from(latestByItem.values()).map((o) => ({
    contentId: o.contentId ?? `hist:${o.platform}:${o.platformTitle}`,
    platform: o.platform,
    metrics: Object.fromEntries(
      Object.entries(o.metrics).filter(([, v]) => typeof v === "number"),
    ) as Record<string, number>,
    recordedAt: o.recordedAt,
  }));

  const performanceHistory =
    fromOutcomes.length > 0 ? fromOutcomes : profile?.performanceHistory || [];
```

`trackPerformance` 内（原 297-301 行）把 `addPerformanceEntry(...)` 调用替换为：

```typescript
  // 单一写入路径：写穿 outcome store（profile.performanceHistory 降级为只读 legacy）
  const write = await recordOutcome(
    {
      contentId,
      platform: content.platform || "unknown",
      platformTitle: content.title,
      publishedAt: content.publishedAt,
      metricDate: new Date().toISOString().slice(0, 10),
      metrics,
      source: "paste",
    },
    dataDir,
  );
  if (!write.ok) {
    return { ok: false, contentId, metrics };
  }
```

同时删掉文件头的 `addPerformanceEntry` import（保留 `loadProfile` 和 `type PerformanceEntry`）。

- [ ] **Step 3.5（评审修订，随本任务落地）：混合数据防护与错误透出**

(a) **Critical**：top/bottom traits 切分只能在"contentId 能解析到真实 content"的条目上做——历史条目（hist: 伪 id）落在任一档位都会把该档位变成全零 traits，insight 生成器拿真实 traits 对比零值会产出捏造建议（"你表现好的内容平均 0 字，精简内容可能效果更好"），并让 compareToBaseline 对每篇草稿报 poor。修复：
- `const contentIds = new Set(contents.map((c) => c.id));`
- traits 切分（scored → topIds/bottomIds → topContents/bottomContents）只在 `performanceHistory.filter((e) => contentIds.has(e.contentId))` 上进行，且该子集 ≥3 条才做 traits 分析，否则保持零值 traits 且**不生成对比型 insight**；
- 三条 trait 对比 insight 在 topContents 或 bottomContents 为空时一律跳过；
- avgMetrics / sampleSize 仍在全量（含历史）上计算——day-1 回灌的主要价值在此，纯历史数据集退化为"正确的 avgMetrics + 通用 insight"是优雅降级。
- 测试：10 条历史（高播放）+ 3 条 matched → insights 不含"平均 0 字"类捏造；compareToBaseline 不因空 traits 全面报 poor。

(b) **Important**：`getPerformanceScore` 补 favorites（CSV 导入的收藏字段映射到 favorites，不是 saves）：`+ (m.favorites || 0) * 4`，saves 保留兼容 paste 路径。**completionRate（口播主 reward signal）的计权明确推迟到赛道包计划**（KOUBO_REWARD 接线时一并做），在此记录防丢失。

(c) **Important**：`trackPerformance` 失败必须透出原因——`PerformanceTrackingResult` 加 `error?: string`，not-found 与 recordOutcome 拒收分别填充。测试：completionRate 200 → ok:false 且 error 含"完播率"。

(d) **Minor**：metricDate 用本地日期而非 UTC（Asia/Shanghai 早 8 点前 toISOString 会记成昨天，同 Task 5 时区修订的精神）：

```typescript
const now = new Date();
const metricDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
```

(e) buildBaseline 抽出私有 helper `loadPerformanceHistory(dataDir?)`（listOutcomes → latest-per-item → 映射 → legacy fallback），使各函数回到 <50 行。

- [ ] **Step 4: Run full suite to verify pass and no regression**

Run: `npx vitest run`
Expected: PASS（全部既有测试 194 个 + 本计划新增；`quality-baseline` 原有行为靠 fallback 兼容）

- [ ] **Step 5: Commit**

```bash
git add src/modules/analytics/quality-baseline.ts src/modules/analytics/quality-baseline.test.ts
git commit -m "refactor: quality-baseline reads outcome store — single write path for performance data"
```

---

### Task 7: autocrew_flywheel 工具 + 注册

**Files:**
- Create: `src/tools/flywheel.ts`
- Test: `src/tools/flywheel.test.ts`
- Modify: `index.ts`（import 区 ~22 行后 + 注册区任一 `runner.register` 块后）
- Modify: `src/storage/local-store.ts`（评审决议：把私有 `getDataDir` 加 export——消除第三份复制）
- Modify: `src/modules/flywheel/outcome-store.ts`（删除本地 getDataDir 复制，改 import 共享版）

- [ ] **Step 1: Write the failing test**

```typescript
// src/tools/flywheel.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeFlywheel } from "./flywheel.js";
import { saveContent, updateContent } from "../storage/local-store.js";
import { listOutcomes } from "../modules/flywheel/outcome-store.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-flytool-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("executeFlywheel", () => {
  it("import_csv: imports from a csv file path and returns report", async () => {
    const csvPath = path.join(testDir, "douyin.csv");
    await fs.writeFile(
      csvPath,
      "作品名称,发布时间,播放量,完播率\n老视频,2025-12-01 09:00,5000,28%\n",
      "utf-8",
    );
    const r = (await executeFlywheel({
      action: "import_csv",
      platform: "douyin",
      csv_path: csvPath,
      _dataDir: testDir,
    })) as { ok: boolean; data: { imported: number; historical: number } };
    expect(r.ok).toBe(true);
    expect(r.data.imported).toBe(1);
    expect(r.data.historical).toBe(1);
  });

  it("record: manual paste entry for a known content", async () => {
    const c = await saveContent(
      { title: "口播稿A", body: "正文", platform: "douyin", status: "published", tags: [] },
      testDir,
    );
    await updateContent(c.id, { publishedAt: "2026-06-01T10:00:00.000Z" }, testDir);

    const r = (await executeFlywheel({
      action: "record",
      content_id: c.id,
      metrics: { views: 800, completionRate: 41 },
      _dataDir: testDir,
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(await listOutcomes(testDir)).toHaveLength(1);
  });

  it("record: rejects unknown content id", async () => {
    const r = (await executeFlywheel({
      action: "record",
      content_id: "nope",
      metrics: { views: 1 },
      _dataDir: testDir,
    })) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
  });

  it("report: returns counts, needsReview and baseline insights", async () => {
    const csvPath = path.join(testDir, "douyin.csv");
    await fs.writeFile(
      csvPath,
      "作品名称,发布时间,播放量,完播率\n视频1,2025-12-01 09:00,1000,30%\n视频2,2025-12-02 09:00,2000,31%\n视频3,2025-12-03 09:00,3000,33%\n",
      "utf-8",
    );
    await executeFlywheel({ action: "import_csv", platform: "douyin", csv_path: csvPath, _dataDir: testDir });

    const r = (await executeFlywheel({ action: "report", _dataDir: testDir })) as {
      ok: boolean;
      data: { totalOutcomes: number; needsReview: unknown[]; baselineInsights: string[] };
    };
    expect(r.ok).toBe(true);
    expect(r.data.totalOutcomes).toBe(3);
    expect(r.data.baselineInsights.length).toBeGreaterThan(0);
    expect(r.data.traitSampleSize).toBe(0); // 三条均为 historical，无打标条目
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/flywheel.test.ts`
Expected: FAIL — `Cannot find module './flywheel.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/tools/flywheel.ts
/**
 * autocrew_flywheel — 性能闭环工具（PRD v3 §6/§7.2c 的 dogfood 入口）。
 * actions:
 *   import_csv — 导入平台创作者中心导出的 CSV（历史回灌 + 周常回填共用）
 *   record    — 手动回填单条数据（结构化粘贴兜底）
 *   report    — 闭环状态：条数、待人工确认、baseline 洞察
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { importPerformanceCsv } from "../modules/flywheel/csv-import.js";
import { listOutcomes } from "../modules/flywheel/outcome-store.js";
import { buildBaseline, trackPerformance } from "../modules/analytics/quality-baseline.js";

export const flywheelSchema = Type.Object({
  action: Type.Unsafe<"import_csv" | "record" | "report">({
    type: "string",
    enum: ["import_csv", "record", "report"],
    description:
      "Flywheel action. 'import_csv' to ingest platform CSV export, 'record' for manual metrics entry, 'report' for loop status.",
  }),
  platform: Type.Optional(
    Type.String({ description: "Platform key for import_csv: douyin | wechat_video | xiaohongshu." }),
  ),
  csv_path: Type.Optional(Type.String({ description: "Path to the exported CSV file (for import_csv)." })),
  metric_date: Type.Optional(
    Type.String({ description: "YYYY-MM-DD the metrics refer to. Defaults to today." }),
  ),
  content_id: Type.Optional(Type.String({ description: "AutoCrew content id (for record)." })),
  metrics: Type.Optional(
    Type.Record(Type.String(), Type.Number(), {
      description: "Metrics for record action, e.g. {\"views\":800,\"completionRate\":41}.",
    }),
  ),
});

// 评审决议：不再复制 dataDir 解析——local-store.getDataDir 加 export，此处与 outcome-store 共用
import { getDataDir } from "../storage/local-store.js";

export async function executeFlywheel(params: Record<string, unknown>) {
  const action = params.action as string;
  const dataDir = getDataDir((params._dataDir as string) || undefined);

  if (action === "import_csv") {
    const platform = params.platform as string | undefined;
    const csvPath = params.csv_path as string | undefined;
    if (!platform || !csvPath) {
      return { ok: false, error: "import_csv 需要 platform 和 csv_path" };
    }
    let csvText: string;
    try {
      csvText = await fs.readFile(path.resolve(csvPath), "utf-8");
    } catch {
      return { ok: false, error: `读不到 CSV 文件：${csvPath}` };
    }
    const metricDate = (params.metric_date as string) || new Date().toISOString().slice(0, 10);
    try {
      const report = await importPerformanceCsv(platform, csvText, metricDate, dataDir);
      return { ok: true, data: report };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (action === "record") {
    const contentId = params.content_id as string | undefined;
    const metrics = params.metrics as Record<string, number> | undefined;
    if (!contentId || !metrics) {
      return { ok: false, error: "record 需要 content_id 和 metrics" };
    }
    const result = await trackPerformance(contentId, metrics, dataDir);
    return result.ok
      ? { ok: true, data: result }
      : { ok: false, error: `回填失败：content ${contentId} 不存在或数据未通过校验` };
  }

  if (action === "report") {
    const outcomes = await listOutcomes(dataDir);
    const baseline = await buildBaseline(dataDir);
    const byPlatform: Record<string, number> = {};
    for (const o of outcomes) {
      byPlatform[o.platform] = (byPlatform[o.platform] || 0) + 1;
    }
    return {
      ok: true,
      data: {
        totalOutcomes: outcomes.length,
        byPlatform,
        matched: outcomes.filter((o) => o.contentId !== null).length,
        historical: outcomes.filter((o) => o.contentId === null).length,
        needsReview: outcomes.filter((o) => o.needsReview),
        baselineSampleSize: baseline.sampleSize,
        traitSampleSize: baseline.traitSampleSize,
        baselineInsights: baseline.insights,
      },
    };
  }

  return { ok: false, error: `Unknown action: ${action}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tools/flywheel.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: Register in index.ts**

import 区（第 22 行 `dashboardSchema` import 之后）追加：

```typescript
import { flywheelSchema, executeFlywheel } from "./src/tools/flywheel.js";
```

注册区（任一 `runner.register({...});` 块之后，与现有块同级）追加：

```typescript
  runner.register({
    name: "autocrew_flywheel",
    label: "AutoCrew Flywheel",
    description:
      "Performance loop: import platform CSV exports (back-catalog + weekly backfill), record manual metrics, " +
      "and report loop status with baseline insights. Actions: import_csv, record, report.",
    parameters: flywheelSchema,
    execute: executeFlywheel,
  });
```

（只注册 index.ts 这一处。mcp/server.ts 双宿主已被 PRD §10 判砍，不再添新注册。）

- [ ] **Step 6: Run full suite**

Run: `npx vitest run`
Expected: PASS（全部）

- [ ] **Step 7: Commit**

```bash
git add src/tools/flywheel.ts src/tools/flywheel.test.ts index.ts
git commit -m "feat: autocrew_flywheel tool — CSV import, manual record, loop report"
```

---

### Task 8: Dogfood Runbook + 收尾

**Files:**
- Create: `docs/dogfood-runbook.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Dogfood Runbook — 闭环第 0 步操作手册

> 对应 PRD v3 §11 第 0 步、§12 双层指标。执行人：创始人。环境：现有 OpenClaw 插件宿主。

## 一次性：历史回灌（Day-1 热启动）

1. 打开 抖音创作者中心 / 视频号助手 / 小红书创作服务平台 → 数据中心 → 导出近 90 天作品数据 CSV。
2. 对每个平台运行：
   `autocrew_flywheel action=import_csv platform=douyin csv_path=~/Downloads/抖音作品数据.csv`
3. **首次导入必做——校准列名映射**：如果 report 显示 imported=0 或指标全空，
   打开 CSV 看真实表头，把列名加进 `src/modules/flywheel/csv-import.ts` 的
   `PLATFORM_MAPPINGS.<platform>` 对应别名数组（这是配置不是代码改动），重新导入。
4. 运行 `autocrew_flywheel action=report`，确认 baselineSampleSize ≥ 3、insights 非空。

## 每周循环（每个发布周期）

1. 写稿 → 发布（clipboard）→ `autocrew_publish action=confirm_published content_id=... publish_url=...`
   （**必须 confirm**，否则 CSV 导入无法把数据打标到这一稿。）
2. 发布 48-72h 后：从平台后台导出 CSV → `import_csv`（同一文件重复导入安全，幂等覆盖）。
3. 查看 report：
   - `needsReview` 非空 → 逐条人工确认（播放 0 / 暴涨 → 是否读错字段）。
   - `matched` 应等于本周发布数；不等 → 标题改过太多或没 confirm_published，手动用
     `autocrew_flywheel action=record content_id=... metrics={...}` 补录。

## 盯的两层指标（PRD §12）

- **可靠性**：每周 matched / 本周发布数 ≥ 80%？导入失败/校准次数在下降？
- **学习代理**：生成稿的人工编辑量在下降？baseline insights 有没有真的改变下一稿的写法？

连续 3 个周期可靠性达标 → thesis 成立，进入引擎/桌面壳建设加速；
频繁失败 → 回退纯手动 record，并按 PRD §12 重新评估。
```

- [ ] **Step 2: Full suite + typecheck final pass**

Run: `npm install && npm run typecheck && npx vitest run`
Expected: typecheck 0 errors；全部测试 PASS

- [ ] **Step 3: Commit**

```bash
git add docs/dogfood-runbook.md
git commit -m "docs: dogfood runbook — day-1 back-catalog import and weekly loop"
```

---

## Self-Review Checklist（计划完成后已自查）

1. **Spec 覆盖**：PRD §3 schema 第一公民（Task 1-2）✓ §6 回填 verify 值域/双因子/异常转人工（Task 1/3，暴涨检测 Task 2）✓ §5 journal/幂等/冷启动重放（Task 2）✓ §7.1 历史回灌 CSV 优先（Task 5/8）✓ §11 第 0 步 dogfood（Task 7/8）✓ §12 双层指标落地为 report 字段（Task 7）✓
2. **占位符扫描**：无 TBD/TODO；所有步骤含完整代码与命令。
3. **类型一致性**：`PerformanceOutcome`/`OutcomeMetrics`/`outcomeKey` 在 Task 1 定义、Task 2/5/6 引用签名一致；`recordOutcome` 返回 `RecordResult{ok,outcome,replaced,error}` 在 Task 5/6/7 使用一致；`matchDraft(platform,title,publishedAt,dataDir)` Task 3 定义 = Task 5 调用。
4. **已知边界（非缺陷，记录在案)**：PLATFORM_MAPPINGS 默认列名待真实 CSV 校准（runbook Step 3 是闭环的一部分）；`creator-profile.addPerformanceEntry` 保留为 legacy 读路径，不再有新写入方。
