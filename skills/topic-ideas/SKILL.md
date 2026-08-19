---
name: topic-ideas
surfaces: gui, harness
gui_summary: 用户给模糊方向要选题时用——拆受众张力、出候选、入灵感库
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

## GUI

**什么时候用**：用户在对话里给了一个模糊方向或一个种子想法，要「帮我想选题」「这个方向能写什么」「最近写点啥」。系统性调研不走这本手册。

### 方法论：受众张力拆解

张力 = 受众**以为**的 vs **实际**为真的，而且必须用受众自己的话说。

- 反例（创作者视角）：AI 执行力强但判断力弱
- 正例（受众视角）：觉得买了 AI 工具就能省人力，实际上要花更多时间想清楚让 AI 干嘛

每写一条选题之前，先在心里跑一遍画像模拟：

> 「<画像名字>，<年龄>，<职业>。他刷到这条，会停下来吗？3 秒内看得懂标题在说什么吗？」

答案是「不会」就重写。绝不用画像看不懂的词。

**三道质量闸**（每条都要全过，不过就砍掉）：

1. 停留测试：他真的会停手吗？
2. so-what 测试：这条给的东西，他自己随便搜就能搜到吗？
3. 冒名测试：换个泛泛的账号也能发这条吗，还是非得有你的视角？

**语言规则**：标题和描述一律用受众的语言。受众说中文就写中文，别掺他们不用的英文黑话。

### 步骤

1. **定位与画像不用去查**——创作者定位、核心受众、当前目标已经在你的上下文里（system prompt 注入）。画像缺失或未校准时先引导用户校准：`generate_persona` 出提案 → 带用户逐层过（名字/焦虑/痛点准不准）→ 用户认可后 `save_persona` 落库。未确认绝不保存。
2. **请求模糊**（只说「帮我想选题」）→ 先拆 3-4 条受众侧张力摆给用户，问哪条最扎心，再从那条往下想。**给了具体种子**（一个故事、一个观察、一句吐槽）→ 直接跳到第 4 步。
3. 需要外部素材时：`find_topics` 拉本土热榜候选，`find_overseas_topics`（要一个关键词）拉英文源，`scout_inspiration` 按定位自动搜；用户贴了链接先 `read_url` 读原文再拆。
4. 出 5 条选题，每条四要素：
   - **标题**（≤20 字）：具体、能让人停手
   - **角度**：那个不显然的洞察，一句话
   - **钩子方向**：前 3 秒 / 前 3 行怎么抓人
   - **为什么成立**：解掉受众的哪条张力
5. 三道闸过一遍，把留下来的拿给用户，问哪几条对味。
6. 用户点头的 → `save_topic` 入灵感库，`reason` 一句话说清为什么值得写（命中定位／对标爆款／读者追问）。**只入库不开写**，等用户发话。
7. 用户要接着写 → `generate_script`（务必带 `topic_id`，血缘断了归因就断了）；要先补料 → `deep_research`，投完引导用户去看板的选题卡看进度，别在本轮等结果。
