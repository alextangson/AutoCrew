---
name: platform-rewrite
description: |
  平台 native 改写 skill。把一个母稿改成不同平台的版本，强调"重写而不是裁剪"。支持单平台和多平台一键改写，自动生成各平台标题和 hashtag。
---

# 平台改写

## 目标

把一篇母稿改写成各平台原生版本。重写，不是裁剪。

支持平台：小红书 · 抖音 · 公众号 · 视频号 · B站

## 规则

0. **When adapting titles across platforms, do NOT just truncate. Re-craft using `skills/title-craft/SKILL.md` methodology fitted to the target platform's character limits and audience behavior.**
1. Never call a simple trim "adaptation".
2. Start from the strongest single angle in the source draft.
3. Generate the first structured platform version via `autocrew_rewrite`.
4. If the user asks for multiple platforms, use the **batch flow** (Step 2 below).
5. Run `humanizer-zh` before final delivery.

## 第一步 — 单平台改写

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

## 第二步 — 多平台批量改写

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

## 第三步 — 改写后审核（可选）

If `creator-profile.json` has `styleCalibrated: true`:

- Auto-run `autocrew_review` action="full_review" on each adapted version.
- Flag any version that fails review.
- Offer to auto-fix or let user decide.

## 输出

Always tell the user:

- Which platform version(s) you created
- Whether each was saved as a new draft (with content ID)
- Title alternatives from title-hashtag
- Hashtags attached
- What still needs manual polish
- Sibling relationships (if batch)

## 错误处理

| 故障 | 处理 |
|------|------|
| 源内容未找到 | 向用户索要 content_id 或原始文本 |
| 不支持的平台 | 列出支持平台，让用户选择 |
| title-hashtag 返回空 | 回退到原始标题 + tags 基础标签 |
| 保存失败 | 在聊天中输出改写文本让用户复制，重试一次 |

## 变更日志

- 2026-04-01: v2 — Added multi-platform batch flow, title-hashtag integration, sibling linking, optional post-rewrite review.
- 2026-03-31: v1 — Initial single-platform rewrite skill.
