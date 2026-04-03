# Content Methodology Enhancement — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enhance AutoCrew's content pipeline with tool-level enforcement, concrete writing methodology, version management, traffic hypotheses, and 6 new content methodologies (title formulas, comment engineering, completion rate micro-techniques, content flywheel, content positioning, competitive teardown).

**Architecture:** Changes span 4 layers: TypeScript tool code (content-save.ts, pipeline-store.ts, creator-profile.ts), skill files (write-script, content-review, teardown), philosophy doc (HAMLETDEER.md), and new data structures (ProjectMeta extension, ContentPillar type).

**Tech Stack:** TypeScript, Typebox schemas, YAML (js-yaml), gray-matter, Node.js fs

---

## Task 1: Extend ProjectMeta with hypothesis + performance fields

**Files:**
- Modify: `src/storage/pipeline-store.ts:77-88` (ProjectMeta interface)

**Step 1: Add new interfaces and fields to ProjectMeta**

Add after the existing `PlatformStatus` interface (line 70):

```typescript
export interface PerformanceData {
  views?: number;
  completionRate?: number;
  likes?: number;
  saves?: number;
  comments?: number;
  shares?: number;
  topComments?: string[];
  collectedAt?: string;
}

export interface PerformanceLearning {
  contentId: string;
  rating: "viral" | "on_target" | "below_expectation";
  coreAttribution: "strong_title" | "good_hook" | "right_topic" | "timing" | "luck";
  hypothesisResult: "confirmed" | "rejected" | "inconclusive";
  learning: string;
  createdAt: string;
}
```

Update `ProjectMeta` interface (line 77) — add after `platforms`:

```typescript
export interface ProjectMeta {
  title: string;
  domain: string;
  format: string;
  createdAt: string;
  sourceTopic: string;
  intelRefs: string[];
  versions: DraftVersion[];
  current: string;
  history: StageEntry[];
  platforms: PlatformStatus[];
  // --- New fields ---
  hypothesis?: string;
  experimentType?: "title_test" | "hook_test" | "format_test" | "angle_test";
  controlRef?: string;
  hypothesisResult?: "confirmed" | "rejected" | "inconclusive";
  performanceData?: PerformanceData;
  performanceLearnings?: PerformanceLearning[];
  contentPillar?: string;
  commentTriggers?: Array<{ type: "controversy" | "unanswered_question" | "quote_hook"; position: string }>;
}
```

**Step 2: Verify existing code still works**

Run: `npx tsc --noEmit`
Expected: No new type errors (all new fields are optional)

**Step 3: Commit**

```bash
git add src/storage/pipeline-store.ts
git commit -m "feat: extend ProjectMeta with hypothesis, performance, and content pillar fields"
```

---

## Task 2: Add ContentPillar to creator-profile

**Files:**
- Modify: `src/modules/profile/creator-profile.ts`

**Step 1: Read the file to confirm exact types**

Read `src/modules/profile/creator-profile.ts` and find the `CreatorProfile` interface.

**Step 2: Add ContentPillar interface and field**

Add new interface:

```typescript
export interface ContentPillar {
  name: string;
  targetPersona: string;
  valueProposition: string;
  contentRatio: number;
  toneGuide: string;
  exampleAngles: string[];
}
```

Add to `CreatorProfile` interface:

```typescript
contentPillars?: ContentPillar[];
```

**Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/modules/profile/creator-profile.ts
git commit -m "feat: add ContentPillar type to creator profile"
```

---

## Task 3: Version management — pipeline side on update

**Files:**
- Modify: `src/tools/content-save.ts:81-96` (update action)

**Step 1: Add import for addDraftVersion and slugify**

At top of content-save.ts, update the pipeline-store import:

```typescript
import {
  slugify,
  stagePath,
  initPipeline,
  addDraftVersion,
  type ProjectMeta,
} from "../storage/pipeline-store.js";
```

**Step 2: Add pipeline versioning to update action**

In the update action block (after line 96, after `return { ok: true, content: updated }`), BEFORE the return, add pipeline versioning:

```typescript
if (action === "update") {
    const id = params.id as string;
    if (!id) return { ok: false, error: "id is required for update" };
    const updated = await updateContent(id, {
      title: params.title as string | undefined,
      body: params.body as string | undefined,
      platform: params.platform as string | undefined,
      status: params.status ? normalizeLegacyStatus(params.status as string) : undefined,
      tags: params.tags as string[] | undefined,
      hashtags: params.hashtags as string[] | undefined,
      siblings: params.siblings as string[] | undefined,
      publishUrl: params.publish_url as string | undefined,
      performanceData: params.performance_data as Record<string, number> | undefined,
    }, dataDir);
    if (!updated) return { ok: false, error: `Content ${id} not found` };

    // Also version in pipeline storage if body changed
    if (params.body && updated.title) {
      try {
        const projectName = slugify(updated.title);
        await addDraftVersion(
          projectName,
          params.body as string,
          params.diff_note as string || `Edit via update`,
          dataDir ? path.join(dataDir, "data") : undefined,
        );
      } catch {
        // Pipeline project may not exist for legacy content — that's OK
      }
    }

    return { ok: true, content: updated };
  }
