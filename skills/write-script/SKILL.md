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

   Search `~/.autocrew/data/pipeline/intel/_teardowns/` for teardown reports related to this topic. If found, use them as reference for what works in this space.

5.5. **⚠️ MANDATORY — Topic-specific research → populate `references/` BEFORE writing:**

   **Why this exists:** Writing from LLM memory alone produces generic, unverifiable content
   indistinguishable from a random chat response. Every claim, case study, name, and data
   point in a draft must trace back to a real source. This step is non-negotiable.

   **Step-by-step:**

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
   - **Ground every factual claim in a reference file** from Step 5.5. If you cite a company,
     number, name, or case study, it MUST come from one of the `references/*.md` files you
     collected — not from LLM memory. If a claim has no reference backing, either find one
     now or cut the claim. "我编的例子" is a bug, not a feature.
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
   - [ ] **Every named entity/number/case in the draft traces back to a file in `references/`?**
   - [ ] **Reference angle coverage used in the draft** — the draft actually cites at least
         one reference from EACH of the 4 angle categories collected in Step 5.5.f
         (具体案例/人物, 数据/数字, 反面/争议观点, 趋势/背景). Collecting 6 references but
         only drawing from the "案例" bucket produces a single-sided draft — fix by
         weaving in at least one sentence grounded in each missing bucket.
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
     "status": "draft",
     "hypothesis": "I believe [angle] will [outcome] because [reason]",
     "experiment_type": "hook_test",
     "content_pillar": "AI落地避坑",
     "comment_triggers": [{"type": "controversy", "position": "paragraph 3"}]
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
