# Browser-First Research Strategy

Updated: 2026-03-31

## Why AutoCrew should prefer browser sessions over TikHub

AutoCrew is currently evolving as a local, user-owned runtime rather than a multi-tenant backend.

That changes the research and publish architecture:

- users already have their own platform login sessions
- users already manage cookies and account state inside their browser
- many critical workflows depend on authenticated platform pages anyway

So the default strategy should be:

1. use the user's own logged-in browser session first
2. fall back to API providers like TikHub only when needed

## Recommended order

### 1. `browser_cdp`

Default path for:

- topic research
- competitor observation
- creator center checks
- account health checks
- publish flows

This should be implemented through host-provided browser capabilities:

- OpenClaw browser/CDP integration
- Claude Code + browser/CDP helper
- future `web-access` style adapters

### 2. `api_provider`

Fallback path for:

- browser unavailable
- login expired
- CAPTCHA or access block
- lightweight structured fetches where browser is too heavy

TikHub belongs here.

### 3. `manual`

Last fallback:

- user gives links
- user gives screenshots
- user gives exported metrics

## Product implication

AutoCrew should no longer be described as "TikHub-powered research".

It should be described as:

"browser-first content operations using the user's own logged-in platform sessions."

## Current implementation note

The repository now includes adapter stubs for:

- `src/adapters/browser/browser-cdp.ts`
- `src/adapters/browser/types.ts`
- `src/adapters/research/tikhub.ts`

The browser adapter now expects a web-access style CDP proxy at:

- `AUTOCREW_CDP_PROXY_URL`
- default: `http://127.0.0.1:3456`

Current bridge scope:

- platform session/login checks
- browser-first keyword research for Xiaohongshu, Douyin, and Bilibili

This is still a minimal bridge layer, but it is now executable instead of being documentation only.
