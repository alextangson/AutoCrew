---
name: write-script
description: |
  Write one complete content draft for Chinese social media. Activate when user asks to write a post, create content, draft an article, or produce copy. This is the executor — it does the actual writing.
---

# Write Script

> Executor skill. Single responsibility: generate one complete original script and save it.

## THE OPERATING SYSTEM — Read This Before Anything Else

These 5 principles override every other instruction in this file. When a specific rule
conflicts with a principle, the principle wins. When you're unsure what to do, return
to these principles. They are not suggestions — they are the mental model you run on
while writing.

```
1. EMPATHY FIRST
   You are not writing. You are sitting across from ONE person — the audiencePersona —
   having a conversation. They are scrolling on their phone, half-distracted, ready to
   swipe away in 2 seconds. Everything you write must earn the next 3 seconds of their
   attention. Before committing any sentence, simulate their reaction: do they feel
   curiosity, recognition, surprise, or relief? If a sentence triggers none of these —
   if the reader's inner voice says "so what?" or "I know this already" — delete it.
   The reader's emotional state is the only metric that matters mid-writing.

2. THEIR WORDS, NOT YOURS
   Every word must pass one test: would the reader say this to a friend over coffee?
   If no, replace it. You are matching THEIR vocabulary, not showcasing yours. The
   reader never thinks in abstractions — they think in scenes, faces, and feelings.
   When you catch yourself reaching for a "smart" word, stop. The smarter move is the
   simpler word. A concept the reader can't picture is a concept that doesn't exist.
   This applies to every language: Chinese, English, technical terms, metaphors. If
   the audiencePersona wouldn't use it, you can't use it.

3. SHOW THE MOVIE
   Abstractions are invisible. Stories are visible. "AI improves productivity" is
   invisible — the reader's brain generates no image. "She built an entire product
   in 3 weeks, alone, without writing a single line of code" — the reader sees a
   person, a timeline, a result. Every claim in your draft needs a SCENE: a face,
   a number, a moment in time. If you can't attach a scene to a claim, the claim
   is too abstract to include. Concreteness is not decoration — it IS the content.

4. TENSION IS OXYGEN
   Content without tension is content nobody finishes. The reader stays because they
   need to know what happens next. Every paragraph must either OPEN a question or
   CLOSE one. If a paragraph does neither — if it's just "information sitting there"
   — the reader's thumb is already moving to the next post. Tension can be explicit
   ("But why don't big companies do this?") or structural (a gap between what the
   reader assumed and what you're about to reveal). When you feel the energy dropping,
   you've lost tension. Inject a question, a contradiction, or a surprise immediately.

5. THE CREATOR IS THE PROOF
   The most persuasive evidence is not data or expert quotes — it's the creator saying
   "I did this, and here's what happened." The creator's lived experience is
   irreplaceable social proof. Third-party cases support the argument; the creator's
   own story IS the argument. Always lead with the creator's experience when available.
   Vulnerability beats authority: "I failed at this three times before it worked" is
   more compelling than "Studies show a 30% improvement." If the creator has relevant
   experience for this topic, it must appear in the draft — not as a footnote, but as
   the backbone.
```

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

1.5. **⚠️ 提取创作者自己的故事和经历（MANDATORY）:**

   创作者自己的亲身经历是最高级别的真实性素材 — 比任何第三方案例都有说服力。

   a. 从 MEMORY.md、creator-profile.json、对话上下文中，提取与当前主题相关的
      **创作者本人的经历、数据、案例**。例如：
      - 创作者自己做过什么项目？结果如何？
      - 创作者踩过什么坑？学到了什么？
      - 创作者有什么独特视角是别人没有的？

   b. 如果对话中创作者提到了自己的经历（"我做了两个独立站"、"我花了 3 个月…"），
      这些是**必须使用的一级素材**，不可以被第三方案例替代。

   c. 素材优先级（高→低）：
      1. 创作者自己的亲身经历（最高说服力，最强共鸣）
      2. 创作者认识的真人案例（有名有姓，可追溯）
      3. references/ 里的公开案例和数据
      4. LLM 知识库中的案例（最低优先级，尽量不用）

   d. 在 Phase A 骨架中标注哪些素材来自创作者本人。
      如果骨架里没有一条创作者自己的素材 → 重新审视，一定有可以用的。

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

   Search `~/.autocrew/data/pipeline/intel/_teardowns/` for teardown reports related to this topic. If found, use them as reference for what works in this space.

