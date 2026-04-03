---
name: teardown
description: |
  拆解对标内容 — 用户粘贴一段文案，输出结构化拆解报告。分析钩子、HKRR、时钟节奏、评论触发、微操技巧。结果存入 intel 系统供创作参考。
trigger: 当用户说"拆解"、"teardown"、"分析这条"、"对标分析"时触发
---

# Competitive Teardown（对标拆解）

> 免费版：分析用户粘贴的文案。Pro 版（待实现）：通过 Chrome Relay 抓取视频/账号数据。

## 触发方式

用户说 "拆解这条内容" / "teardown" / "帮我分析对标" 并粘贴一段文案。

## 前置加载

- `HAMLETDEER.md` — HKRR 框架、Clock Theory、Micro-Retention Techniques、Bang Moment Types
- `~/.autocrew/creator-profile.json` — 用于对比自己的定位

## 拆解流程

### Step 1: 基本信息提取

- 预估平台（根据文案风格/emoji/hashtag 特征）
- 预估内容类型（图文 / 视频脚本 / 长文）
- 字数统计

### Step 2: 钩子分析

- 开头类型：Pain point / Suspense / Ideal state / Emotional resonance / Contrast / 其他
- 标题公式匹配：Number+Result / Contrarian / Identity+Pain / Curiosity Gap / Contrast / Resonance Question / 无匹配
- 钩子强度评分（0-10）

### Step 3: HKRR 评分

对四个维度分别打分（0-10）：

| 维度 | 评分 | 说明 |
|------|------|------|
| Happiness | X/10 | 是否有趣/有笑点？ |
| Knowledge | X/10 | 是否有增量信息/方法论？ |
| Resonance | X/10 | 是否触达情绪/身份认同？ |
| Rhythm | X/10 | 节奏是否有变化？能否持续吸引？ |

标注最强维度。

### Step 4: Clock 映射

将内容按比例映射到时钟位，分析每个位置：

| Clock | 内容段落 | Bang moment 类型 | 效果评估 |
|-------|---------|-----------------|---------|
| 12:00 | ... | ... | 强/弱/缺失 |
| 3:00 | ... | ... | 强/弱/缺失 |
| 6:00 | ... | ... | 强/弱/缺失 |
| 9:00 | ... | ... | 强/弱/缺失 |

### Step 5: 评论触发点识别

- 争议埋点：在哪里？什么话题？
- 未答问题：有没有故意留白？
- 金句钩子：哪句最值得截图？

### Step 6: 微操技巧识别

- 开放循环：有没有？在哪里？
- 信息缺口：段落结尾有没有前向动力？
- 视觉锚点：有没有高密度独立金句？
- 断裂感：有没有突然的超短句？

### Step 7: 一句话总结

"这条内容有效/无效，核心原因是 ___"

### Step 8: 可借鉴点

列出 2-3 个可以应用到自己内容的具体技巧。

## 保存拆解结果

将拆解报告保存到 intel 系统：

```
~/.autocrew/data/pipeline/intel/teardowns/{slug}-{date}.md
```

YAML frontmatter:
```yaml
---
title: "拆解: {原内容标题或前20字}"
type: teardown
platform: "{预估平台}"
hookType: "{钩子类型}"
dominantHKRR: "{最强HKRR维度}"
hookScore: 0
overallScore: 0
createdAt: "{ISO timestamp}"
tags: [teardown]
---
```

## 输出格式

```
## 🔍 对标拆解报告

**内容摘要：** {前50字}...
**预估平台：** {platform}
**字数：** {count}

### 钩子分析
- 类型：{hook type}
- 公式：{title formula or 无匹配}
- 强度：{score}/10
- 评价：{一句话评价}

### HKRR 评分
| H | K | R | R |
|---|---|---|---|
| {n}/10 | {n}/10 | {n}/10 | {n}/10 |
**最强维度：** {element}

### Clock 映射
{table}

### 评论触发点
{list}

### 微操技巧
{list}

### 💡 总结
{一句话总结}

### 🎯 可借鉴
{2-3 bullet points}
```

向用户确认后保存。

## 与 write-script 联动

write-script 在创作时会自动搜索 `pipeline/intel/teardowns/` 目录，查找与当前主题相关的拆解报告作为参考。无需手动操作。
