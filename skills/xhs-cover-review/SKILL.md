---
name: xhs-cover-review
description: |
  小红书封面审核 skill。基于真实原型生成 A/B/C 三个不同结构候选，进入 review_pending，等用户选定后推进到 publish_ready。
---

# XHS Cover Review

## Purpose

Turn one saved draft into a structured Xiaohongshu cover approval flow.

## Rules

1. A / B / C must represent three different structural prototypes, not three color variants.
2. At least one variant should come from same-track references.
3. At least one variant should come from cross-track transfer.
4. Approval is mandatory before publish-ready.
5. Do not silently skip review and jump to publish.

## Tool Usage

Create candidates:

```json
{
  "action": "create_candidates",
  "content_id": "content-xxx"
}
```

Approve one:

```json
{
  "action": "approve",
  "content_id": "content-xxx",
  "label": "b"
}
```

## Output

Always report:

- review status
- the three prototype directions
- which cover was approved
