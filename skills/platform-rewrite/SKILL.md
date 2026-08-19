---
name: platform-rewrite
surfaces: gui, harness
gui_summary: 一稿多发时用——按平台腔调重写而不是裁剪，含发布前分叉
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

## GUI

**什么时候用**：一稿多发——把已有的一篇改成另一个平台的版本（小红书 / 抖音 / 公众号 / 视频号 / B站）。

### 方法论：重写，不是裁剪

- 删几段、砍字数、加几个 tag，那不叫适配。
- 从母稿里**最强的那一个角度**重新起。一个平台一个角度，别把长文骨架照搬过去。
- 平台不是格式，是说话方式：小红书是分享给朋友的口气，有情绪有细节；抖音前 3 秒定生死，句子短到能顺口读出来；公众号铺得开论证，容得下起承转合；视频号 / B站要口播顺、有停顿点。
- 适配出来的稿最容易变得又顺又空——改完必过一遍去 AI 味（见 humanizer-zh 手册）。

### 步骤

1. `get_draft` 读母稿全文。没读全文不要动手。同主题已有其他平台稿件时，优先从**已过审**的那篇派生（兄弟稿列表在上下文里）。
2. 确认目标平台。只在创作者已开通的席位里建议（席位在上下文）；用户要没开通的平台，先建议他去设置里开席位。
3. `adapt_platform`（`content_id` + `target_platform`）。**一次一个平台**，要多平台就顺序调多次——它会存成新稿并推出稿件卡。
4. 每个新版本都读一遍：读着太顺太干净就 `revise_draft` 去 AI 味；用户想自己盯某一段，引导他去编辑器框选那段说「改这段」（走 `revise_focus`）。
5. 要发了，按平台分叉：
   - 视频平台（抖音/视频号/小红书/B站）→ `prepare_video_kit` 备发布件。**口播稿是读的，发布件才是发的**，别拿口播稿当发布文案。
   - 图文粘贴发布 → `publish_clipboard` 出排好版的文案。
   - 公众号草稿箱 → `push_wechat_draft`。它只弹确认卡，用户亲手点「推送」才执行——不要宣称已推送。
6. 收尾告诉用户：建了哪几个平台版本、各自的稿件 id、哪些还要人工打磨，引导他去看板／编辑器看。

### 出岔子怎么办

| 情况 | 做法 |
|---|---|
| 找不到源稿 | `list_drafts` 列出来让用户指认，别猜 id |
| 用户要的平台不在支持列表 | 说清支持哪几个，让他挑一个 |
| `adapt_platform` 返回错误 | 把原因照实告诉用户，不要假装已经改好 |
