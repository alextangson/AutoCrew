---
name: content-attribution
description: |
  内容归因分析 — 对已发布内容的表现数据进行归因，提炼学习，反哺创作。当平台数据回收后自动触发，或用户手动要求分析。
trigger: 当用户说"分析数据"、"这条内容表现怎么样"、"归因"、"复盘"时触发
---

# Content Attribution（内容归因）

> 内容飞轮的核心环节：数据 → 归因 → 学习 → 下一条更好。

## 触发方式

1. Chrome Relay 回收平台数据后自动建议执行（待实现）
2. 用户手动提供数据并要求分析
3. 用户说 "复盘" / "这条效果怎么样"

## 归因流程

### Step 1: 加载内容和数据

1. 获取内容详情：`autocrew_content action=get id={content_id}`
2. 获取 performance_data（如果已录入）
3. 加载内容的 hypothesis 和 experimentType

### Step 2: 表现评级

根据平台基准和历史数据（如果有）：

| 评级 | 条件 |
|------|------|
| 🔥 爆款 (viral) | 数据显著超出历史均值 2x+ |
| ✅ 达标 (on_target) | 数据在历史均值 0.8x-2x 范围 |
| ⚠️ 低于预期 (below_expectation) | 数据低于历史均值 0.8x |

如果没有历史数据，让用户自评或提供平台同类内容基准。

### Step 3: 核心归因

分析内容本身 + 数据表现，给出单一核心归因（不要给多个原因，强制选最重要的一个）：

| 归因 | 判断依据 |
|------|---------|
| strong_title | 标题点击率高，但完播率/阅读率一般 |
| good_hook | 前3秒/前段留存高 |
| right_topic | 选题命中了当前热点或受众痛点 |
| timing | 发布时间恰好命中流量高峰 |
| luck | 以上都不突出，可能被算法随机推荐 |

### Step 4: 验证假设

对比内容的 `hypothesis` 和实际数据：

- **confirmed**: 数据支持假设
- **rejected**: 数据否定假设
- **inconclusive**: 数据不足以判断

### Step 5: 提炼一句话学习

格式："{具体发现}，在{平台}上对{人群}有效/无效"

例如：
- "反常识标题在小红书上完播率+40%，对王总人群有效"
- "纯方法论内容在抖音上完播率低，需要加故事包装"

### Step 6: 保存归因

更新内容的 meta：

```json
{
  "action": "update",
  "id": "{content_id}",
  "performance_data": { "views": 0, "likes": 0 }
}
```

归因结果存入 pipeline meta.yaml 的 `performanceLearnings[]`。

### Step 7: 检查学习沉淀阈值

如果 `performanceLearnings` 已积累 5+ 条：
1. 扫描所有 learnings，寻找重复出现的 pattern
2. 发现 pattern 后提示用户确认
3. 确认后写入 `creator-profile.json` 的 `writingRules[]`：
   ```json
   {
     "rule": "{提炼的规则}",
     "source": "auto_distilled",
     "confidence": 0.8,
     "createdAt": "{ISO timestamp}"
   }
   ```

## 输出格式

```
## 📊 内容归因报告

**内容：** {title} ({content_id})
**平台：** {platform}
**发布时间：** {published_at}

### 数据概览
| 指标 | 数值 | vs 均值 |
|------|------|---------|
| 播放量 | {N} | {+/-}% |
| 完播率 | {N}% | {+/-}% |
| 点赞 | {N} | {+/-}% |
| 收藏 | {N} | {+/-}% |
| 评论 | {N} | {+/-}% |

### 表现评级：{🔥/✅/⚠️} {rating}

### 核心归因：{attribution}
{一段解释}

### 假设验证
- 假设：{hypothesis}
- 结果：{confirmed/rejected/inconclusive}
- {解释}

### 💡 一句话学习
{learning}

### 📝 累计学习 ({N}/5 → 达到阈值自动提炼规则)
{list of recent learnings}
```
