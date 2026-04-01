# Session 7 完成内容

修改 5 个文件，新建 1 个文件：

## 1. `src/tools/rewrite.ts` — 增强

- 新增 `batch_adapt` action：传入 `target_platforms` 数组，内部循环调用 `adaptPlatformDraft`
- 每次 rewrite 后自动调用 `generateForPlatform()` 生成标题变体 + hashtag，写入返回值
- `save_as_draft: true` 时自动建立 sibling 关系（包括源 content_id）
- 重构为 `resolveSource()` + `adaptOne()` 内部函数，消除重复代码

## 2. `src/tools/pre-publish.ts` — 新建

实现 `autocrew_pre_publish` tool，6 项检查：
1. 内容审核（调用 `executeReview` full_review）
2. 封面审核（XHS/Douyin 必须，其他 skip）
3. Hashtags ≥ 1
4. 标题符合平台字数规范（读取 `getPlatformRules`）
5. 平台已指定
6. 正文字数达标（按平台最低要求）

全部通过 → 自动 transition 到 `publish_ready`
任一失败 → 阻断发布，给出具体修复建议

## 3. `mcp/server.ts` — 注册新 tool

- 新增 `autocrew_pre_publish` tool 注册
- 更新 `autocrew_rewrite` description 反映 batch_adapt

## 4. `index.ts` — 注册新 tool + CLI

- 新增 `autocrew_pre_publish` tool 注册
- 新增 CLI 命令 `openclaw crew pre-publish <content-id>`
- 更新 `autocrew_rewrite` description

## 5. `templates/TOOLS.md` — 更新

- 补充 `autocrew_pre_publish` tool 说明
- 更新 `autocrew_rewrite` 说明（含 batch_adapt）

---

# Session 8 建议任务

**主题：端到端测试 + publish 流程闭环**

1. **端到端冒烟测试**
   - 创建 `tests/e2e/pipeline.test.ts`
   - 测试完整流程：topic → write → rewrite(batch) → review → pre-publish → publish
   - 验证 sibling 关系正确建立

2. **publish tool 增强**
   - 在 `executePublish` 前自动调用 `executePrePublish` 作为 gate
   - 如果 pre-publish 未通过，阻断发布并返回 checklist

3. **batch-adapt CLI 命令**
   - 新增 `openclaw crew batch-adapt <content-id> --platforms xhs,douyin,bilibili`
   - 一条命令完成多平台改写

## 需要读取的文件

- `src/tools/publish.ts`（增强 gate 逻辑）
- `src/tools/rewrite.ts`（已完成）
- `src/tools/pre-publish.ts`（已完成）
- `index.ts`（新增 batch-adapt CLI）