```

**Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/tools/content-save.ts
git commit -m "feat: version content in pipeline storage on update"
```

---

## Task 4: Auto-humanize + auto-review at tool level

**Files:**
- Modify: `src/tools/content-save.ts` (save action, lines 144-222)

**Step 1: Add humanize import**

Add at top of content-save.ts:

```typescript
import { executeHumanize } from "./humanize.js";
```

**Step 2: Add auto-humanize + auto-review after save**

After the existing save action's return block (line 204-221), restructure to run humanize before returning. Replace the return block with:

```typescript
  // Auto-humanize (tool-level enforcement — LLM cannot skip this)
  let humanizeResult: Record<string, unknown> | null = null;
  try {
    humanizeResult = await executeHumanize({
      action: "humanize_zh",
      content_id: content.id,
      save_back: true,
      _dataDir: dataDir,
    }) as Record<string, unknown>;
  } catch {
    // Humanize failure should not block save
  }

  return {
    ok: true,
    content,
    humanized: humanizeResult?.ok ?? false,
    humanizeChanges: (humanizeResult as any)?.changeCount ?? 0,
    filePath: `${projectDir}/draft.md`,
    projectDir,
    pipelinePath: projectDir,
    legacyDir: `${effectiveDataDir}/contents/${content.id}`,
    openCommand: `open "${projectDir}"`,
    message: [
      `📄 内容已保存到 pipeline：`,
      `   草稿：${projectDir}/draft.md`,
      `   元数据：${projectDir}/meta.yaml`,
      `   版本：${projectDir}/draft-v1.md`,
      `   自动去AI味：${humanizeResult?.ok ? "✅ 已处理" : "⚠️ 跳过"}`,
      ``,
      `打开文件夹：open "${projectDir}"`,
      `查看草稿：cat "${projectDir}/draft.md"`,
    ].join("\n"),
  };
```

Note: Auto-review is LLM-driven (content-review skill reads content and evaluates). It cannot be programmatically called from tool code since it requires LLM judgment. The humanize step IS programmatic (regex transforms). So we enforce humanize at tool level, and keep review as a mandatory skill instruction. This is the correct split.

**Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/tools/content-save.ts
git commit -m "feat: auto-humanize at tool level after content save"
```

---

## Task 5: Add completion rate micro-techniques to HAMLETDEER.md

**Files:**
- Modify: `HAMLETDEER.md` (after Clock Audit Checklist section, ~line 404)

**Step 1: Add new subsection after Clock Audit Checklist**

Insert after the Clock Audit Checklist section (after line 404):

```markdown
### Micro-Retention Techniques (完播率微操)

The Clock Theory handles macro rhythm — bang moments at 25% intervals. These micro-techniques handle the spaces BETWEEN bang moments, preventing drop-off within each quarter.

**1. Open Loop (开放循环)**
Raise a question or promise early, delay the answer. The viewer's brain cannot leave an unanswered question.
- "后面我会告诉你为什么这招最管用"
- "等下看到第三点你就明白了"
- Place at least one open loop in the first 25% that resolves in the last 25%.

**2. Curiosity Gap (信息缺口)**
Every 30 seconds (or every 2-3 paragraphs in text), create a micro-moment of "what's next?"
- Transition with tension, not summary: "但这还不是最离谱的" instead of "接下来我们看"
- End paragraphs with forward momentum, never with closure.

**3. Visual Anchor (视觉锚点)**
In text content: insert a standalone high-density sentence between paragraphs — a quote, a stat, a one-liner that stops the scroll.
In video: a text overlay, a visual cut, a change in framing.
- "说白了：AI不是来替你干活的，是来替你做决定的。"
- These anchors also become the screenshot/share moments.

**4. Rhythm Break (断裂感)**
Long paragraphs build inertia. A sudden ultra-short sentence snaps attention back.
- Three sentences of explanation, then: "错。"
- Build context, then: "但这不重要。"
- The break itself IS the retention device. Use sparingly — max 2-3 per piece.

