---
name: publish-content
description: |
  Publish approved content to social media platforms. Activate when user asks to publish, post, or distribute content. Trigger: "发布" / "发到小红书" / "帮我发" / "发布这篇".
---

# Publish Content

> Utility skill. Helps format and prepare content for publishing. Full browser automation requires OpenClaw with MCP Browser.

## Capabilities

| Feature | OpenClaw | Claude Code |
|---------|----------|-------------|
| Pre-publish validation | Yes | Yes |
| Format for copy-paste | Yes | Yes |
| Browser automation publish | Yes (MCP Browser) | No (manual) |
| Status tracking | Yes | Yes |

## Steps

1. **Identify content to publish.**
   List approved content: `autocrew_content` action="list"
   Filter for status="approved" or status="draft" (if user explicitly asks to publish a draft).

   IF no content found → tell user to write some first.

2. **Pre-publish checks.**

   | Platform | Title limit | Body limit | Tags | Notes |
   |----------|-------------|------------|------|-------|
   | xiaohongshu | 20 chars | 1000 chars | 5-15 required | Images required (user provides) |
   | douyin | 20 chars | 300 chars (caption) | 3-5 | Video required (user provides) |
   | wechat_mp | 64 chars | 20000 chars | Optional | |
   | wechat_video | 20 chars | 300 chars (caption) | 3-5 | Video required (user provides) |

   Check content against platform limits. If over limit, truncate with "…" and warn user.

3. **Format for platform.**

   **Xiaohongshu format:**
   ```
   {title}

   {body}

   {hashtags as #tag1 #tag2 #tag3}
   ```

   **Douyin format:**
   ```
   {caption}

   {hashtags as #tag1 #tag2}
   ```

   **WeChat Article format:**
   ```
   {title}

   {body with subheadings}
   ```

4. **Output formatted content** for user to copy-paste, OR if browser automation is available (OpenClaw), offer to publish directly.

5. **Update status:**
   ```json
   { "action": "update", "id": "content-xxx", "status": "published" }
   ```

## Browser Automation (OpenClaw only)

When running in OpenClaw with MCP Browser available:

| Platform | Creator URL |
|----------|------------|
| xiaohongshu | `https://creator.xiaohongshu.com/publish/publish` |
| douyin | `https://creator.douyin.com/creator-micro/content/upload` |
| wechat_video | `https://channels.weixin.qq.com/platform/post/create` |

Steps:
1. Navigate to creator URL with saved browser profile
2. Check login status (URL redirect = not logged in)
3. Fill in content fields
4. Upload media (user must provide file paths)
5. Submit and verify

## Error Handling

| Failure | Action |
|---------|--------|
| Content not found | Ask user which content to publish. |
| Over platform limit | Truncate and warn user. |
| Browser not available | Fall back to copy-paste format. |
| Login expired | Ask user to re-login manually. |

## Changelog

- 2026-03-31: v1 — Adapted from Qingmo publish-content.md v2. Dual-mode: copy-paste (universal) + browser automation (OpenClaw only). Removed backend PublishJob dependency.