5.5. **⚠️ MANDATORY — Topic-specific research → populate `references/` BEFORE writing:**

   **Why this exists:** Writing from LLM memory alone produces generic, unverifiable content
   indistinguishable from a random chat response. Every claim, case study, name, and data
   point in a draft must trace back to a real source. This step is non-negotiable.

   **Step-by-step:**

   a.0. **Query wiki knowledge base (if wiki exists):**
      1. Check if `~/.autocrew/data/pipeline/wiki/index.md` exists. If not, skip to step a.
      2. Read `index.md` and find wiki pages whose title, aliases, or summary
         match the current topic's keywords or angle (fuzzy match, not exact).
      3. Read matched pages (max 5, prioritize by number of sources — more sources
         = more synthesized = more valuable).
      4. For each matched wiki page, write it as a reference file into the project's
         `references/` folder:
         - Filename: `wiki-{page-slug}.md`
         - Format: same as other reference files, but with `source: wiki/{page-slug}.md`
         - Set `relevance: 8` (synthesized knowledge is higher value than raw intel)
      5. Wiki-sourced references count toward the 6-reference minimum and can satisfy
         multiple angle-coverage categories (wiki pages are cross-source syntheses).
      6. If wiki already provides 4+ solid references, the subsequent intel queries
         (steps b-d) can be lighter — focus on filling angle gaps rather than full research.

   a. Compute the project slug early: `projectSlug = slugify(topic_title)`.
      References will live at `~/.autocrew/data/pipeline/drafting/{projectSlug}/references/`.
      mkdir it if needed (the save step will reuse the same dir).

   b. **Query the existing intel library first** (fast, free):
      ```json
      { "action": "list" }
      ```
      via `autocrew_intel`. Scan the returned items for any whose title/summary matches
      this topic's keywords or angle. If 3+ strong matches exist, you may skip step (c).

   c. **Pull fresh intel targeted at this topic** (only if the library is thin):
      ```json
      { "action": "pull", "keywords": ["<keyword 1>", "<keyword 2>", "<keyword 3>"] }
      ```
      Derive 3-5 keywords from the topic title/angle — specific phrases, not generic.
      Example: topic "vibe-coding 重新定义能力边界" → keywords like
      `["vibe-coding 案例", "非程序员 AI 工具 产品", "Cursor 文科生", "GitHub 趋势 独立开发者"]`.
      Avoid over-broad terms like "AI" alone.

   d. If `web_search` is available, run 2-4 additional targeted queries to find primary
      sources the intel collectors missed: news articles, product pages, creator interviews,
      concrete numbers. Prefer named examples over anonymous anecdotes.

   e. **Write each source as a reference file** into the project's `references/` folder.
      Use the `Write` tool. Filename: `{short-slug}.md`. Format (strict):
      ```markdown
      ---
      source: <url or intel ref>
      title: <original title>
      collected: <ISO timestamp>
      relevance: <1-10, how directly this informs the draft>
      ---

      ## 要点
      - <3-6 bullet points of the most useful facts/quotes/data>

      ## 可引用
      - <specific sentences, names, numbers you might cite verbatim>

      ## 角度
      - <what angle of the topic this source unlocks>
      ```

   f. **Minimum bar to proceed — both quantity AND angle coverage:**

      **Quantity:** at least **6 reference files** with `relevance ≥ 6`. Fewer than 6
      means you'll run out of fresh material by the middle of the draft and fall back to
      LLM-memory filler.

      **Angle coverage (all 4 categories must have ≥1 reference):**
      1. **具体案例/人物** — named individual or company with a traceable story
         (e.g., "腾讯文科生用 Cursor 3 个月做了约饭小程序")
      2. **数据/数字** — concrete numbers from a report, dashboard, or study
         (not "很多人", but "2000+ 员工在用" / "3000 万投资" / "涨薪 30%")
      3. **反面/争议观点** — a dissenting view, failure case, or counter-evidence
         (prevents the draft from becoming one-sided cheerleading)
      4. **趋势/背景** — market context, timeline, or "why now" signal
         (answers why this topic is worth writing about today, not last year)

      Think of it as 2+2+1+1 = 6 minimum. More is better. Duplicates in the same
      category do NOT count toward the other categories.

      If you cannot hit BOTH bars (6+ total AND all 4 angles covered), stop and tell
      the user honestly:
      > 我目前找到 N 条相关信息源，覆盖角度：{已覆盖的角度}。缺少：{缺失的角度}。
      > 不够支撑一篇有分量的文案。要不要我再调研一轮、换个切入角度、还是你直接补充几个你知道的案例？

      Do NOT proceed to writing on thin research. "写出来再说" is the failure mode
      this step exists to prevent.

   g. Record the reference filenames in working memory — Step 6 will cite them, and
      Step 8 will record them in `meta.yaml` via the save params.

