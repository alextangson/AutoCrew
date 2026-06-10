# 赛道包抽取（Track Pack）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把口播 playbook 从 [write-script/SKILL.md](../../skills/write-script/SKILL.md) 抽成第一个**声明式赛道包**（PRD §8/§11 的 v1 首要交付物），并让 reward signal 从包里读（PRD §7.2c），一举证明 pack 抽象 + 解决 dogfood 发现的跨平台信号差异（抖音 5s完播率 / 小红书无完播列）。

**Architecture:** 新建 `src/modules/packs/`——`pack-schema.ts`（类型合同）+ `koubo.ts`（第一个包：钩子库/结构骨架/自审清单/平台调整/逐平台 reward 权重，全部是类型检查过的数据）+ 注册表。`quality-baseline` 的打分改为消费包的逐平台权重（终结 Task 6 评审遗留的 completionRate 计权）。schema 增 `completion5s` 字段，douyin 映射收 `5s完播率` 列。SKILL.md 瘦身为流程编排，内容数据指向包。

**Tech Stack:** TypeScript (ESM `.js` 后缀)，vitest，零新依赖。包 = TS 数据模块（编译期类型检查，无运行时解析）。

**设计决定（已锁定）：**
- 包是 **TS 数据模块**不是 JSON——免运行时校验，类型即合同。动态加载/第三方包是 PRD 长期项，v1 不做（YAGNI）。
- reward = `default` + `byPlatform` 覆盖。权重是**起始值不是真理**，调参靠后续真实数据——declarative 的意义就是改数据不改代码。
- `completionRateAsRatio`（前天加的布尔）升级为 `ratioMetrics: 数组`——pre-release 内部配置无兼容负担，5s完播率同样是抖音比例格式。
- `KOUBO_REWARD` 常量从 outcome-schema 删除（连同其测试）——包不能被 schema 反向依赖，reward 数据归包所有。执行时先 `grep -rn KOUBO_REWARD src/` 确认无其他消费者。
- 打分量纲说明：completion 类是 0-100 百分比、views 是原始计数，权重已按"完播主导、播放保底"的口播目标函数配比。

---

## File Structure

| 文件 | 职责 |
|---|---|
| Create `src/modules/packs/pack-schema.ts` | TrackPack / PlatformReward 类型合同 |
| Create `src/modules/packs/koubo.ts` | 口播包数据（从 SKILL.md 抽取 + reward 权重）|
| Create `src/modules/packs/index.ts` | `getPack(id)` 注册表 + `DEFAULT_PACK_ID` |
| Create `src/modules/packs/pack-schema.test.ts` | 包形状与完整性测试 |
| Modify `src/modules/flywheel/outcome-schema.ts` | +`completion5s` 字段、验证规则；−`KOUBO_REWARD` |
| Modify `src/modules/flywheel/csv-import.ts` | `ratioMetrics` 数组替代布尔；douyin +`5s完播率` 别名 |
| Modify `src/modules/analytics/quality-baseline.ts` | `getPerformanceScore(entry, pack)` 按逐平台权重打分 |
| Modify 对应 3 个测试文件 | 行为变化的回归测试 |
| Modify `skills/write-script/SKILL.md` | 钩子表/结构规格/平台表 → 指向包（单一来源）|

---

### Task 1: 包类型合同 + 口播包数据