**Application rule:** Every script must use at least 2 of these 4 techniques. Annotate which technique is used and where in the script.
```

**Step 2: Commit**

```bash
git add HAMLETDEER.md
git commit -m "feat: add micro-retention techniques to Clock Theory"
```

---

## Task 6: Rewrite write-script SKILL.md with full methodology

**Files:**
- Modify: `skills/write-script/SKILL.md` (full rewrite of steps 3-5)

This is the largest task. The new SKILL.md keeps the same structure but injects concrete methodology into each step.

**Step 1: Rewrite the skill**

Replace the full content of `skills/write-script/SKILL.md` with:

```markdown
---
name: write-script
description: |
  Write one complete content draft for Chinese social media. Activate when user asks to write a post, create content, draft an article, or produce copy. This is the executor — it does the actual writing.
---

# Write Script

> Executor skill. Single responsibility: generate one complete original script and save it.

## Prerequisites

Before writing, load these reference documents:
- `HAMLETDEER.md` — Content philosophy, HKRR framework, Clock Theory, Micro-Retention Techniques
- `skills/title-craft/SKILL.md` — Title methodology (8 types + quality checklist)

For video scripts: apply the **Clock Theory** from HAMLETDEER.md. Map the script to clock positions (12/3/6/9) and ensure every position has a bang moment. Short-form video: pick ONE HKRR element and commit. Long-form: combine all four.

## Steps

1. **Load style & memory context:**

   a. Read `~/.autocrew/STYLE.md` — absorb brand voice, personality, boundaries.
   b. Read `~/.autocrew/MEMORY.md` — check for writing preferences, past feedback, audience persona.
   c. Read `~/.autocrew/creator-profile.json` — check `styleCalibrated`, `platforms`, `writingRules`, `contentPillars`.
   d. If none exist, proceed with sensible defaults and note that style calibration is recommended.

2. **Content positioning check:**

   a. Identify which **content pillar** this content belongs to (from `creator-profile.json` → `contentPillars`).
   b. If no pillar match, ask the user: "这条内容属于你的哪个内容支柱？" and list available pillars.
   c. Load the pillar's `targetPersona`, `toneGuide`, and `exampleAngles` as writing context.
   d. If `contentPillars` is not configured, skip this step and note that content positioning is recommended.

3. **Traffic hypothesis (MANDATORY):**

   Before writing, state the hypothesis for this content:
   - "I believe [this angle/hook/format] will [expected outcome] because [reason]"
   - Classify: `title_test` / `hook_test` / `format_test` / `angle_test`
   - If testing against a previous content, note the `controlRef` (content ID being compared to)

   If the user doesn't provide a hypothesis, infer one from the topic and state it explicitly.

4. If a topic was specified, load its details via `autocrew_topic` action="list" and find the matching topic.

5. **Check for relevant teardowns:**

   Search `~/.autocrew/data/pipeline/intel/teardowns/` for teardown reports related to this topic. If found, use them as reference for what works in this space.