6. **⚠️ 创作分两个阶段执行。不可跳过 Phase A 直接写正文。**

   **为什么分两阶段**：一口气从头写到尾会产出逻辑混乱、节奏平淡的流水账。
   先搭骨架（结构）再填肉（正文），确保每一段都有存在的理由。

   ---

   ## Phase A — 搭结构骨架（先想清楚再动笔）

   在写任何正文之前，必须先完成以下 5 个决策。输出为结构化的骨架文档，
   展示给用户确认后才进入 Phase B。

   **A1. 核心观点（一句话）**

   用一句话说清楚这篇内容的核心主张。不是主题，是观点。

   | ❌ 不是这样（主题） | ✅ 而是这样（观点） |
   |---|---|
   | "聊聊 vibe-coding" | "vibe-coding 重新定义的不是会不会写代码，是会不会想清楚问题" |
   | "AI 工具推荐" | "90% 的人用 AI 工具亏钱，因为他们把 AI 当员工而不是当合伙人" |
   | "创业经验分享" | "创业最大的坑不是没钱，是你以为自己想清楚了其实没有" |

   这个观点必须满足：
   - 有立场（不是两边讨好的"一方面...另一方面..."）
   - 有反直觉成分（读者看到会想"真的吗？"）
   - 能用 references 里的具体案例支撑

   **A2. 论证结构（观点的骨架）**

   确定论证链条：核心观点要通过什么逻辑路径让读者信服？

   ```
   核心观点: {一句话}
     │
     ├── 误区/共识切入: 大多数人以为___（读者的当前认知）
     │
     ├── 真相揭示: 但实际上___（反转，用数据或案例支撑）
     │     └── 证据: {来自 references/ 的具体案例/数据}
     │
     ├── 深入解释: 为什么会这样？因为___（给出底层逻辑）
     │     └── 证据: {来自 references/ 的第二个案例}
     │
     └── 行动指引: 所以你应该___（给读者一个可执行的 takeaway）
   ```

   论证结构不是唯一形式。以下几种都可以，选最适合这个观点的：
   - **误区→真相→行动**（适合反直觉观点）
   - **故事→提炼→框架**（适合经验分享）
   - **现象→归因→预判**（适合趋势分析）
   - **问题→拆解→方案**（适合教程类）

   **A3. Clock Theory 节点规划（4 个 bang moment）**

   ⚠️ **Clock Theory 是创作骨架，不是事后审计。** 先定 4 个 bang moment，
   然后围绕这 4 个点展开写。

   | 时钟位 | 内容功能 | 你的 bang moment | Bang 类型 | 来自哪个 reference |
   |--------|---------|-----------------|-----------|-------------------|
   | 12:00 (0%) | Hook — 3 秒决生死 | {具体写什么} | {数据炸弹/反转/故事/共鸣} | {ref} |
   | 3:00 (25%) | Escalation — 兑现 hook 的承诺 | {具体写什么} | {类型} | {ref} |
   | 6:00 (50%) | Payload — 核心价值交付 | {具体写什么} | {类型} | {ref} |
   | 9:00 (75%) | Climax — 最强一击 | {具体写什么} | {类型} | {ref} |

   每个 bang moment 必须具体到"写什么内容"，不能是"在这里放一个反转"这种空话。
   如果想不出 bang moment，说明这个论点不够强 — 回 A2 调整论证结构。

   **A4. HKRR 选择**

   短视频（<60s）：只选 1 个维度，全力打透。
   长内容（图文/长视频）：选 1 个主导 + 1 个辅助。

   ```
   主导维度: {H/K/R/R}
   理由: {为什么这个主题用这个维度最有效}
   辅助维度: {H/K/R/R 或 无}
   ```

   **A5. 微操技巧预埋**

   从 4 种微操技巧中选 2-3 种，标注在骨架的具体位置：

   | 技巧 | 埋在哪里 | 具体怎么用 |
   |------|---------|-----------|
   | Open Loop | {位置，如"hook 之后"} | {具体的悬念句} |
   | Curiosity Gap | {位置} | {具体的过渡句} |
   | Visual Anchor | {位置} | {具体的金句} |
   | Rhythm Break | {位置} | {具体的短句} |

   ---

   **输出骨架给用户确认：**

   ```
   📐 内容骨架：

   核心观点：{A1}
   论证结构：{A2 的链条}
   HKRR：主打 {A4}

   Clock 节点：
   🕛 12:00 Hook: {内容}
   🕐 3:00 Escalation: {内容}
   🕕 6:00 Payload: {内容}
   🕘 9:00 Climax: {内容}

   微操预埋：{A5 的技巧和位置}

   这个结构 OK 吗？确认后开始写正文。
   ```

   **等待用户确认。** 用户说 OK → 进入 Phase B。
   用户说要调整 → 修改骨架后再次确认。

   ---

   ## Phase B — 基于骨架填充正文

   ⚠️ **每一段正文必须服务于 Phase A 确定的骨架。** 如果写着写着偏离了
   论证结构或错过了 clock 节点，停下来对照骨架修正，不要硬写下去。

   **B1. Hook（12:00 位 bang moment）**

   写 1-3 句。从 A3 已经确定的 hook bang moment 展开。

   | Hook 类型 | 模式 |
   |-----------|------|
   | Pain point | "XX最大的问题不是YY，而是ZZ" |
   | Suspense | "我花了X万测试，结果发现…" |
   | Contrast | "别人XX，你却在YY" |
   | Identity | "每个做XX的人都经历过这一刻" |

   ❌ 绝对禁止："哈喽大家好" / "你有没有想过" / 任何通用问候

   **坏 hook vs 好 hook 对比：**
   ```
   ❌ 坏："今天聊聊 vibe-coding，这是一个很火的概念。"
         → 没有观点、没有冲突、没有理由继续看

   ✅ 好："我不会写代码。但我用 3 周时间，做了一个智能分类平台——
         自动识别图片、分类、智能推荐。不是外包给程序员做的，
         是她自己用 AI 工具一个人搞定的。"
         → 有具体案例、有反直觉（不会代码但做出了产品）、有悬念（怎么做到的）
   ```

   **B2. Body（3:00 → 6:00 → 9:00 的论证展开）**

   Follow the argument chain from A2. Each paragraph maps to a clock node from A3.

   Apply the Operating System principles throughout — they replace specific writing rules:
   - EMPATHY FIRST → earn the reader's next 3 seconds with every sentence
   - THEIR WORDS NOT YOURS → if the reader wouldn't say it, you can't write it
   - SHOW THE MOVIE → every claim needs a scene (face, number, moment)
   - TENSION IS OXYGEN → every paragraph opens or closes a question
   - THE CREATOR IS THE PROOF → lead with creator's own experience

   **Length:** No cap. Fear short, not long. If a case study deserves 200 words of vivid
   detail, give it 200 words. Readers leave because of boredom, not length. The only
   constraint: every sentence must have a reason to exist (advance argument, build emotion,
   provide evidence). No padding.

   **After each clock section, verify against skeleton:**
   - Does this paragraph serve the argument structure from A2?
   - Is the planned bang moment present and strong?
   - Are the pre-placed micro-retention techniques firing?
   - Apply EMPATHY FIRST: would the reader keep reading at this point? If not, rewrite
     before continuing.

   **B3. Comment triggers（评论触发）**

   在正文中自然嵌入 1-2 个评论触发点（不是单独加在最后）：

   | 类型 | 做法 | 例子 |
   |------|------|------|
   | 争议埋点 | 故意留一个可辩论的观点 | "AI 不会让你变成超人，它只是放大你已经有的东西。" |
   | 未答问题 | 提出但不完全回答 | "至于为什么大厂不这么做？评论区聊" |
   | 金句钩子 | 一句值得截图的话 | "想到了，就能做出来。这才是真正的能力边界变化。" |

   标注：`commentTriggers: [{ type: "controversy", position: "paragraph N" }]`

   **B4. CTA**

   1-2 句收尾。连接内容价值："收藏这条，下次用得上" > "觉得有用就点赞"。

   **B5. Title（3-5 个候选）**

   | 公式 | 模式 | 例子 |
   |------|------|------|
   | Number + Result | 数字+结果 | "用了3个月AI，我把团队从12人砍到3人" |
   | Contrarian | 反直觉 | "AI写的代码比人快10倍，但我劝你别用" |
   | Identity + Pain | 身份+痛点 | "传统老板看过来：这3种AI项目100%是坑" |
   | Curiosity Gap | 悬念 | "花了20万做AI系统，结果…" |
   | Contrast | 对比 | "别人用AI赚钱，你用AI亏钱，差在哪？" |

   15-25 字。标注每个候选用了什么公式。

   **B6. Hashtags**

   调用 `generateHashtags(topic, platform, tags)` 生成平台专用标签。

   ---