**Files:**
- Create: `src/modules/packs/pack-schema.ts`
- Create: `src/modules/packs/koubo.ts`
- Create: `src/modules/packs/index.ts`
- Test: `src/modules/packs/pack-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/packs/pack-schema.test.ts
import { describe, it, expect } from "vitest";
import { KOUBO_PACK } from "./koubo.js";
import { getPack, DEFAULT_PACK_ID } from "./index.js";

describe("koubo pack shape", () => {
  it("registry resolves the default pack", () => {
    expect(DEFAULT_PACK_ID).toBe("koubo");
    expect(getPack("koubo")).toBe(KOUBO_PACK);
    expect(() => getPack("nonexistent")).toThrow(/未注册/);
  });

  it("carries the five hook types extracted from the playbook", () => {
    expect(KOUBO_PACK.hooks).toHaveLength(5);
    const types = KOUBO_PACK.hooks.map((h) => h.type);
    expect(types).toContain("痛点");
    expect(types).toContain("悬念");
    expect(types).toContain("反差");
    for (const h of KOUBO_PACK.hooks) {
      expect(h.whenToUse.length).toBeGreaterThan(4);
    }
  });

  it("structure skeleton covers hook/body/cta with non-empty rules", () => {
    expect(KOUBO_PACK.structure.hook.length).toBeGreaterThan(0);
    expect(KOUBO_PACK.structure.body.length).toBeGreaterThanOrEqual(4);
    expect(KOUBO_PACK.structure.cta.length).toBeGreaterThan(0);
    expect(KOUBO_PACK.selfReview.length).toBeGreaterThanOrEqual(8);
  });

  it("reward: default exists and every byPlatform entry names its primary inside its own weights", () => {
    const all = [KOUBO_PACK.reward.default, ...Object.values(KOUBO_PACK.reward.byPlatform ?? {})];
    for (const r of all) {
      expect(Object.keys(r.weights).length).toBeGreaterThan(0);
      expect(r.weights[r.primary]).toBeGreaterThan(0);
    }
  });

  it("xiaohongshu reward does not depend on completion metrics (平台无此列)", () => {
    const xhs = KOUBO_PACK.reward.byPlatform?.xiaohongshu;
    expect(xhs).toBeDefined();
    expect(xhs?.weights.completionRate).toBeUndefined();
    expect(xhs?.weights.completion5s).toBeUndefined();
    expect(xhs?.primary).toBe("favorites");
  });

  it("douyin reward leads with completion5s (dogfood 发现：对钩子质量更敏感)", () => {
    const dy = KOUBO_PACK.reward.byPlatform?.douyin;
    expect(dy?.primary).toBe("completion5s");
    expect(dy?.weights.completion5s).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/modules/packs/pack-schema.test.ts`
Expected: FAIL — Cannot find module './koubo.js'

- [ ] **Step 3: Write the implementation**

```typescript
// src/modules/packs/pack-schema.ts
/**
 * 赛道包类型合同（PRD §8）：一个赛道包 = 钩子集 + 结构骨架 + 成功指标定义 + 合规叠加引用。
 * 包是数据不是代码——换赛道/调参改包文件，引擎与打分逻辑不动。
 */
import type { OutcomeMetrics } from "../flywheel/outcome-schema.js";

export type MetricKey = keyof OutcomeMetrics;

export interface PlatformReward {
  /** 该平台的头号信号（报表强调用） */
  primary: MetricKey;
  /** 打分权重：score = Σ weights[k] × metrics[k]。量纲注意：completion 类为 0-100 百分比，views 为原始计数 */
  weights: Partial<Record<MetricKey, number>>;
  /** 平台特殊性说明（如缺列、代理信号理由） */
  note?: string;
}

export interface HookPattern {
  type: string;
  whenToUse: string;
}

export interface TrackPack {
  id: string;
  name: string;
  version: number;
  /** 成功指标：default 兜底，byPlatform 按平台覆盖 */
  reward: {
    default: PlatformReward;
    byPlatform?: Record<string, PlatformReward>;
  };
  hooks: HookPattern[];
  /** 结构骨架：每段是给编剧（人或模型）的规则句 */
  structure: {
    hook: string[];
    body: string[];
    cta: string[];
  };
  selfReview: string[];
  platformAdjustments: Record<string, { chars: string; style: string }>;
  /** 合规口径引用（具体过滤复用 humanizer/sensitive-words，包只声明口径） */
  complianceNote: string;
}
```

