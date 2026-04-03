---
name: write-script
description: |
  Write one complete content draft for Chinese social media. Activate when user asks to write a post, create content, draft an article, or produce copy. This is the executor — it does the actual writing.
---

# Write Script

> Executor skill. Single responsibility: generate one complete original script and save it.

## Prerequisites

Before writing, load these reference documents:
- `HAMLETDEER.md` — Content philosophy, HKRR framework, Clock Theory
- `skills/title-craft/SKILL.md` — Title methodology (8 types + quality checklist)

For video scripts: apply the **Clock Theory** from HAMLETDEER.md. Map the script to clock positions (12/3/6/9) and ensure every position has a bang moment. Short-form video: pick ONE HKRR element and commit. Long-form: combine all four.

## Steps

1. **Load style & memory context:**

   a. Read `~/.autocrew/STYLE.md` — absorb brand voice, personality, boundaries.
   b. Read `~/.autocrew/MEMORY.md` — check for writing preferences, past feedback, audience persona.
   c. Read `~/.autocrew/creator-profile.json` — check `styleCalibrated`, `platforms`, `writingRules`.
   d. If none exist, proceed with sensible defaults and note that style calibration is recommended.

2. If a topic was specified, load its details via `autocrew_topic` action="list" and find the matching topic.

3. **Write the script:**

   a. **Hook** — pick the ONE strongest type for this topic:

   | Type | When to use |
   |------|-------------|
   | Pain point | Audience has an obvious unresolved frustration |
   | Suspense | Topic has a counterintuitive truth or surprising data |
   | Ideal state | Topic sells a desirable outcome |
   | Emotional resonance | Topic touches identity, belonging, or aspiration |
   | Contrast | Clear gap between common belief and reality |

   Write 1-3 sentences. NEVER open with "哈喽大家好", "你有没有想过", or any generic greeting.

   b. **Body** — 5-8 information points. Each point: **claim → why it's true → concrete example**.
   - Each point: 80-150 characters. Total body: 800-1500 characters.
   - Points build progressively — don't front-load the best stuff.
   - Include 1-2 expectation-breaking twists.
   - Include 1-2 interaction hooks (questions, "你猜怎么着", comment prompts).
   - NO essay-style paragraphs. Short sentences. One idea per sentence.

   c. **CTA** — 1-2 sentences guiding a specific action (save/comment/follow).
   Must connect to the content's value — "收藏这条，下次用得上" beats "觉得有用就点赞".

   d. **Title** — generate platform-optimized title variants using `title-hashtag.ts`:
   - Call `generateForPlatform(baseTopic, platform)` to get 3-5 title variants.
   - Pick the best variant as the primary title.
   - If `web_search` is available, also search 2-3 trending keywords and embed 1 naturally.
   - Title: 15-25 characters. Can include emoji if it adds value.

   e. **Hashtags** — generate platform-specific hashtags:
   - Call `generateHashtags(topic, platform, tags)` from `title-hashtag.ts`.
   - Append hashtags to the body (for platforms that use inline hashtags like XHS/Douyin).
   - Save hashtags separately in the `hashtags` field for structured access.

4. **Self-review before saving** (fix any failure, don't just check):
   - [ ] 800+ characters total?
   - [ ] Contains at least 2 concrete examples or scenarios (not vague claims)?
   - [ ] Has a non-obvious insight or twist?
   - [ ] Tone matches STYLE.md profile (if available)?
   - [ ] No generic greetings, no essay-style paragraphs?
   - [ ] Body is plain text with blank-line separators (no markdown headers)?
   - [ ] Title within platform character limit?
   - [ ] Hashtags generated and relevant?

5. **Save via tool:**
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

6. **Auto-humanize (MANDATORY — runs silently):**
   - After saving, ALWAYS run `autocrew_humanize` on the content. This is not optional.
   - Do NOT ask the user "要去AI味吗?" — just do it. De-AI is a quality baseline, not a feature.
   - Update the saved content with the humanized version.

7. **Auto-review (MANDATORY — runs silently):**
   - After humanizing, ALWAYS run content review:
     ```json
     { "action": "full_review", "content_id": "<saved-id>", "platform": "<platform>" }
     ```
   - If review passes → proceed to output.
   - If review finds issues → auto-fix what can be fixed, then proceed to output.
   - Do NOT ask the user "要审核吗?" — just do it.

8. **Output to user:**
   Show the complete draft in chat, including:
   - Title (with alternative variants from title-hashtag)
   - Full body text
   - Hashtags
   - Review result summary (pass/issues found)
   - **File location**: Tell the user exactly where the file is saved and how to open it:
     > 📄 内容已保存到：`~/.autocrew/contents/{content-id}/draft.md`
     > 打开方式：在终端执行 `open ~/.autocrew/contents/{content-id}/` 或用 Obsidian 打开 `~/.autocrew/` 文件夹
   Then:
   > 要修改的话直接说，或者确认后我帮你标记为待发布。

9. **If adaptation is needed:**
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

## Changelog

- 2026-04-01: v2 — Integrated STYLE.md + title-hashtag.ts + auto-review after save. Added hashtags field, bilibili platform notes.
- 2026-03-31: v1 — Adapted from Qingmo write-script.md + _writing-style.md. Removed backend API curl dependency. Uses autocrew_content tool. Merged writing style rules inline.