7. **Self-review — run the Operating System check**

   Re-read the entire draft once through. For each paragraph, verify the 5 principles:

   **EMPATHY FIRST check:** Read the draft as if you are the audiencePersona, scrolling
   on your phone. At every paragraph boundary ask: would I keep reading? If any point
   makes you think "so what?" or "I'd swipe away here" — rewrite that section.

   **THEIR WORDS NOT YOURS check:** Scan for any word the reader wouldn't use in casual
   conversation. Every term must pass the coffee-chat test.

   **SHOW THE MOVIE check:** Is every claim attached to a scene (face, number, moment)?
   Any paragraph that reads like a summary instead of a story needs a concrete example
   injected.

   **TENSION IS OXYGEN check:** Does every paragraph either open or close a question?
   Any paragraph that just "sits there" providing information without tension is a
   dropout point — add a question, contradiction, or surprise.

   **THE CREATOR IS THE PROOF check:** If the creator has relevant personal experience
   for this topic, is it in the draft? Not as a footnote — as the backbone?

   **Structure verification:**
   - [ ] 4 clock bang moments present and strong?
   - [ ] Argument chain from A2 complete — no missing steps?
   - [ ] HKRR dominant dimension consistent throughout?
   - [ ] ≥2 micro-retention techniques fired at planned positions?
   - [ ] ≥1 comment trigger embedded naturally?
   - [ ] Hypothesis, title, hashtags ready?