```typescript
// src/modules/packs/koubo.ts
/**
 * 口播（知识类）赛道包 v1 — 内容抽取自 skills/write-script/SKILL.md 的口播 playbook，
 * reward 权重来自 2026-06-10 dogfood 发现（抖音 5s完播率更敏感；小红书无完播列）。
 * 权重是起始值：调参改这里，不改打分代码。
 */
import type { TrackPack } from "./pack-schema.js";

export const KOUBO_PACK: TrackPack = {
  id: "koubo",
  name: "知识口播",
  version: 1,
  reward: {
    default: {
      primary: "completionRate",
      weights: { completionRate: 15, favorites: 4, follows: 8, likes: 2, comments: 3, shares: 5, views: 0.01 },
      note: "口播目标函数 = 完播主导，播放保底（PRD §6：口播=完播）",
    },
    byPlatform: {
      douyin: {
        primary: "completion5s",
        weights: { completion5s: 8, completionRate: 15, favorites: 4, follows: 8, likes: 2, comments: 3, shares: 5, views: 0.01 },
        note: "5s完播率对钩子质量比全程完播更敏感（3-5min 视频全程完播自然只有 2-6%）",
      },
      xiaohongshu: {
        primary: "favorites",
        weights: { favorites: 6, follows: 10, likes: 2, comments: 3, shares: 5, views: 0.02 },
        note: "小红书导出无完播率列（2026-06-10 实战确认），用收藏+涨粉做代理信号",
      },
    },
  },
  hooks: [
    { type: "痛点", whenToUse: "受众有一个明显未解决的挫败" },
    { type: "悬念", whenToUse: "选题有反直觉真相或惊人数据" },
    { type: "理想状态", whenToUse: "选题贩卖一个值得向往的结果" },
    { type: "情绪共鸣", whenToUse: "选题触及身份认同、归属或抱负" },
    { type: "反差", whenToUse: "普遍认知与现实之间有清晰落差" },
  ],
  structure: {
    hook: [
      "1-3 句，只选一种最强钩子类型",
      "绝不以「哈喽大家好」「你有没有想过」等通用问候开头",
    ],
    body: [
      "5-8 个信息点，每点：论断 → 为什么成立 → 具体例子",
      "每点 80-150 字，正文合计 800-1500 字",
      "信息点递进展开——别把最好的料堆在前面",
      "包含 1-2 个打破预期的转折",
      "包含 1-2 个互动钩子（提问、「你猜怎么着」、评论引导）",
      "禁止议论文式长段落：短句，一句一个意思",
    ],
    cta: [
      "1-2 句，引导一个具体动作（收藏/评论/关注）",
      "必须连接内容价值——「收藏这条，下次用得上」优于「觉得有用就点赞」",
    ],
  },
  selfReview: [
    "全文 800 字以上？",
    "至少 2 个具体例子或场景（不是空泛断言）？",
    "有非显而易见的洞察或转折？",
    "语气符合 STYLE.md 画像？",
    "无通用问候、无议论文段落？",
    "正文纯文本、空行分段（无 markdown 标题）？",
    "标题在平台字数限制内？",
    "话题标签已生成且相关？",
    "至少 2 个来自调研的数据点？",
    "遵循了确认过的大纲结构？",
  ],
  platformAdjustments: {
    xiaohongshu: { chars: "300-1000", style: "emoji 丰富、口语化，话题标签置尾（5-15 个）" },
    douyin: { chars: "脚本格式", style: "[画面] + [口播] + [字幕条]，3 秒内出钩子" },
    wechat_mp: { chars: "1500-3000", style: "每 300-500 字一个小标题，结构感更强" },
    wechat_video: { chars: "300-800", style: "教育向语气，附文字总结" },
    bilibili: { chars: "500-2000", style: "年轻化表达，可以用梗，【】标注类型" },
  },
  complianceNote: "合规口径=「符合平台规则的自然口吻」（PRD §6 红线 5）：always-on humanizer/zh + sensitive-words 过滤，绝不表述为绕过检测/标识。",
};
```