6. **Write the script:**

   a. **Hook** — pick the ONE strongest type for this topic:

   | Type | When to use | Example pattern |
   |------|-------------|-----------------|
   | Pain point | Audience has an obvious unresolved frustration | "XX最大的问题不是YY，而是ZZ" |
   | Suspense | Topic has a counterintuitive truth or surprising data | "我花了X万测试，结果发现…" |
   | Ideal state | Topic sells a desirable outcome | "X个月后，我再也不用YY了" |
   | Emotional resonance | Topic touches identity, belonging, or aspiration | "每个做XX的人都经历过这一刻" |
   | Contrast | Clear gap between common belief and reality | "别人XX，你却在YY" |

   Write 1-3 sentences. NEVER open with "哈喽大家好", "你有没有想过", or any generic greeting.

   b. **Body** — the core content. NOT a list of points. A conversation.

   **Writing rules (non-negotiable):**
   - Write like you're talking to ONE person sitting across from you, not lecturing to a crowd.
   - Vary sentence length deliberately: 3-4 short sentences, then one longer one. Then a one-word sentence. "真的。"
   - Each claim needs: why it's true + concrete example (named, specific, verifiable when possible).
   - Total body: 800-1500 characters (text) or platform-specific limit.

   **Anti-patterns (NEVER do these):**
   - ❌ "总而言之" / "综上所述" / "值得一提的是" — essay transitions that kill conversational tone
   - ❌ "首先…其次…最后…" — numbered structure that screams AI/lecture
   - ❌ Balanced "一方面…另一方面…" hedging — pick a side
   - ❌ Lists of exactly 5 items — AI signature pattern
   - ❌ Every paragraph same length — real people write unevenly
   - ❌ Generic examples ("某个企业", "一家公司") — name it or don't use it

   **Must-include elements:**
   - 1-2 expectation-breaking twists (contrarian flip, data bomb)
   - 1-2 interaction hooks (questions, "你猜怎么着", comment prompts)
   - HKRR annotation: for each section, note which HKRR element is active (in your planning, not in output)

   **Micro-retention techniques (use at least 2):**
   - **Open Loop**: raise a question early, resolve it later — "后面告诉你为什么"
   - **Curiosity Gap**: end paragraphs with forward momentum — "但这还不是最离谱的"
   - **Visual Anchor**: standalone one-liner between paragraphs — a quotable insight
   - **Rhythm Break**: sudden short sentence after buildup — "错。" / "但这不重要。"

   c. **Comment triggers (MANDATORY — annotate 1-2):**

   After writing the body, identify and annotate comment trigger points:

   | Type | What it does | Example |
   |------|-------------|---------|
   | Controversy plant | Leave a debatable opinion | "我知道很多人不同意，但我觉得XX根本没用" |
   | Unanswered question | Raise but don't fully answer | "至于为什么大厂不这么做？评论区聊" |
   | Quote hook | One sentence worth screenshotting | "AI不是来替你干活的，是来替你做决定的" |

   Record as: `commentTriggers: [{ type: "controversy", position: "paragraph 3" }]`

   d. **CTA** — 1-2 sentences guiding a specific action (save/comment/follow).
   Must connect to the content's value — "收藏这条，下次用得上" beats "觉得有用就点赞".

   e. **Title — generate 3-5 candidates using title formulas:**

   | Formula | Pattern | Example |
   |---------|---------|---------|
   | Number + Result | 数字+具体结果 | "用了3个月AI，我把团队从12人砍到3人" |
   | Contrarian | 反直觉声明 | "AI写的代码比人快10倍，但我劝你别用" |
   | Identity + Pain | 身份标签+痛点 | "传统老板看过来：这3种AI项目100%是坑" |
   | Curiosity Gap | 悬念缺口 | "花了20万做AI系统，结果…" |
   | Contrast | 对比结构 | "别人用AI赚钱，你用AI亏钱，差在哪？" |
   | Resonance Question | 共鸣提问 | "为什么你学了那么多AI课，还是不会用？" |

   Rules:
   - Generate 3-5 candidates, annotate which formula each uses.
   - Also call `generateForPlatform(baseTopic, platform)` from title-hashtag.ts for additional variants.
   - Pick the best as primary. 15-25 characters. Can include emoji if it adds value.
   - If `web_search` is available, search 2-3 trending keywords and embed 1 naturally.

   f. **Hashtags** — generate platform-specific hashtags:
   - Call `generateHashtags(topic, platform, tags)` from `title-hashtag.ts`.
   - Append hashtags to the body (for platforms that use inline hashtags like XHS/Douyin).
   - Save hashtags separately in the `hashtags` field.

   g. **Clock mapping (video content):**
   Before finalizing, map the script to clock positions:

   | Clock | Content section | Bang moment type | HKRR element |
   |-------|----------------|-----------------|-------------|
   | 12:00 | [your hook] | [e.g., pattern break] | [e.g., Resonance] |
   | 3:00 | [paragraph X] | [e.g., data bomb] | [e.g., Knowledge] |
   | 6:00 | [paragraph Y] | [e.g., framework reveal] | [e.g., Knowledge] |
   | 9:00 | [CTA section] | [e.g., audience mirror] | [e.g., Resonance] |

