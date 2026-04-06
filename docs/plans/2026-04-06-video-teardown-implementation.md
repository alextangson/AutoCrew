# Video Teardown Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the existing teardown skill with multimodal video analysis via MiMo-V2-Omni, so creators can teardown competitor videos (not just text) with insights grounded in communication theory, psychology, content architecture, and audiovisual language.

**Architecture:** Extend `skills/teardown/SKILL.md` with video detection + Omni analysis path. Add `videoCrawler` and `omniConfig` fields to `CreatorProfile` interface. No new tools or modules — the skill orchestrates existing intel ingest pipeline.

**Tech Stack:** TypeScript, MiMo-V2-Omni API (OpenAI-compatible), existing pipeline-store, vitest.

---

### Task 1: Extend CreatorProfile with videoCrawler and omniConfig

**Files:**
- Modify: `src/modules/profile/creator-profile.ts:66-95` (CreatorProfile interface)
- Modify: `src/modules/profile/creator-profile.ts:105-122` (emptyProfile function)
- Test: `src/modules/profile/creator-profile.test.ts` (if exists, else create)

**Step 1: Write the failing test**

Check if a test file exists first. If not, create `src/modules/profile/creator-profile.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProfile, saveProfile, type CreatorProfile } from "./creator-profile.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-profile-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("CreatorProfile video config", () => {
  it("saves and loads videoCrawler and omniConfig", async () => {
    const profile: CreatorProfile = {
      industry: "tech",
      platforms: ["douyin"],
      audiencePersona: null,
      creatorPersona: null,
      writingRules: [],
      styleBoundaries: { never: [], always: [] },
      competitorAccounts: [],
      performanceHistory: [],
      expressionPersona: "",
      secondaryPersonas: [],
      styleCalibrated: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      videoCrawler: {
        type: "mediacrawl",
        command: "python3 /opt/media_crawler/main.py",
      },
      omniConfig: {
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2-omni",
        apiKey: "test-key-123",
      },
    };

    await saveProfile(profile, testDir);
    const loaded = await loadProfile(testDir);

    expect(loaded).not.toBeNull();
    expect(loaded!.videoCrawler).toEqual({
      type: "mediacrawl",
      command: "python3 /opt/media_crawler/main.py",
    });
    expect(loaded!.omniConfig).toEqual({
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2-omni",
      apiKey: "test-key-123",
    });
  });

  it("loads profile without video config (backward compatible)", async () => {
    // Write a profile without the new fields
    const dir = testDir;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "creator-profile.json"),
      JSON.stringify({
        industry: "tech",
        platforms: [],
        audiencePersona: null,
        creatorPersona: null,
        writingRules: [],
        styleBoundaries: { never: [], always: [] },
        competitorAccounts: [],
        performanceHistory: [],
        expressionPersona: "",
        secondaryPersonas: [],
        styleCalibrated: false,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      }),
      "utf-8",
    );

    const loaded = await loadProfile(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.videoCrawler).toBeUndefined();
    expect(loaded!.omniConfig).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/modules/profile/creator-profile.test.ts`
Expected: FAIL — `videoCrawler` and `omniConfig` not defined on CreatorProfile type.

**Step 3: Add interfaces and extend CreatorProfile**

In `src/modules/profile/creator-profile.ts`, add before the `CreatorProfile` interface:

```typescript
export interface VideoCrawlerConfig {
  type: "mediacrawl" | "playwright" | "manual";
  /** Command to run for mediacrawl mode, e.g. "python3 /path/to/main.py" */
  command?: string;
}

export interface OmniConfig {
  /** API base URL, default "https://api.xiaomimimo.com/v1" */
  baseUrl: string;
  /** Model ID, default "mimo-v2-omni" */
  model: string;
  /** API key */
  apiKey: string;
}
```

Add to `CreatorProfile` interface (after `contentPillars`):

```typescript
  /** Video crawler configuration for teardown video acquisition */
  videoCrawler?: VideoCrawlerConfig;
  /** Omni model configuration for multimodal video analysis */
  omniConfig?: OmniConfig;
```