```typescript
// src/modules/packs/index.ts
import type { TrackPack } from "./pack-schema.js";
import { KOUBO_PACK } from "./koubo.js";

export const DEFAULT_PACK_ID = "koubo";

const REGISTRY: Record<string, TrackPack> = {
  [KOUBO_PACK.id]: KOUBO_PACK,
};

export function getPack(id: string): TrackPack {
  const pack = REGISTRY[id];
  if (!pack) {
    throw new Error(`赛道包 ${id} 未注册（已有：${Object.keys(REGISTRY).join("/")}）`);
  }
  return pack;
}

export type { TrackPack, PlatformReward, MetricKey } from "./pack-schema.js";
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/modules/packs/pack-schema.test.ts` → PASS（6 tests）

- [ ] **Step 5: Commit**

```bash
git add src/modules/packs/
git commit -m "feat: first declarative track pack — koubo playbook extracted, per-platform reward weights"
```

---

### Task 2: schema 收 completion5s + 删 KOUBO_REWARD

**Files:**
- Modify: `src/modules/flywheel/outcome-schema.ts`
- Test: `src/modules/flywheel/outcome-schema.test.ts`

- [ ] **Step 1: 先确认 KOUBO_REWARD 消费者**

Run: `grep -rn "KOUBO_REWARD" src/ index.ts mcp/ --include="*.ts"`
Expected: 仅 outcome-schema.ts（定义）与 outcome-schema.test.ts（测试）。若有其他消费者，停下报告。

- [ ] **Step 2: Write the failing tests（outcome-schema.test.ts）**

删除 `KOUBO_REWARD` 的 describe 块与 import。追加：

```typescript
describe("completion5s", () => {
  const base = { publishedAt: "2026-06-01T10:00:00.000Z", metricDate: "2026-06-08" };

  it("accepts valid completion5s", () => {
    const v = validateOutcome({ ...base, metrics: { views: 100, completion5s: 35.4 } });
    expect(v.ok).toBe(true);
    expect(v.needsReview).toBe(false);
  });

  it("rejects completion5s outside 0-100", () => {
    const v = validateOutcome({ ...base, metrics: { completion5s: 135 } });
    expect(v.ok).toBe(false);
    expect(v.reasons.join()).toContain("5s完播率");
  });

  it("flags ratio-form completion5s as needsReview", () => {
    const v = validateOutcome({ ...base, metrics: { views: 100, completion5s: 0.35 } });
    expect(v.ok).toBe(true);
    expect(v.needsReview).toBe(true);
  });
});
```

- [ ] **Step 3: Implement**

`OutcomeMetrics` 增加：

```typescript
  /** 5 秒完播率，百分比 0-100（抖音独有，对钩子质量更敏感） */
  completion5s?: number;
```

`validateOutcome`：完播率 0-100 检查与 (0,1) 比例启发同样适用于 completion5s（把现有两处 completionRate 检查泛化为对 `["completionRate", "completion5s"]` 循环，reason 文案区分「完播率」/「5s完播率」）。删除 `KOUBO_REWARD` 常量。

- [ ] **Step 4: Run** — `npx vitest run src/modules/flywheel/outcome-schema.test.ts` → PASS；全套无回归

- [ ] **Step 5: Commit** — `git add src/modules/flywheel/outcome-schema.ts src/modules/flywheel/outcome-schema.test.ts && git commit -m "feat: completion5s metric + validation; reward data moves to track pack"`

---

### Task 3: csv-import 收 5s完播率 + ratioMetrics 数组

**Files:**
- Modify: `src/modules/flywheel/csv-import.ts`
- Test: `src/modules/flywheel/csv-import.test.ts`

- [ ] **Step 1: Write the failing test（追加）**

