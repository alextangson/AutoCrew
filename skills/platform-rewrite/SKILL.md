---
name: platform-rewrite
description: |
  平台 native 改写 skill。把一个母稿改成不同平台的版本，强调"重写而不是裁剪"。支持单平台和多平台一键改写，自动生成各平台标题和 hashtag。
---

# Platform Rewrite

## Purpose

Turn one source draft into platform-native versions. Rewrite, don't trim.

Supported platforms: 小红书 · 抖音 · 公众号 · 视频号 · B站

## Rules

1. Never call a simple trim "adaptation".
2. Start from the strongest single angle in the source draft.
3. Generate the first structured platform version via `autocrew_rewrite`.
4. If the user asks for multiple platforms, use the **batch flow** (Step 2 below).
5. Run `humanizer-zh` before final delivery.

## Step 1 — Single Platform Rewrite

From an existing draft:

```json
{
  "action": "adapt_platform",
  "content_id": "content-xxx",
  "target_platform": "douyin",
  "save_as_draft": true
}
```

From raw text:

```json
{
  "action": "adapt_platform",
  "title": "原始标题",
  "body": "原始正文",
  "target_platform": "xiaohongshu"
}
```

After rewrite completes:

1. **Generate title variants + hashtags** for the target platform:
   - Use `title-hashtag.ts` → `generateForPlatform(topic, platform, { tags })`
   - Pick the best title variant, show all alternatives to user.
   - Attach hashtags to the saved draft via `autocrew_content` action="update":
     ```json
     { "action": "update", "id": "<new-content-id>", "hashtags": ["#tag1", "#tag2"] }
     ```

2. **Run humanizer** on the adapted text if it reads too smooth or generic.

3. **Show output** to user: adapted title, body, hashtags, and notes.

## Step 2 — Multi-Platform Batch Rewrite

When user says "帮我改成所有平台" or specifies 2+ platforms:

1. Determine target platforms. Default all 5 if user says "全平台":
   `["xiaohongshu", "douyin", "wechat_mp", "wechat_video", "bilibili"]`

2. **Generate titles + hashtags for all platforms in one call:**
   - Use `title-hashtag.ts` → `generateForAllPlatforms(baseTopic, platforms, { tags })`
   - This returns `PlatformTitleResult[]` with titles, hashtags, and tips per platform.

3. **Rewrite each platform** sequentially via `autocrew_rewrite`:
   ```
   for each platform:
     1. autocrew_rewrite action="adapt_platform" → get adapted body
     2. autocrew_content action="save" → save as new draft with platform-specific title + hashtags
     3. autocrew_humanize (if needed)
   ```

4. **Link siblings**: after all variants are saved, update each with sibling IDs:
   ```json
   { "action": "update", "id": "<content-id>", "siblings": ["id-1", "id-2", "id-3"] }
   ```

5. **Summary table** — show user a comparison:

   | 平台 | 标题 | 字数 | Hashtags | Content ID |
   |------|------|------|----------|------------|
   | 小红书 | ... | 800 | 8 | content-xxx |
   | 抖音 | ... | 600 | 5 | content-yyy |
   | ... | ... | ... | ... | ... |

## Step 3 — Post-Rewrite Review (Optional)

If `creator-profile.json` has `styleCalibrated: true`:

- Auto-run `autocrew_review` action="full_review" on each adapted version.
- Flag any version that fails review.
- Offer to auto-fix or let user decide.

## Output

Always tell the user:

- Which platform version(s) you created
- Whether each was saved as a new draft (with content ID)
- Title alternatives from title-hashtag
- Hashtags attached
- What still needs manual polish
- Sibling relationships (if batch)

## Error Handling

| Failure | Action |
|---------|--------|
| Source content not found | Ask user for content_id or raw text. |
| Unsupported platform | List supported platforms, ask user to pick. |
| title-hashtag returns empty | Fall back to original title + basic hashtags from tags. |
| Save fails | Output adapted text in chat so user can copy. Retry once. |

## Changelog

- 2026-04-01: v2 — Added multi-platform batch flow, title-hashtag integration, sibling linking, optional post-rewrite review.
- 2026-03-31: v1 — Initial single-platform rewrite skill.
