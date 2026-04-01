---
name: content-review
description: 内容审核 skill — 整合敏感词扫描 + 去 AI 味检查 + 质量评分，输出审核报告并联动状态机
trigger: 当用户说"审核"、"review"、"检查内容"、"内容审核"时触发
---

# Content Review Skill

对内容执行完整审核流程，输出审核报告 + 一键修复建议。

## 触发条件

- 用户说"审核"、"review"、"检查内容"、"内容审核"
- 内容状态流转到 `draft_ready` 时自动建议执行
- 用户手动指定 content ID 要求审核

## 审核流程

按以下顺序执行 5 项检查，每项独立评分：

### Step 1: 敏感词扫描

调用 `autocrew_content` tool：

```
action: "review_scan"  (如果已实现)
```

或直接使用敏感词模块逻辑：

1. 读取内容的 `body` 字段
2. 扫描内置敏感词库（政治、暴力、色情、医疗宣称、金融宣称）
3. 扫描平台特定限流词（根据 content 的 `platform` 字段）
4. 扫描用户自定义词库 `~/.autocrew/sensitive-words/custom.txt`
5. 输出命中词列表 + 建议替换

**评分规则：**
- 0 个命中 → ✅ 通过
- 仅平台限流词 → ⚠️ 建议修改（不阻断）
- 政治/暴力/色情命中 → ❌ 必须修改

### Step 2: 平台合规检查

根据 `platform` 字段检查平台特有规则：

**小红书：**
- 标题是否含 emoji（推荐）
- 正文是否超过 1000 字（建议精简）
- 是否包含引流词（私信、加微信等）

**抖音：**
- 文案是否超过 300 字
- 是否包含竞品品牌名

**微信公众号：**
- 是否包含诱导分享/关注词汇
- 标题是否超过 64 字符

### Step 3: 去 AI 味检查

调用 `humanizeZh()` 函数对内容做一次检测（dry-run 模式）：

1. 统计 AI 味指标：
   - 套话词频（值得一提、综上所述、赋能、闭环等）
   - 顺序词频（首先/其次/最后）
   - "我们"开头句子占比
   - 平均句长（中文字符数）
2. 输出 AI 味评分（0-100，越低越好）

**评分规则：**
- 0-20 → ✅ 自然
- 21-50 → ⚠️ 有轻微 AI 痕迹，建议润色
- 51+ → ❌ AI 味明显，建议用 humanizer-zh 处理

### Step 4: 质量评分

评估内容质量的 4 个维度：

1. **信息密度**（0-25 分）
   - 每段是否有具体数据/案例/观点
   - 是否有空泛的废话段落

2. **Hook 强度**（0-25 分）
   - 开头第一句是否有吸引力
   - 是否在前 3 行建立了阅读动机

3. **CTA 清晰度**（0-25 分）
   - 结尾是否有明确的行动号召
   - CTA 是否与内容主题一致

4. **可读性**（0-25 分）
   - 段落长度是否适中
   - 是否有适当的分段和留白
   - 是否使用了 emoji/符号辅助阅读（平台相关）

**总分 = 4 项之和（0-100）**

### Step 5: 输出审核报告

格式：

```markdown
## 📋 内容审核报告

**内容：** {title} ({content_id})
**平台：** {platform}
**审核时间：** {timestamp}

### 1. 敏感词扫描 {✅/⚠️/❌}
{详细结果}

### 2. 平台合规 {✅/⚠️/❌}
{详细结果}

### 3. AI 味检测 {✅/⚠️/❌}
AI 味评分：{score}/100
{详细结果}

### 4. 质量评分
总分：{score}/100
- 信息密度：{n}/25
- Hook 强度：{n}/25
- CTA 清晰度：{n}/25
- 可读性：{n}/25

### 📌 审核结论
{APPROVED / NEEDS_REVISION}

### 🔧 修复建议
{如果需要修改，列出具体建议}
```

## 状态机联动

审核完成后，根据结果自动建议状态流转：

- **全部通过** → 建议 `reviewing → approved`
  ```
  autocrew_content action=transition content_id={id} target_status=approved
  ```

- **需要修改** → 建议 `reviewing → revision`
  ```
  autocrew_content action=transition content_id={id} target_status=revision diff_note="审核未通过: {原因摘要}"
  ```

- 用户确认修改后 → `revision → reviewing`（重新审核）

## 与 Learnings 联动

每次审核产生的修改建议，如果用户采纳并修改了内容：

1. Diff Tracker 自动记录 before/after
2. Rule Distiller 检查是否达到提炼阈值（5+ 次同类修改）
3. 达到阈值的模式自动写入 `creator-profile.json` 的 `writingRules`

## 注意事项

- 审核是建议性的，用户可以 `force` 跳过
- 敏感词库会持续更新，鼓励用户维护 `custom.txt`
- 质量评分是 AI 辅助评估，不是绝对标准