```typescript
describe("completion5s ingestion (douyin 作品列表)", () => {
  it("ingests 5s完播率 as ratio-converted completion5s", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-c5s-test-"));
    try {
      const CSV = `作品名称,发布时间,播放量,完播率,5s完播率\n口播D,2026-03-30 17:05:00,3376,0.018947,0.373904`;
      const report = await importPerformanceCsv("douyin", CSV, "2026-06-10", dir);
      expect(report.imported).toBe(1);
      expect(report.needsReview).toHaveLength(0);
      const o = (await listOutcomes(dir))[0];
      expect(o.metrics.completionRate).toBe(1.89);
      expect(o.metrics.completion5s).toBe(37.39);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run → FAIL**（completion5s undefined）

- [ ] **Step 3: Implement**

`CsvColumnMapping`：删 `completionRateAsRatio?: boolean`，增

```typescript
  completion5s?: string[];
  /** 平台把这些指标导出为 0-1 小数比例时声明（实战确认后），导入按 ×100 转换；>1 视为已是百分比 */
  ratioMetrics?: Array<"completionRate" | "completion5s">;
```

douyin 映射：`completion5s: ["5s完播率"]`，`ratioMetrics: ["completionRate", "completion5s"]`（删原布尔）。`rowToOutcomeInput`：metrics 增 `completion5s: parseMetricNumber(pick(row, mapping.completion5s))`；比例转换从单字段 if 泛化为对 `mapping.ratioMetrics ?? []` 循环（逻辑不变：值 ≤1 才 ×100，`Math.round(v * 10000) / 100`）。

确认既有两个 ratio 测试仍过（断言不变，机制换名）。

- [ ] **Step 4: Run 全套** — PASS，无回归

- [ ] **Step 5: Commit** — `git add src/modules/flywheel/csv-import.ts src/modules/flywheel/csv-import.test.ts && git commit -m "feat: ingest douyin 5s完播率 — ratioMetrics generalizes ratio conversion"`

---

### Task 4: 打分消费包权重

**Files:**
- Modify: `src/modules/analytics/quality-baseline.ts`
- Test: `src/modules/analytics/quality-baseline.test.ts`

- [ ] **Step 1: Write the failing tests（追加）**

```typescript
import { getPack } from "../packs/index.js";
import { getPerformanceScore } from "./quality-baseline.js";

describe("pack-weighted performance scoring", () => {
  const pack = getPack("koubo");

  it("douyin entry scores by completion5s-led weights", () => {
    const score = getPerformanceScore(
      { contentId: "a", platform: "douyin", metrics: { completion5s: 37.39, completionRate: 1.89, views: 3376, favorites: 95 }, recordedAt: "x" },
      pack,
    );
    // 8×37.39 + 15×1.89 + 0.01×3376 + 4×95 = 299.12 + 28.35 + 33.76 + 380 = 741.23
    expect(score).toBeCloseTo(741.23, 1);
  });

  it("xiaohongshu entry scores without completion metrics", () => {
    const score = getPerformanceScore(
      { contentId: "b", platform: "xiaohongshu", metrics: { views: 1985, favorites: 99, follows: 27 }, recordedAt: "x" },
      pack,
    );
    // 0.02×1985 + 6×99 + 10×27 = 39.7 + 594 + 270 = 903.7
    expect(score).toBeCloseTo(903.7, 1);
  });

  it("unknown platform falls back to default weights", () => {
    const score = getPerformanceScore(
      { contentId: "c", platform: "bilibili", metrics: { completionRate: 10, views: 100 }, recordedAt: "x" },
      pack,
    );
    // default: 15×10 + 0.01×100 = 151
    expect(score).toBeCloseTo(151, 1);
  });
});
```

- [ ] **Step 2: Run → FAIL**（getPerformanceScore 未导出 / 签名不符）

- [ ] **Step 3: Implement**

`quality-baseline.ts`：

```typescript
import { getPack, DEFAULT_PACK_ID, type TrackPack } from "../packs/index.js";

