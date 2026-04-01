# OpenClaw Proven Workflow Integration Blueprint

Updated: 2026-03-31

## Goal

AutoCrew should not rebuild content operations from scratch.

It should absorb the workflows that are already proven inside local OpenClaw workspaces and scripts, then expose them through a cleaner plugin + CLI + local artifact model.

The immediate objective is:

1. keep OpenClaw as a working host
2. extract proven execution logic into AutoCrew-owned modules
3. make the same modules callable from Claude Code later

## Guiding Principle

Migrate **proven execution paths**, not just prompts.

Prioritize the parts that already work end-to-end today:

- WeChat MP draft publishing
- short-video copywriting
- Chinese de-AI polishing
- cover generation + approval loop
- OpenClaw-triggered publish orchestration

Avoid migrating GUI concerns, org/account models, or generic SaaS infrastructure at this stage.

## Current Proven Assets

## 1. WeChat MP publishing

These are already operational and should be turned into an AutoCrew-owned publisher module first.

- `workspace-muse-social/scripts/wechat_publish.py`
- `workspace-muse-social/skills/wechat-auto-draft/SKILL.md`
- `workspace-muse-social/skills/article-derivation/SKILL.md`

Why it matters:

- full path is already validated
- includes image generation, cover handling, and push to draft box
- gives AutoCrew its first truly "done" publishing surface

## 2. Short-video writing and platform-native rewriting

These should become AutoCrew's content planning/writing layer.

- `workspace-muse-social/skills/social-writing/SKILL.md`
- `workspace-template/skills/publish-content.md`
- `workspace-template/skills/remix-content.md`

Why it matters:

- platform-native rewriting is already a hard rule in your system
- this is part of the core product value, not a side utility

## 3. Chinese de-AI / humanization

This should become a first-class AutoCrew writing stage rather than a hidden prompt rule.

- `workspace-muse-social/skills/humanizer-zh/SKILL.md`
- `backend/app/services/refinement.py`
- `backend/workspace-template/skills/humanizer-zh.md`

Why it matters:

- "去 AI 味" is already part of your differentiator
- it should exist as an explicit workflow step with its own checks

## 4. Cover generation and human approval

These are critical for XHS and future short-video publishing.

- `workspace-muse-kefu/skills/content-pipeline/SKILL.md`
- `workspace-muse-kefu/skills/xhs-cover-prompt-craft/SKILL.md`
- `Auto-redbook-skill/cover_brief_agent.py`
- `Auto-redbook-skill/content/cover_reference_pool.json`

Why it matters:

- you already have working cover strategy logic
- human approval is the right default for v0.1
- this is a reusable artifact pipeline, not a one-off script

## 5. OpenClaw host dispatch

These should remain host-specific, but the business flow they trigger must move into AutoCrew.

- `backend/app/services/openclaw_agent.py`
- `backend/app/services/publish.py`

Why it matters:

- OpenClaw already knows how to trigger agent actions and inject notifications
- AutoCrew should consume this as a host adapter, not duplicate it inside core logic

## Target AutoCrew Shape

The current repository already has a useful base:

- plugin entry: `index.ts`
- local storage: `src/storage/local-store.ts`
- tools: `src/tools/*.ts`
- host metadata: `openclaw.plugin.json`

The next step is to introduce a thin module/workflow layer without rewriting the repository.

Recommended additions:

```text
src/
├── modules/
│   ├── writing/
│   ├── humanizer/
│   ├── cover/
│   └── publish/
├── workflows/
│   ├── short-video-publish.ts
│   ├── wechat-mp-draft.ts
│   └── xhs-cover-approval.ts
└── hosts/
    ├── openclaw/
    └── claude-code/
```

## Recommended Migration Mapping

## A. WeChat MP path

Move into AutoCrew first.

Source:

- `workspace-muse-social/scripts/wechat_publish.py`

Target:

- `src/modules/publish/wechat-mp.ts`

What to keep:

- image tag scan + replacement
- image generation loop
- cover generation fallback
- push-to-draft behavior

What to remove:

- hardcoded API key
- direct dependency on workspace-specific paths

## B. Humanizer / de-AI

Source:

- `workspace-muse-social/skills/humanizer-zh/SKILL.md`
- `backend/app/services/refinement.py`

Target:

- `src/modules/humanizer/zh.ts`
- optionally `skills/humanizer-zh/SKILL.md`

Expected role:

- a formal post-processing stage after writing
- reusable from both OpenClaw and Claude Code

## C. Platform-native writing

Source:

- `workspace-muse-social/skills/social-writing/SKILL.md`
- `workspace-template/skills/remix-content.md`

Target:

- `src/modules/writing/platform-rewrite.ts`
- reuse via `skills/write-script/SKILL.md`

Expected role:

- turn one source idea/video into platform-specific outputs
- explicitly forbid naive trimming across platforms

## D. XHS cover + approval

Source:

- `workspace-muse-kefu/skills/content-pipeline/SKILL.md`
- `workspace-muse-kefu/skills/xhs-cover-prompt-craft/SKILL.md`

Target:

- `src/modules/cover/xhs-brief.ts`
- `src/modules/cover/render.ts`
- `src/workflows/xhs-cover-approval.ts`

Expected role:

- create multiple cover candidates
- persist strategy metadata
- support human approval before publish

## E. OpenClaw host adapter

Source:

- `backend/app/services/openclaw_agent.py`
- `backend/app/services/publish.py`

Target:

- `src/hosts/openclaw/dispatch.ts`

Expected role:

- translate OpenClaw user intent into AutoCrew tool/workflow calls
- handle inject/send style notifications
- avoid embedding business logic in host glue

## Priority Order

## P0

Ship these first:

1. WeChat MP publisher module
2. Chinese humanizer module
3. platform-native short-video rewrite module

Reason:

- these are already real and useful
- they create obvious user value quickly
- they do not require solving the full XHS publish automation problem on day one

## P1

Add next:

1. XHS cover generation
2. approval state
3. multi-platform publish package for short video

## P2

Later:

1. OpenClaw cron-backed orchestration
2. analytics feedback loop
3. batch workflows

## What Not To Migrate Yet

- qingmoagent frontend pages
- organization/subscription models
- generic content CRUD APIs that only support GUI
- non-proven automation branches

## Immediate Repository Tasks

1. Create `src/modules/` and `src/workflows/` directories.
2. Port `wechat_publish.py` into a reusable TypeScript or shell-backed module with config-driven paths.
3. Add an explicit `humanizer-zh` skill and module.
4. Refactor `write-script` to call a platform rewrite module instead of relying only on prompt instructions.
5. Add workflow definitions for:
   - `wechat-mp-draft`
   - `short-video-publish`
   - `xhs-cover-approval`

## v0.1 Product Lens

For v0.1, AutoCrew should be described internally as:

"A local content operations runtime that packages already-proven OpenClaw workflows into reusable modules."

That keeps the focus on shipping real capability instead of inventing a new abstraction layer too early.
