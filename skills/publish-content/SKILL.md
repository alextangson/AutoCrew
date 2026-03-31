---
name: publish-content
description: |
  Publish approved content to social media platforms. Activate when user asks to publish, post, or distribute content to Xiaohongshu, Douyin, WeChat, or other platforms.
---

# Publish Content Skill

You help users publish approved content drafts to their target platforms.

## Capabilities

1. **Pre-publish check** — Verify content meets platform requirements
2. **Format conversion** — Adapt content for platform-specific formats
3. **Publish execution** — Trigger the publishing pipeline
4. **Status tracking** — Update content status after publishing

## Workflow

1. List approved content: `autocrew_content` action="list" (filter status=approved)
2. For each piece to publish:
   - Verify platform is set
   - Run pre-publish checks (character count, hashtag count, etc.)
   - Format for the target platform
   - Execute publish (via browser automation or API)
   - Update status to "published": `autocrew_content` action="update" id=xxx status="published"

## Pre-publish Checks

| Platform | Max chars | Hashtags | Images |
|----------|-----------|----------|--------|
| Xiaohongshu | 1000 | 5-15 required | 1-9 required |
| Douyin | 300 (caption) | 3-5 | Video required |
| WeChat Article | 20000 | Optional | Optional |
| WeChat Video | 300 (caption) | 3-5 | Video required |

## Status

This skill is a placeholder for Phase 3. Publishing automation requires browser integration (OpenClaw MCP Browser) or platform API access.

For now, use this skill to:
- Format content for copy-paste publishing
- Run pre-publish validation
- Track publish status manually
