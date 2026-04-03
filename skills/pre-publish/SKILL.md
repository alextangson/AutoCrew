---
name: pre-publish
description: |
  发布前检查清单 skill。在内容发布前自动检查所有前置条件是否满足，输出 checklist 状态。只有全部通过才允许发布。
---

# 发布前检查

> 门控技能。在发布前拦截，确保内容质量和完整性。

## 触发时机

- User says "发布", "推送", "publish", "上线"
- User runs `autocrew_publish`
- Agent is about to transition content to `publishing` status

## 检查项

对目标内容运行以下检查，每项 pass/fail：

### 1. Content Review — 审核通过

```json
{ "action": "full_review", "content_id": "<id>", "platform": "<platform>" }
```

- ✅ Pass: `passed === true` (no sensitive words, no AI traces, quality ≥ 60)
- ❌ Fail: show `summary` and `fixes`, offer auto-fix

### 2. Cover Review — 封面审核通过 (XHS/Douyin only)

```json
{ "action": "read", "content_id": "<id>" }
```

Check `cover-review.json` in the content's asset directory:
- ✅ Pass: `status === "approved"` and `approvedLabel` exists
- ⏭️ Skip: platform is `wechat_mp` or `bilibili` (cover optional)
- ❌ Fail: no cover review or status is `pending`/`reviewing`

### 3. Hashtags — 标签已生成

Check content metadata:
- ✅ Pass: `hashtags` array exists and has ≥ 1 item
- ❌ Fail: no hashtags → offer to generate via `title-hashtag.ts`

### 4. Title — 标题符合平台规范

Check title against platform rules from `title-hashtag.ts`:
- ✅ Pass: title length within `titleLengthRange` for the platform
- ⚠️ Warn: title exists but exceeds `maxTitleLength` → suggest trimming
- ❌ Fail: no title

### 5. Platform Set — 平台已指定

- ✅ Pass: `platform` field is set and is a supported value
- ❌ Fail: platform is empty or "unset"

### 6. Body Length — 正文字数达标

| Platform | Min chars |
|----------|-----------|
| xiaohongshu | 200 |
| douyin | 100 |
| wechat_mp | 800 |
| wechat_video | 100 |
| bilibili | 200 |

- ✅ Pass: body length ≥ platform minimum
- ❌ Fail: too short

## 执行流程

```
1. Load content via autocrew_content action="get"
2. Run checks 1-6
3. Build checklist output
4. If ALL pass → allow publish, transition to "publish_ready"
5. If ANY fail → block publish, show what needs fixing
```

## 输出格式

<output_template lang="zh-CN">
```
📋 发布前检查 — content-xxx (小红书)

✅ 内容审核：通过 (质量 78/100)
✅ 封面审核：已选定 A 方案
✅ Hashtags：8 个标签
✅ 标题规范：「标题内容」(16字，符合 10-18 范围)
✅ 平台设置：xiaohongshu
✅ 正文字数：856 字 (≥200)

🟢 全部通过，可以发布！
```
</output_template>

Or if something fails:

<output_template lang="zh-CN">
```
📋 发布前检查 — content-yyy (抖音)

✅ 内容审核：通过
❌ 封面审核：未完成 → 运行 autocrew_cover_review 创建候选
✅ Hashtags：5 个标签
⚠️ 标题规范：「标题太长了超过限制」(32字，超出 25 上限)
✅ 平台设置：douyin
✅ 正文字数：420 字

🔴 2 项未通过，请先修复再发布。
```
</output_template>

## 自动修复建议

检查失败时，提供具体修复方案：

| Failed Check | Suggested Action |
|-------------|-----------------|
| Content review | `autocrew_review` action="auto_fix" |
| Cover review | `autocrew_cover_review` action="create_candidates" |
| No hashtags | `generateHashtags(topic, platform, tags)` then update content |
| Title too long | `generateTitleVariants(topic, platform)` then pick shorter one |
| No platform | Ask user which platform |
| Body too short | Suggest expanding with more examples/data points |

## 与发布流程的集成

If all checks pass and user confirms:

1. Transition content to `publish_ready`:
   ```json
   { "action": "transition", "id": "<id>", "target_status": "publish_ready" }
   ```

2. Then proceed with the actual publish action (e.g. `autocrew_publish`).

## 变更日志

- 2026-04-01: v1 — Initial pre-publish checklist with 6 checks, auto-fix suggestions, and publish gate.