7. **Self-review before saving** (fix any failure, don't just check):
   - [ ] 800+ characters total?
   - [ ] Contains at least 2 concrete examples or scenarios (not vague claims)?
   - [ ] Has a non-obvious insight or twist?
   - [ ] Tone matches STYLE.md profile (if available)?
   - [ ] No generic greetings, no essay-style paragraphs?
   - [ ] No anti-pattern violations (总而言之, 首先其次最后, balanced hedging)?
   - [ ] Body is plain text with blank-line separators (no markdown headers)?
   - [ ] Title within platform character limit? Uses a title formula?
   - [ ] At least 1 comment trigger annotated?
   - [ ] At least 2 micro-retention techniques used?
   - [ ] Hypothesis stated?
   - [ ] Content pillar specified (if pillars configured)?
   - [ ] Hashtags generated and relevant?

8. **Save via tool:**
   ```json
   {
     "action": "save",
     "title": "The single best title (no emoji in title field)",
     "body": "Full script as plain text. Blank lines between sections.",
     "platform": "xiaohongshu",
     "topicId": "topic-xxx (if based on a topic)",
     "tags": ["tag1", "tag2"],
     "hashtags": ["#标签1", "#标签2"],
     "status": "draft"
   }
   ```

   Note: Auto-humanize runs automatically inside the save tool. You do NOT need to call humanize separately.

9. **Auto-review (MANDATORY — runs silently):**
   - After saving, ALWAYS run content review:
     ```json
     { "action": "full_review", "content_id": "<saved-id>", "platform": "<platform>" }
     ```
   - If review passes → proceed to output.
   - If review finds issues → auto-fix what can be fixed, then proceed to output.
   - Do NOT ask the user "要审核吗?" — just do it.

10. **Output to user:**
    Show the complete draft in chat, including:
    - Title (with 2-3 alternative variants + formula annotations)
    - Content pillar tag
    - Hypothesis
    - Full body text
    - Comment trigger annotations
    - Micro-retention technique annotations
    - Hashtags
    - Clock mapping (for video)
    - Review result summary (pass/issues found)
    - **File location**:
      > 📄 内容已保存到：`~/.autocrew/contents/{content-id}/draft.md`
      > 打开方式：在终端执行 `open ~/.autocrew/contents/{content-id}/` 或用 Obsidian 打开 `~/.autocrew/` 文件夹
    Then:
    > 要修改的话直接说，或者确认后我帮你标记为待发布。

11. **If adaptation is needed:**
    - Do not just trim one draft for another platform.
    - Use `platform-rewrite` / `autocrew_rewrite` to create the first platform-native version.

## Platform-Specific Adjustments

| Platform | Chars | Style notes |
|----------|-------|-------------|
| xiaohongshu | 300-1000 | Emoji-rich, casual, hashtags at end (5-15) |
| douyin | Script format | [Scene] + [Voiceover] + [Text overlay], hook in 3s |
| wechat_mp | 1500-3000 | Subheadings every 300-500 chars, more structured |
| wechat_video | 300-800 | Educational tone, include text summary |
| bilibili | 500-2000 | 年轻化表达，可以用梗，【】标注类型 |

## Title & Hashtag Integration

The `title-hashtag.ts` module provides:
- `generateTitleVariants(topic, platform)` → 3-5 title variants with style labels
- `generateHashtags(topic, platform, tags)` → deduplicated, platform-limited hashtags
- `generateForPlatform(topic, platform)` → titles + hashtags + tips in one call

Always use these for structured title/hashtag generation. The AI agent refines the output — these are starting points, not final answers.

## Error Handling

| Failure | Action |
|---------|--------|
| Style/Memory files missing | Write with sensible defaults. Suggest running style-calibration. |
| Topic not found | Ask user for topic details directly. |
| Save fails | Output the content in chat so user can copy it. Retry save once. |
| Review fails to run | Save the draft anyway. Note that review was skipped. |
| title-hashtag returns empty | Fall back to manual title + basic hashtags from tags. |
| Content pillars not configured | Skip pillar check, suggest configuring pillars. |
| No teardowns found | Skip reference step, write from scratch. |
```

**Step 2: Commit**

```bash
git add skills/write-script/SKILL.md
git commit -m "feat: rewrite write-script with full content methodology"
```

---

## Task 7: Update content-review SKILL.md

**Files:**
- Modify: `skills/content-review/SKILL.md`

**Step 1: Add new checks to the review pipeline**

Add these new check sections. Insert after Step 4 (质量评分), before Step 5 (输出审核报告):

```markdown
### Step 4.5: 标题公式检查

检查标题是否命中至少一个标题公式：

| Formula | Pattern |
|---------|---------|
| Number + Result | 包含数字+具体结果 |
| Contrarian | 反直觉/反常识声明 |
| Identity + Pain | 身份标签+痛点 |
| Curiosity Gap | 悬念/未完结 |
| Contrast | 对比结构 |
| Resonance Question | 共鸣式提问 |

- 命中 1+ 个公式 → ✅
- 未命中任何公式 → ⚠️ 建议优化标题

### Step 4.6: 评论触发点检查

检查内容是否包含至少 1 个评论触发点：

- 争议埋点（debatable opinion）
- 未答问题（invites discussion）
- 金句钩子（screenshot-worthy quote）

- 有 1+ 个触发点 → ✅
- 无触发点 → ⚠️ 建议添加，评论量影响算法推荐

### Step 4.7: 完播率微操检查

检查是否使用了至少 2 种微观留人技巧：

- 开放循环（Open Loop）
- 信息缺口（Curiosity Gap）
- 视觉锚点（Visual Anchor）
- 断裂感（Rhythm Break）

- 使用 2+ 种 → ✅
- 使用 1 种 → ⚠️ 建议增加
- 未使用 → ❌ 缺乏留人手段

### Step 4.8: 流量假设检查

检查内容是否有流量假设：

- `hypothesis` 字段存在且非空 → ✅
- `hypothesis` 缺失 → ⚠️ 建议补充，无假设无法形成数据闭环

### Step 4.9: 内容支柱对齐检查

如果 creator-profile.json 配置了 `contentPillars`：

1. 检查这条内容是否标注了所属支柱
2. 检查最近 10 条内容的支柱分布是否偏离目标 `contentRatio`
   - 偏离 <15% → ✅ 分布健康
   - 偏离 15-30% → ⚠️ 建议调整下一条内容方向
   - 偏离 >30% → ❌ 内容方向严重偏离定位
```

Also update the Clock Audit (Step 0) to add micro-technique check. After the existing HKRR alignment checkbox:

```markdown
- [ ] 微操技巧 — 是否在时钟位之间使用了至少 2 种微观留人技巧（开放循环/信息缺口/视觉锚点/断裂感）？
```

Update the report template in Step 5 to include the new checks.

**Step 2: Commit**

```bash
git add skills/content-review/SKILL.md
git commit -m "feat: add title formula, comment trigger, micro-retention, hypothesis, and pillar checks to content-review"
```

---

## Task 8: Create teardown skill

**Files:**
- Create: `skills/teardown/SKILL.md`

**Step 1: Create skill directory**

```bash
mkdir -p skills/teardown
```

**Step 2: Write the skill file**

```markdown
---
name: teardown
description: |
  拆解对标内容 — 用户粘贴一段文案，输出结构化拆解报告。分析钩子、HKRR、时钟节奏、评论触发、微操技巧。结果存入 intel 系统供创作参考。
trigger: 当用户说"拆解"、"teardown"、"分析这条"、"对标分析"时触发
---

# Competitive Teardown（对标拆解）

> 免费版：分析用户粘贴的文案。Pro 版（待实现）：通过 Chrome Relay 抓取视频/账号数据。

## 触发方式

用户说 "拆解这条内容" / "teardown" / "帮我分析对标" 并粘贴一段文案。

## 前置加载

- `HAMLETDEER.md` — HKRR 框架、Clock Theory、Micro-Retention Techniques、Bang Moment Types
- `~/.autocrew/creator-profile.json` — 用于对比自己的定位

## 拆解流程

### Step 1: 基本信息提取

- 预估平台（根据文案风格/emoji/hashtag 特征）
- 预估内容类型（图文 / 视频脚本 / 长文）
- 字数统计

### Step 2: 钩子分析

- 开头类型：Pain point / Suspense / Ideal state / Emotional resonance / Contrast / 其他
- 标题公式匹配：Number+Result / Contrarian / Identity+Pain / Curiosity Gap / Contrast / Resonance Question / 无匹配
- 钩子强度评分（0-10）

### Step 3: HKRR 评分

对四个维度分别打分（0-10）：

| 维度 | 评分 | 说明 |
|------|------|------|
| Happiness | X/10 | 是否有趣/有笑点？ |
| Knowledge | X/10 | 是否有增量信息/方法论？ |
| Resonance | X/10 | 是否触达情绪/身份认同？ |
| Rhythm | X/10 | 节奏是否有变化？能否持续吸引？ |

标注最强维度。

### Step 4: Clock 映射

将内容按比例映射到时钟位，分析每个位置：

| Clock | 内容段落 | Bang moment 类型 | 效果评估 |
|-------|---------|-----------------|---------|
| 12:00 | ... | ... | 强/弱/缺失 |
| 3:00 | ... | ... | 强/弱/缺失 |
| 6:00 | ... | ... | 强/弱/缺失 |
| 9:00 | ... | ... | 强/弱/缺失 |

### Step 5: 评论触发点识别

- 争议埋点：在哪里？什么话题？
- 未答问题：有没有故意留白？
- 金句钩子：哪句最值得截图？

### Step 6: 微操技巧识别

- 开放循环：有没有？在哪里？
- 信息缺口：段落结尾有没有前向动力？
- 视觉锚点：有没有高密度独立金句？
- 断裂感：有没有突然的超短句？

### Step 7: 一句话总结

"这条内容有效/无效，核心原因是 ___"

### Step 8: 可借鉴点

列出 2-3 个可以应用到自己内容的具体技巧。

## 保存拆解结果

将拆解报告保存到 intel 系统：

```bash
~/.autocrew/data/pipeline/intel/teardowns/{slug}-{date}.md
```

YAML frontmatter:
```yaml
---
title: "拆解: {原内容标题或前20字}"
type: teardown
platform: {预估平台}
hookType: {钩子类型}
dominantHKRR: {最强HKRR维度}
hookScore: {0-10}
overallScore: {0-10}
createdAt: {ISO timestamp}
tags: [teardown, {平台}]
---
```

## 输出格式

```markdown
## 🔍 对标拆解报告

**内容摘要：** {前50字}...
**预估平台：** {platform}
**字数：** {count}

### 钩子分析
- 类型：{hook type}
- 公式：{title formula or 无匹配}
- 强度：{score}/10
- 评价：{一句话评价}

### HKRR 评分
| H | K | R | R |
|---|---|---|---|
| {n}/10 | {n}/10 | {n}/10 | {n}/10 |
**最强维度：** {element}

### Clock 映射
{table}

### 评论触发点
{list}

### 微操技巧
{list}

### 💡 总结
{一句话总结}

### 🎯 可借鉴
{2-3 bullet points}
```

向用户确认后保存。

## 与 write-script 联动

write-script 在创作时会自动搜索 `pipeline/intel/teardowns/` 目录，查找与当前主题相关的拆解报告作为参考。无需手动操作。
```

**Step 3: Commit**

```bash
git add skills/teardown/SKILL.md
git commit -m "feat: create teardown skill for competitive content analysis"
```

---

## Task 9: Create content-attribution skill

**Files:**
- Create: `skills/content-attribution/SKILL.md`

**Step 1: Create skill directory**

```bash
mkdir -p skills/content-attribution
```

**Step 2: Write the skill file**

```markdown
---
name: content-attribution
description: |
  内容归因分析 — 对已发布内容的表现数据进行归因，提炼学习，反哺创作。当平台数据回收后自动触发，或用户手动要求分析。
trigger: 当用户说"分析数据"、"这条内容表现怎么样"、"归因"、"复盘"时触发
---

# Content Attribution（内容归因）

> 内容飞轮的核心环节：数据 → 归因 → 学习 → 下一条更好。

## 触发方式

1. Chrome Relay 回收平台数据后自动建议执行（待实现）
2. 用户手动提供数据并要求分析
3. 用户说 "复盘" / "这条效果怎么样"

## 归因流程

### Step 1: 加载内容和数据

1. 获取内容详情：`autocrew_content action=get id={content_id}`
2. 获取 performance_data（如果已录入）
3. 加载内容的 hypothesis 和 experimentType

### Step 2: 表现评级

根据平台基准和历史数据（如果有）：

| 评级 | 条件 |
|------|------|
| 🔥 爆款 (viral) | 数据显著超出历史均值 2x+ |
| ✅ 达标 (on_target) | 数据在历史均值 0.8x-2x 范围 |
| ⚠️ 低于预期 (below_expectation) | 数据低于历史均值 0.8x |

如果没有历史数据，让用户自评或提供平台同类内容基准。

### Step 3: 核心归因

分析内容本身 + 数据表现，给出单一核心归因（不要给多个原因，强制选最重要的一个）：

| 归因 | 判断依据 |
|------|---------|
| strong_title | 标题点击率高，但完播率/阅读率一般 |
| good_hook | 前3秒/前段留存高 |
| right_topic | 选题命中了当前热点或受众痛点 |
| timing | 发布时间恰好命中流量高峰 |
| luck | 以上都不突出，可能被算法随机推荐 |

### Step 4: 验证假设

对比内容的 `hypothesis` 和实际数据：

- **confirmed**: 数据支持假设
- **rejected**: 数据否定假设
- **inconclusive**: 数据不足以判断

### Step 5: 提炼一句话学习

格式："{具体发现}，在{平台}上对{人群}有效/无效"

例如：
- "反常识标题在小红书上完播率+40%，对王总人群有效"
- "纯方法论内容在抖音上完播率低，需要加故事包装"

### Step 6: 保存归因

更新内容的 meta：

```json
{
  "action": "update",
  "id": "{content_id}",
  "performance_data": { "views": N, "likes": N, ... }
}
```

归因结果存入 pipeline meta.yaml 的 `performanceLearnings[]`。

### Step 7: 检查学习沉淀阈值

如果 `performanceLearnings` 已积累 5+ 条：
1. 扫描所有 learnings，寻找重复出现的 pattern
2. 发现 pattern 后提示用户确认
3. 确认后写入 `creator-profile.json` 的 `writingRules[]`：
   ```json
   {
     "rule": "{提炼的规则}",
     "source": "auto_distilled",
     "confidence": 0.8,
     "createdAt": "{ISO timestamp}"
   }
   ```

## 输出格式

```markdown
## 📊 内容归因报告

**内容：** {title} ({content_id})
**平台：** {platform}
**发布时间：** {published_at}

### 数据概览
| 指标 | 数值 | vs 均值 |
|------|------|---------|
| 播放量 | {N} | {+/-}% |
| 完播率 | {N}% | {+/-}% |
| 点赞 | {N} | {+/-}% |
| 收藏 | {N} | {+/-}% |
| 评论 | {N} | {+/-}% |

### 表现评级：{🔥/✅/⚠️} {rating}

### 核心归因：{attribution}
{一段解释}

### 假设验证
- 假设：{hypothesis}
- 结果：{confirmed/rejected/inconclusive}
- {解释}

### 💡 一句话学习
{learning}

### 📝 累计学习 ({N}/5 → 达到阈值自动提炼规则)
{list of recent learnings}
```
```

**Step 3: Commit**

```bash
git add skills/content-attribution/SKILL.md
git commit -m "feat: create content-attribution skill for performance flywheel"
```

---

## Task 10: Ensure teardown intel storage directory exists

**Files:**
- Modify: `src/storage/pipeline-store.ts` (initPipeline function)

**Step 1: Find the initPipeline function and add teardowns subdirectory**

Read the `initPipeline` function in pipeline-store.ts and add `teardowns` as a subdirectory under `intel/`.

In the `initPipeline` function, after creating the intel directory, add:

```typescript
await fs.mkdir(path.join(intelDir, "teardowns"), { recursive: true });
```

**Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/storage/pipeline-store.ts
git commit -m "feat: add teardowns subdirectory to pipeline intel storage"
```

---

## Task 11: Update content-save schema for new fields

**Files:**
- Modify: `src/tools/content-save.ts` (schema + save action)

**Step 1: Add hypothesis fields to schema**

Add to `contentSaveSchema` after the `diff_note` field:

```typescript
  hypothesis: Type.Optional(Type.String({ description: "Traffic hypothesis: what this content tests and expected outcome" })),
  experiment_type: Type.Optional(Type.Unsafe<string>({
    type: "string",
    enum: ["title_test", "hook_test", "format_test", "angle_test"],
    description: "Type of experiment this content represents",
  })),
  control_ref: Type.Optional(Type.String({ description: "Content ID this is being A/B tested against" })),
  content_pillar: Type.Optional(Type.String({ description: "Which content pillar this belongs to" })),
  comment_triggers: Type.Optional(Type.Array(
    Type.Object({
      type: Type.Unsafe<string>({ type: "string", enum: ["controversy", "unanswered_question", "quote_hook"] }),
      position: Type.String(),
    }),
    { description: "Comment engineering trigger points" },
  )),
```

**Step 2: Pass new fields to pipeline meta in save action**

In the save action, update the `meta` object construction to include:

```typescript
  const meta: ProjectMeta = {
    title,
    domain: "",
    format: platform || "article",
    createdAt: now,
    sourceTopic: "",
    intelRefs: [],
    versions: [{ file: "draft-v1.md", createdAt: now, note: "initial draft" }],
    current: "draft-v1.md",
    history: [{ stage: "drafting", entered: now }],
    platforms: platform ? [{ format: platform, status: "drafting" }] : [],
    hypothesis: (params.hypothesis as string) || undefined,
    experimentType: (params.experiment_type as ProjectMeta["experimentType"]) || undefined,
    controlRef: (params.control_ref as string) || undefined,
    contentPillar: (params.content_pillar as string) || undefined,
    commentTriggers: (params.comment_triggers as ProjectMeta["commentTriggers"]) || undefined,
  };
```

**Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/tools/content-save.ts
git commit -m "feat: add hypothesis, pillar, and comment trigger fields to content save"
```

---

## Task 12: Final verification

**Step 1: Full type check**

Run: `npx tsc --noEmit`
Expected: PASS with 0 errors

**Step 2: Run existing tests**

Run: `npm test` (or whatever test command exists)
Expected: All existing tests pass

**Step 3: Verify skill files are valid YAML frontmatter**

Quick manual check: read first 5 lines of each new/modified skill file to ensure frontmatter is valid.

**Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "chore: fix any issues from final verification"
```

---

## Task Summary

| # | Task | Files | Type |
|---|------|-------|------|
| 1 | Extend ProjectMeta types | pipeline-store.ts | Code |
| 2 | Add ContentPillar to creator-profile | creator-profile.ts | Code |
| 3 | Version management on pipeline update | content-save.ts | Code |
| 4 | Auto-humanize at tool level | content-save.ts, humanize.ts | Code |
| 5 | Micro-retention techniques | HAMLETDEER.md | Docs |
| 6 | Rewrite write-script skill | write-script/SKILL.md | Skill |
| 7 | Update content-review skill | content-review/SKILL.md | Skill |
| 8 | Create teardown skill | teardown/SKILL.md | Skill |
| 9 | Create content-attribution skill | content-attribution/SKILL.md | Skill |
| 10 | Teardown storage directory | pipeline-store.ts | Code |
| 11 | Schema + save with new fields | content-save.ts | Code |
| 12 | Final verification | All | Verify |

**Dependency order:** Task 1 → Tasks 2-5 (parallel) → Tasks 6-9 (parallel) → Tasks 10-11 → Task 12