No changes to `emptyProfile()` — these fields are optional, undefined by default.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/modules/profile/creator-profile.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add src/modules/profile/creator-profile.ts src/modules/profile/creator-profile.test.ts
git commit -m "feat: add videoCrawler and omniConfig to CreatorProfile"
```

---

### Task 2: Extend teardown SKILL.md with video analysis path

**Files:**
- Modify: `skills/teardown/SKILL.md`

This is the core task. The existing skill handles text-only teardown. We extend it with:
1. Input type detection (text vs video link vs video file)
2. Video acquisition via configured crawler
3. Omni API analysis with the v2 four-lens template
4. Dual-write to `_teardowns/` + intel ingest

**Step 1: Rewrite the skill file**

Replace `skills/teardown/SKILL.md` with the extended version. The complete content follows.

Key changes from original:
- Description updated to mention video support
- Triggers expanded: "拆解这个视频" / video URL detection
- New Step 0: Input type detection (routes text vs video)
- Steps 1-8 preserved for text path (unchanged)
- New Steps V1-V8 for video path:
  - V1: Video acquisition (crawler dispatch)
  - V2: Metadata extraction
  - V3: Omni API call with template v2 prompt
  - V4-V8: Report formatting, storage, output
- Template v2 embedded (4 disciplinary lenses)
- Updated frontmatter format with `mode: video` field
- Updated save path and intel ingest integration

The skill file should include the COMPLETE template v2 content (all 4 lenses with
all sub-dimensions) embedded directly in the video analysis step, so the LLM sends
it as the Omni prompt. This is the most important part — the prompt quality determines
the teardown quality.

**Template v2 prompt to embed in the Omni API call:**

```
请对这段视频进行深度拆解分析。按以下四个学科视角分析，每个视角的每个子维度都必须给出具体分析（不可跳过）：

## 1. 传播学视角 — 这条内容为什么会被传播？

### 信息不对称设计
- 创作者掌握了什么观众不知道的信息？这个信息差是如何制造的？
- 揭示节奏：一次性全揭示还是逐层剥开？

### 社会货币
- 观众转发这条视频时，他在向朋友表达什么？
- 命中了 STEPPS 的哪些维度？(Social Currency / Triggers / Emotion / Public / Practical Value / Stories)

### 框架效应
- 这个创作者选择了什么叙事框架？
- 同样的信息换一个框架会怎样？

## 2. 心理学视角 — 观众的大脑在经历什么？

### 认知负荷管理
- 复杂概念如何被拆分？每个信息单元有多重？
- 有没有"认知休息区"？

### 情绪弧线
- 情绪曲线走向：开场→中间起伏→结尾
- Peak-End Rule：观众会记住哪个峰值和结尾？

### 身份投射
- 观众看完觉得自己是什么人？
- 满足了马斯洛哪一层需求？

### 开放循环与蔡格尼克效应
- 有多少未关闭的信息缺口？在什么时间打开和关闭？

## 3. 内容结构视角 — 论证架构是否有效？

### 论证结构
- 核心论证链：观点→证据类型(数据/案例/权威/类比)→反驳预处理→行动号召
- 论证漏洞在哪里？

### 承诺-兑现分析
- 前3秒承诺了什么（显性或隐性）？最终兑现了吗？
- 超额兑现还是打折兑现？

### 信息密度曲线
- 哪些段落信息密度高？哪些是呼吸空间？
- 密度节奏是否合理？

### 观点光谱定位
- 在共识←→反共识光谱上的位置？
- 反共识程度是否恰到好处？

## 4. 视听语言视角 — 形式如何服务内容？

### 视觉叙事
- 画面传递了什么文案没有说的信息？
- 关键画面选择的理由

### 节奏与注意力
- 按时钟理论（12/3/6/9）标注四个关键节点的 bang moment
- 切镜节奏是否和论证节奏同步？

### HKRR 诊断
- 主导维度（H快乐/K知识/R共鸣/R节奏）及纯粹度
- 是否有维度冲突？

## 5. 可借鉴清单