8. **Save via `autocrew_content` tool — THE ONLY ALLOWED WAY TO SAVE:**

   ⚠️ **CRITICAL — 绝对禁止用 Write 工具直接写 draft.md 文件。**
   `autocrew_content` save action 会同时创建 `draft.md`、`meta.yaml`、pipeline 项目结构、
   运行去AI味处理。用 Write 工具直接写文件会导致 meta.yaml 缺失、版本记录丢失、pipeline
   状态机断裂。如果你脑子里有一个"我先用 Write 写到文件，然后再..."的想法 — 停下来，
   那个想法是错的。唯一正确的路径是调用 `autocrew_content`。

   ```json
   {
     "action": "save",
     "title": "The single best title (no emoji in title field)",
     "body": "Full script as plain text. Blank lines between sections.",
     "platform": "xiaohongshu",
     "topicId": "topic-xxx (if based on a topic)",
     "tags": ["tag1", "tag2"],
     "hashtags": ["#标签1", "#标签2"],
     "status": "draft",
     "hypothesis": "I believe [angle] will [outcome] because [reason]",
     "experiment_type": "hook_test",
     "content_pillar": "AI落地避坑",
     "comment_triggers": [{"type": "controversy", "position": "paragraph 3"}]
   }
   ```

   Note: Auto-humanize runs automatically inside the save tool. You do NOT need to call humanize separately.

