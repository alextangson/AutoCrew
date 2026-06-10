---
name: write-script
description: |
  Write one complete content draft for Chinese social media. Activate when user asks to write a post, create content, draft an article, or produce copy. This is the executor — it does the actual writing.
---

# Write Script

> Executor skill. Single responsibility: generate one complete original script and save it.

## Steps

1. **Load style & memory context:**

   a. Read `~/.autocrew/STYLE.md` — absorb brand voice, personality, boundaries.
   b. Read `~/.autocrew/MEMORY.md` — check for writing preferences, past feedback, audience persona.
   c. Read `~/.autocrew/creator-profile.json` — check `styleCalibrated`, `platforms`, `writingRules`.
   d. If none exist, proceed with sensible defaults and note that style calibration is recommended.

2. **Research-Augmented Preparation:**

   Before writing, gather research context to inject real data:

   a. Use `web_search` to find 3-5 high-quality articles on the same topic
   b. From the research results:
      - Extract data points, statistics, and concrete examples
      - Detect structural patterns (listicle, how-to, myth-busting)
      - Generate a content outline with hook type, sections, and CTA
   c. Present the outline to the user for confirmation:
      > 基于调研，我建议这样的结构：
      > - Hook: {type} — {draft}
      > - 要点 1-N: {key points with supporting data}
      > - CTA: {style}
      > 确认开始写？还是调整大纲？
   d. User confirms → proceed to writing with research context injected
   e. User adjusts → update outline and re-confirm

   **Key principle:** Never write from nothing. Always have at least 2-3 real data points or examples.

3. If a topic was specified, load its details via `autocrew_topic` action="list" and find the matching topic.

4. **Write the script:**

   a-c. **Hook / Body / CTA** — 钩子库、结构骨架、平台调整全部以
   `src/modules/packs/koubo.ts`（知识口播赛道包）为唯一来源：先读取该文件，
   从 `hooks` 选 ONE 最强钩子类型，按 `structure.hook` / `structure.body` /
   `structure.cta` 的规则执行。

   d. **Title** — generate platform-optimized title variants using `title-hashtag.ts`:
   - Call `generateForPlatform(baseTopic, platform)` to get 3-5 title variants.
   - Pick the best variant as the primary title.
   - If `web_search` is available, also search 2-3 trending keywords and embed 1 naturally.
   - Title: 15-25 characters. Can include emoji if it adds value.

   e. **Hashtags** — generate platform-specific hashtags:
   - Call `generateHashtags(topic, platform, tags)` from `title-hashtag.ts`.
   - Append hashtags to the body (for platforms that use inline hashtags like XHS/Douyin).
   - Save hashtags separately in the `hashtags` field for structured access.

5. **Self-review before saving** (fix any failure, don't just check):
   按赛道包的 selfReview 清单逐项修正（不是只检查）—— 读 src/modules/packs/koubo.ts 的 selfReview 数组。

6. **Save via tool:**
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

7. **Auto-review (if style calibrated):**
   - Check `creator-profile.json` → if `styleCalibrated: true`, automatically run:
     ```json
     { "action": "full_review", "content_id": "<saved-id>", "platform": "<platform>" }
     ```
   - Show the review summary to the user.
   - If review passes → tell user "审核通过，可以直接发布或做平台改写".
   - If review fails → show fixes, ask user whether to auto-fix or manually adjust.

8. **Output to user:**
   Show the complete draft in chat, including:
   - Title (with alternative variants from title-hashtag)
   - Full body text
   - Hashtags
   - Review result (if auto-review ran)
   Then:
   > 已保存为草稿。要修改的话直接说，或者确认后我帮你标记为待发布。

9. **If adaptation is needed:**
   - Do not just trim one draft for another platform.
   - Use `platform-rewrite` / `autocrew_rewrite` to create the first platform-native version.

10. **Before final delivery:**
   - Run `humanizer-zh` / `autocrew_humanize` as the last pass when the text sounds generic, too smooth, or too essay-like.

## Platform-Specific Adjustments

以赛道包的 platformAdjustments 为准（src/modules/packs/koubo.ts）。

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

## Changelog

- 2026-04-01: v3 — Added RAW Engine integration (Research-Augmented Writing). Step 2 now gathers research context before writing.
- 2026-04-01: v2 — Integrated STYLE.md + title-hashtag.ts + auto-review after save. Added hashtags field, bilibili platform notes.
- 2026-03-31: v1 — Adapted from Qingmo write-script.md + _writing-style.md. Removed backend API curl dependency. Uses autocrew_content tool. Merged writing style rules inline.
- 2026-06-10: v4 — playbook 抽入 koubo 赛道包（声明式），SKILL 只保留流程编排。
