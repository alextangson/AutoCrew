---
name: write-script
description: |
  Write one complete content draft for Chinese social media. Activate when user asks to write a post, create content, draft an article, or produce copy. This is the executor — it does the actual writing.
---

# Write Script

> Executor skill. Single responsibility: generate one complete original script and save it.

## Steps

1. Read `~/.autocrew/STYLE.md` — absorb brand voice, personality, boundaries.
   Read `~/.autocrew/MEMORY.md` — check for writing preferences, past feedback, audience persona.
   If neither exists, proceed with sensible defaults and note that style calibration is recommended.

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

   d. **Title** — ONE best title.
   - Use `web_search` to find 2-3 trending keywords on the target platform.
   - Embed 1 trending keyword naturally.
   - Create curiosity gap or promise a specific outcome.
   - 15-25 characters. Can include emoji if it adds value.

4. **Self-review before saving** (fix any failure, don't just check):
   - [ ] 800+ characters total?
   - [ ] Contains at least 2 concrete examples or scenarios (not vague claims)?
   - [ ] Has a non-obvious insight or twist?
   - [ ] Tone matches style profile (if available)?
   - [ ] No generic greetings, no essay-style paragraphs?
   - [ ] Body is plain text with blank-line separators (no markdown headers)?

5. **Save via tool:**
   ```json
   {
     "action": "save",
     "title": "The single best title (no emoji in title field)",
     "body": "Full script as plain text. Blank lines between sections.",
     "platform": "xiaohongshu",
     "topicId": "topic-xxx (if based on a topic)",
     "tags": ["tag1", "tag2"],
     "status": "draft"
   }
   ```

6. **Output to user:**
   Show the complete draft in chat, then:
   > 已保存为草稿。要修改的话直接说，或者确认后我帮你标记为待发布。

## Platform-Specific Adjustments

| Platform | Chars | Style notes |
|----------|-------|-------------|
| xiaohongshu | 300-1000 | Emoji-rich, casual, hashtags at end (5-15) |
| douyin | Script format | [Scene] + [Voiceover] + [Text overlay], hook in 3s |
| wechat_mp | 1500-3000 | Subheadings every 300-500 chars, more structured |
| wechat_video | 300-800 | Educational tone, include text summary |

## Error Handling

| Failure | Action |
|---------|--------|
| Style/Memory files missing | Write with sensible defaults. Suggest running style-calibration. |
| Topic not found | Ask user for topic details directly. |
| Save fails | Output the content in chat so user can copy it. Retry save once. |

## Changelog

- 2026-03-31: v1 — Adapted from Qingmo write-script.md + _writing-style.md. Removed backend API curl dependency. Uses autocrew_content tool. Merged writing style rules inline.