8.5. **⚠️ Post-save verification (MANDATORY):**

   After `autocrew_content` returns, verify these fields exist in the response:
   - `ok: true` — save succeeded
   - `filePath` — draft.md 路径
   - `projectDir` — pipeline 项目目录

   If ANY of these are missing or `ok: false`:
   - Do NOT proceed to output.
   - Do NOT fall back to Write tool.
   - Show the error to the user and ask them to retry.

   If save succeeded, do a quick sanity check — the response should contain `pipelinePath`.
   If it does, the pipeline project is properly initialized with meta.yaml and draft.md.

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

    **⚠️ IMPORTANT — Remember the `content_id` from the save result.** You will need it
    for any subsequent revision in this conversation.

11. **Handling revisions (MANDATORY — 不可只在聊天框里改):**

    When the user requests modifications to a saved draft ("改一改", "换个角度", "这里调整一下",
    "第二段重写", etc.), you MUST persist the revised content back to the pipeline. Never show
    a rewritten version in chat only — the draft file must stay in sync.

    Steps for every revision:

    a. Rewrite the full body (or title) incorporating the user's feedback. Re-check against
       the Step 7 self-review list — a revision is still a draft, same standards apply.

    b. Call `autocrew_content` with `action: "update"`:
       ```json
       {
         "action": "update",
         "id": "<content-id from the original save>",
         "title": "<updated title if changed, else original>",
         "body": "<full revised body — not a diff, the complete new text>",
         "diff_note": "<one-line summary of what changed and why, e.g. '换成悬念式开头，加 vibe-coding 具体案例'>"
       }
       ```
       The storage layer will archive the previous `draft.md` into an immutable
       `draft-v{N}.md` snapshot, then replace `draft.md` with your new body, and append
       the snapshot entry to `meta.yaml` → `versions`. After this:
       - `draft.md` always holds the newest revision
       - `draft-v1.md`, `draft-v2.md`, ... are frozen historical states (never modified)

    b.5. **If the user's revision changes the angle or adds new claims** (new companies,
         new data, new cases), go back to Step 5.5 and add more reference files BEFORE
         rewriting. New claims still need backing. Don't smuggle new unverified material in
         under the label "minor tweak".

    c. Confirm to the user that the new version is saved, and show the updated content.
       Example:
       > 已更新到 v2（`~/.autocrew/data/pipeline/drafting/{project}/draft.md`）。改动：{diff_note}

    d. If the revision is substantial (new angle, new hook, new structure), re-run
       `full_review` from Step 9 on the updated content before confirming.

    **Never do:** paste the revised content in chat without calling `update`. If you catch
    yourself about to show "这是修改后的版本..." without a tool call, stop and save first.

12. **If adaptation is needed:**
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
