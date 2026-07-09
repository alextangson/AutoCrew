---
name: write-script
description: |
  为中文社媒写一篇完整原创稿。用户要写帖子、出内容、起草文章、产出文案时激活。这是执行者技能——真正动笔的那一个。
---

# 写稿（write-script）

> 执行者技能。单一职责：生成一篇完整原创稿并存库。

## 步骤

1. **加载风格与记忆上下文：**

   a. 读 `~/.autocrew/STYLE.md` —— 吸收品牌声音、人格、边界。
   b. 读 `~/.autocrew/creator-profile.json` —— 看 `styleCalibrated`、`platforms`、`writingRules`，以及 `voiceSamples`（创作者原文段落：成稿要像同一个人写的，学语感不抄句子）。
   c. 都没有就用合理默认开写，并在产出时提示建议先做风格校准。

2. **调研增强（先查再写）：**

   a. 用 `web_search` 找 3-5 篇同选题的高质量文章。
   b. 从结果里抽数据点、统计数字、具体案例；识别常见结构；生成大纲（钩子类型、要点、CTA）。
   c. 把大纲给用户确认：
      > 基于调研，我建议这样的结构：
      > - 钩子：{类型} — {草稿}
      > - 要点 1-N：{要点+支撑数据}
      > - CTA：{风格}
      > 确认开始写？还是调整大纲？
   d. 用户确认 → 带着调研上下文开写；用户调整 → 改大纲再确认。

   **核心原则：绝不凭空写。手里至少要有 2-3 个真实数据点或案例。**

3. 指定了选题时，经 `autocrew_topic` action="list" 拉取选题详情。

4. **写稿：**

   a-c. **钩子 / 正文 / CTA** —— 全部以 `src/modules/packs/koubo.ts`（知识口播赛道包）为唯一来源：先读该文件，从 `hooks` 选一种最强钩子，从 `structureModes` 选一种最贴合选题的结构模式，按 `structure` 的节奏与具体性规则执行（长短句交替、段落长短悬殊、禁止排比腔与套路互动语）。

   d. **标题** —— 用 `title-hashtag.ts` 生成平台化标题：
   - 调 `generateForPlatform(baseTopic, platform)` 拿 3-5 个变体，选最好的做主标题。
   - 有 `web_search` 就再搜 2-3 个平台热词，自然嵌入 1 个。
   - 标题 15-25 字，有价值可带 emoji。

   e. **话题标签** —— 调 `generateHashtags(topic, platform, tags)`；行内标签平台（小红书/抖音）把标签拼在正文尾，同时存进 `hashtags` 字段。

5. **存库前自检**（逐项修正，不是只打勾）：按赛道包的 `selfReview` 清单执行——读 `src/modules/packs/koubo.ts` 的 selfReview 数组。

6. **调工具保存：**
   ```json
   {
     "action": "save",
     "title": "The single best title (no emoji in title field)",
     "body": "Full script as plain text. Blank lines between sections.",
     "platform": "xiaohongshu",
     "topicId": "topic-xxx (if based on a topic)",
     "tags": ["tag1", "tag2"],
     "hashtags": ["#标签1", "#标签2"],
     "status": "draft"
   }
   ```

7. **自动审稿（已校准时）：**
   - 查 `creator-profile.json` → `styleCalibrated: true` 则自动执行：
     ```json
     { "action": "full_review", "content_id": "<saved-id>", "platform": "<platform>" }
     ```
   - 把审稿摘要给用户看。
   - 过 → 告诉用户「审核通过，可以直接发布或做平台改写」。
   - 不过 → 列出修正项，问用户自动修还是手动调。

8. **输出给用户：**
   在会话里展示完整草稿：标题（含备选变体）、正文全文、话题标签、审稿结果（若跑了）。然后：
   > 已保存为草稿。要修改的话直接说，或者确认后我帮你标记为待发布。

9. **需要适配其他平台时：**
   - 不要把一稿裁剪凑合成另一平台。
   - 用 `platform-rewrite` / `autocrew_rewrite` 做平台原生版。

10. **最终交付前：**
   - 文本泛而平、太顺滑、议论文腔时，过一遍 `humanizer-zh` / `autocrew_humanize` 再交。

## 平台特化

以赛道包的 `platformAdjustments` 为准（src/modules/packs/koubo.ts）。

## 标题与标签模块

`title-hashtag.ts` 提供：
- `generateTitleVariants(topic, platform)` → 3-5 个带风格标注的标题变体
- `generateHashtags(topic, platform, tags)` → 去重、按平台限量的话题标签
- `generateForPlatform(topic, platform)` → 标题+标签+提示一次拿全

标题/标签一律走这些函数做结构化生成。它们给的是起点，agent 负责精修——不是终稿。

## 出错处理

| 情况 | 动作 |
|------|------|
| 风格文件缺失 | 用合理默认写，建议跑一次风格校准 |
| 选题不存在 | 直接问用户选题细节 |
| 保存失败 | 全文贴在会话里让用户可复制，再重试一次 |
| 审稿跑不动 | 照存草稿，注明审稿跳过了 |
| title-hashtag 返回空 | 退回手写标题 + 由 tags 出基础标签 |

## Changelog

- 2026-07-09: v5 — 全文中文化（工具 JSON 保持英文）；删除对不存在的 ~/.autocrew/MEMORY.md 的引用；接入 voiceSamples 声音样本与 structureModes 结构模式；_writing-style 参考文档退役（与赛道包双源打架）。
- 2026-06-10: v4 — playbook 抽入 koubo 赛道包（声明式），SKILL 只保留流程编排。
- 2026-04-01: v3 — Added RAW Engine integration (Research-Augmented Writing). Step 2 now gathers research context before writing.
- 2026-04-01: v2 — Integrated STYLE.md + title-hashtag.ts + auto-review after save. Added hashtags field, bilibili platform notes.
- 2026-03-31: v1 — Adapted from Qingmo write-script.md + _writing-style.md. Removed backend API curl dependency. Uses autocrew_content tool. Merged writing style rules inline.