/** 按赛道包逐平台权重打分：score = Σ weights[k] × metrics[k]（未知平台用 default） */
export function getPerformanceScore(entry: PerformanceEntry, pack: TrackPack): number {
  const reward = pack.reward.byPlatform?.[entry.platform] ?? pack.reward.default;
  let score = 0;
  for (const [key, weight] of Object.entries(reward.weights)) {
    const v = entry.metrics[key];
    if (typeof v === "number" && typeof weight === "number") score += v * weight;
  }
  return score;
}
```

旧的硬编码 `getPerformanceScore`（likes×2+saves×4+favorites×4… 含 completionRate 推迟注释）删除；`splitTopBottom` 调用处改传 `getPack(DEFAULT_PACK_ID)`。注意：legacy paste 路径的 `saves` 键不在包权重里——koubo 包 default.weights 不收 saves（收藏语义已归 favorites），旧 saves 数据不再计分，属可接受的口径统一（在 commit message 注明）。

- [ ] **Step 4: Run 全套** — PASS（混合数据 trait 测试断言的是"无捏造"而非具体分值，不受权重变化影响；若有分值敏感断言按新权重修正并在报告中列出）

- [ ] **Step 5: Commit** — `git add src/modules/analytics/ && git commit -m "feat: performance scoring reads track-pack per-platform weights — completionRate weighting lands"`

---

### Task 5: SKILL.md 瘦身指向包 + 收尾

**Files:**
- Modify: `skills/write-script/SKILL.md`
- Modify: `docs/dogfood-runbook.md`（一行：重导抖音 CSV 以补 completion5s 历史）

- [ ] **Step 1: SKILL.md 编辑**

Step 4 的钩子表（| Type | When to use | 五行表）、body 规格（5-8 信息点那段）、CTA 规格、Step 5 自审清单、"Platform-Specific Adjustments" 表——替换为统一引用：

```markdown
4. **Write the script** — 钩子库、结构骨架（hook/body/CTA 规则）、自审清单、平台调整，
   全部以 `src/modules/packs/koubo.ts`（知识口播赛道包）为唯一来源：先读取该文件，
   按 `hooks`（选 ONE 最强类型）、`structure`、`platformAdjustments` 执行，
   写完按 `selfReview` 逐项修正（不是只检查）。标题与话题标签流程不变（title-hashtag.ts）。
```

Step 5 自审清单段与 Platform-Specific Adjustments 表删除（已入包）。Changelog 追加一行：`2026-06-10: v4 — playbook 抽入 koubo 赛道包（声明式），SKILL 只保留流程编排。`

- [ ] **Step 2: runbook 追加（实战发现日志末尾）**

```markdown
### 待办：重导抖音 CSV 补 completion5s
赛道包落地后 schema 新收 5s完播率。用同一份『作品列表』导出重跑一次 import_csv（幂等覆盖），
历史条目即补上 completion5s，抖音的打分立刻切到钩子敏感口径。
```

- [ ] **Step 3: Final pass** — `npx vitest run`（全套）+ `npx tsc --noEmit`（0 errors）

- [ ] **Step 4: Commit**

```bash
git add skills/write-script/SKILL.md docs/dogfood-runbook.md
git commit -m "refactor: write-script skill orchestrates only — playbook content lives in the koubo pack"
```

---

## Self-Review Checklist（计划完成后自查）

1. **Spec 覆盖**：PRD §8 包 = 钩子集✓ 结构骨架✓ 成功指标✓ 合规叠加（口径引用）✓；选题引擎不在本计划（topic 工具已存在，包暂不收选题数据——YAGNI，记录在案）。§7.2c reward 从包读 ✓。§11 "抽成第一个声明式赛道包" ✓。dogfood 发现（5s完播率/小红书代理信号）✓。
2. **占位符扫描**：无 TBD；所有代码完整。
3. **类型一致性**：`MetricKey = keyof OutcomeMetrics`（Task 2 先加 completion5s，Task 1 的包引用它——执行顺序注意：**Task 1 的 koubo.ts 用到 completion5s 键，必须在 Task 2 之后跑，或 Task 1 执行时容忍类型暂缺**。裁决：按 Task 2 → Task 1 → Task 3 → Task 4 → Task 5 的顺序执行，计划编号保持文档顺序）。
4. **已知边界**：reward 权重为起始值（调参 = 改包数据）；saves 旧键退役；选题引擎与第三方包生态显式推迟。
