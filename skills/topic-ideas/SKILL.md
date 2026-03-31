---
name: topic-ideas
description: |
  Interactive topic brainstorming from a seed idea. Activate when user gives a rough idea and wants to explore angles. Trigger: "帮我想" / "想选题" / "这个方向怎么样" / "灵感" / seed idea + "怎么做内容".
---

# Topic Ideas

> Interactive brainstorming when user gives a seed idea. NOT for systematic research — use research skill for that.

## Inputs

| Parameter | Source | Required | Description |
|-----------|--------|----------|-------------|
| seed_idea | User message | No | A rough idea, observation, or direction |
| count | User message | No | Number of topic directions (default: 5) |

## Steps

1. Read `~/.autocrew/MEMORY.md` for brand context, target audience, and persona section.
   Read `~/.autocrew/STYLE.md` for platform and tone preferences.

   IF no audience persona exists THEN ask user:
   > 我需要先了解你的内容是给谁看的。描述一个你最想影响的人——他是干什么的、多大年纪、为什么会关注你？

   Generate persona, confirm with user, then continue.

2. IF user only gave a vague request (e.g. "帮我想选题") THEN decompose into 3-4 **audience-side tensions** before brainstorming.

   A tension = what the audience BELIEVES vs what's ACTUALLY TRUE, stated in the audience's language.
   - Bad (creator perspective): "AI执行力强但判断力弱"
   - Good (audience perspective): "觉得买了AI工具就能省人力，实际上要花更多时间想清楚让AI干嘛"

   Present tensions, ask user which one hits hardest, THEN brainstorm from that tension.

   IF user gave a specific seed (a story, an observation, a frustration) THEN skip to step 3.

3. Generate 5 topics. For EACH topic, before writing it, simulate the persona:

   > [Persona name], [age], [job]. 他刷到这条，会停下来吗？他能在3秒内理解标题在说什么吗？

   If the answer is no → rewrite. NEVER use terms the persona wouldn't understand.

   Each topic MUST include:

   **Title** (≤20 chars): Specific, scroll-stopping. Must pass: "Would [persona] stop scrolling for this?"
   **Angle**: The non-obvious insight or twist. One sentence.
   **Hook direction**: How the first 3 seconds would work.
   **Why it works**: What tension it resolves for the audience.

4. **Quality gate** — each topic must pass ALL:
   - [ ] Persona scroll-stop test: would they actually stop?
   - [ ] So-what test: does it offer something the audience can't easily find?
   - [ ] Impostor test: could a generic account post this, or does it need YOUR perspective?

5. Present topics to user. Ask which ones resonate.

6. For approved topics, save using `autocrew_topic` tool:
   ```json
   { "action": "create", "title": "...", "description": "angle + hook direction + why it works", "tags": [...], "source": "brainstorm" }
   ```

## Translation Rule

ALL topic titles and descriptions MUST be in the audience's language. If the user's audience speaks Chinese, write in Chinese. Never mix English jargon unless the audience actually uses it.

## Changelog

- 2026-03-31: v1 — Adapted from Qingmo topic-ideas.md v3. Removed backend API dependency. Persona loaded from ~/.autocrew/MEMORY.md.