### ✅ 方法论级借鉴（可迁移到任何主题）
### ⚠️ 风格级借鉴（需要适配自身风格）
### ❌ 不适合借鉴（为什么不适合）
### 💡 创作启发（新选题/新角度/新表达方式）
```

**Step 2: Verify skill file is valid YAML frontmatter**

Run: `head -6 skills/teardown/SKILL.md`
Expected: valid `---` delimited YAML block.

**Step 3: Commit**

```bash
git add skills/teardown/SKILL.md
git commit -m "feat: extend teardown skill with multimodal video analysis"
```

---

### Task 3: Ensure `_teardowns/` directory and verify end-to-end intel integration

**Files:**
- Test: `src/modules/wiki/wiki.test.ts` (extend with teardown → wiki flow test)

**Step 1: Write the integration test**

Add to the existing `src/modules/wiki/wiki.test.ts`:

```typescript
describe("Teardown → Wiki Integration", () => {
  it("teardown intel flows into wiki pipeline", async () => {
    await initPipeline(testDir);

    // Simulate a video teardown result being ingested as intel
    const teardownIntel: IntelItem = {
      title: "拆解: vibe-coding教程视频分析",
      domain: "content-strategy",
      source: "manual",
      collectedAt: new Date().toISOString(),
      relevance: 90,
      tags: ["teardown", "video", "vibe-coding"],
      expiresAfter: 365,
      summary: "对标账号的vibe-coding教程视频拆解。传播学：信息不对称设计精妙，社会货币=实用价值。心理学：认知负荷控制好，每个概念都有呼吸空间。内容结构：承诺-兑现完美匹配。视听语言：HKRR主导K维度，纯粹度高。",
      keyPoints: [
        "开场3秒用反常识钩子，承诺兑现率高",
        "信息密度曲线合理，高密度段后有案例缓冲",
        "HKRR纯粹K维度，没有混杂搞笑元素",
        "框架效应：frame成'能力边界变化'而非'工具推荐'",
      ],
      topicPotential: "可借鉴的方法论：反常识开场+承诺兑现+纯粹K维度",
    };

    await saveIntel(teardownIntel, testDir);

    // Verify it's in the intel library
    const items = await listIntel("content-strategy", testDir);
    expect(items.length).toBe(1);
    expect(items[0].tags).toContain("teardown");

    // Simulate wiki page creation from teardown intel
    const wikiPage: WikiPage = {
      type: "concept",
      title: "Vibe Coding",
      aliases: ["vibe coding"],
      related: [],
      sources: [`content-strategy/${new Date().toISOString().slice(0, 10)}-chai-jie-vibe-coding-jiao-cheng-shi-pin-fen-xi.md`],
      created: new Date().toISOString().slice(0, 10),
      updated: new Date().toISOString().slice(0, 10),
      body: "# Vibe Coding\n\n用自然语言驱动编程的新范式。\n\n## Key Facts\n- 从对标视频拆解中提取：反常识开场+承诺兑现是有效公式",
    };
    await saveWikiPage(wikiPage, testDir);

    // Verify wiki page exists and references the teardown
    const loaded = await getWikiPage("vibe-coding", testDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.sources[0]).toContain("content-strategy");
  });
});
```

Add `listIntel` to the imports at the top of the file:
```typescript
import {
  // ... existing imports
  listIntel,
} from "../../storage/pipeline-store.js";
```

**Step 2: Run test**

Run: `npx vitest run src/modules/wiki/wiki.test.ts`
Expected: PASS

**Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass.

**Step 4: Commit**

```bash
git add src/modules/wiki/wiki.test.ts
git commit -m "test: teardown → intel → wiki integration test"
```

---

## Summary

| Task | Description | Files | Commits |
|------|-------------|-------|---------|
| 1 | CreatorProfile + videoCrawler + omniConfig | creator-profile.ts, test | 1 |
| 2 | Extend teardown SKILL.md with video path + template v2 | skills/teardown/SKILL.md | 1 |
| 3 | Integration test: teardown → intel → wiki flow | wiki.test.ts | 1 |

Total: 3 tasks, 3 commits. Minimal code changes — the heavy lifting is in the skill template (prompt engineering for Omni).
