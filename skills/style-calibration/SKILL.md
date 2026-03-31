---
name: style-calibration
description: |
  Calibrate writing style to match user's brand voice. Activate when user provides sample content, asks to set up their brand voice, or wants to calibrate style. Trigger: "风格校准" / "设置风格" / "我的风格是" / "参考这个账号".
---

# Style Calibration — Brand + Digital Twin Modeling

> Conversational skill. Runs a multi-phase conversation: brand research → audience personas → writing style modeling. Writes results into MEMORY.md and STYLE.md.

## Pre-read: Smart Context Loading

Before starting, silently read these files (if they exist):
1. `~/.autocrew/MEMORY.md` — check which sections are filled vs empty
2. `~/.autocrew/STYLE.md` — check if style profile already exists

Use this to skip questions whose answers are already known.

## Steps

### Phase 0: Brand Research (2-4 turns)

> Goal: Understand the user's brand, goals, content status, and style boundaries.

**Information to collect** (skip what's already in MEMORY.md):

1. **Goals & positioning**: industry, monetization model, current stage
2. **Content sample**: best existing content (link/text), or intended direction if starting from scratch
3. **Audience**: who they want to reach — a specific person, not abstract demographics
4. **Style boundaries**: what they absolutely don't want to become

**Conversation style**: Ask 1-2 questions per turn, max. React to answers with brief insight before next question. Don't interrogate.

### Phase 0.5: Audience Persona (1-2 turns)

Generate 3 audience personas based on Phase 0 data. Each persona:
- Name (fictional), age, job, one-sentence life situation
- Core anxiety related to the user's industry
- What makes them stop scrolling
- What makes them skip

Present all 3, ask user to pick the primary one (or merge).

### Phase 1: Style Analysis (if user provided samples)

Analyze the user's content samples for:
- Tone (casual/professional/playful/authoritative)
- Sentence structure patterns
- Emoji usage
- Vocabulary level and preferred expressions
- Formatting preferences
- Hook patterns

### Phase 2: Style Profile Generation

Generate and save `~/.autocrew/STYLE.md`:

```markdown
# Brand Voice Profile

## Tone
[e.g., Casual-professional, like talking to a smart friend]

## Patterns
- [Opening pattern]
- [Emoji usage: frequency, placement, favorites]
- [Paragraph length preference]
- [Ending pattern]

## Vocabulary
- Prefers: [words/phrases the user likes]
- Avoids: [words/phrases the user dislikes]

## Platform Variations
- XHS: [adjustments]
- WeChat: [adjustments]
- Douyin: [adjustments]

## Audience Persona
- Name: [primary persona]
- Profile: [one-line summary]
- Scroll-stop triggers: [what makes them stop]
```

### Phase 3: Save to MEMORY.md

Append brand context to `~/.autocrew/MEMORY.md`:
- Industry and positioning
- Target audience summary
- Style boundaries
- Competitor accounts (if mentioned)

### Phase 4: Confirmation

> 风格校准完成！我记住了你的品牌调性和目标受众。以后写内容会自动参考这个风格。
> 要不要试一下？给我一个选题，我按这个风格写一篇看看。

## Guidelines

- The style profile should be actionable — another writer should be able to follow it
- Update, don't replace, when user provides new samples later
- Keep STYLE.md under 60 lines — concise and scannable

## Changelog

- 2026-03-31: v1 — Adapted from Qingmo style-calibration.md v4. Removed SOUL.md dependency (uses STYLE.md instead). File paths changed to ~/.autocrew/.
