# 执行记录、辅助方法与恢复

## 记录边界

`publish-plan.json` 仍是 AutoCrew 读取的发布源。不可将其 publication 回执迁走，也不可假定产品支持新 schema。
`execution-state.json` 只记录浏览器工作进度：space_id、page、phase、next_action、last_observation、last_error。
每平台保存独立条目。可用 phase：uploading、editing、verifying、submission_unknown、submitted、reviewing、scheduled、published、blocked。
每次阶段完成后保存；遇用户接管写 paused_by_user。恢复时先核对浏览器 ownership，再读取实际页面。
发布计划字段别名沿用现有项目；不要为了格式好看批量改已提交记录。

内容字段改变仍须按发布契约重跑 check。执行记录独立只是避免把浏览器进度混入内容，不能假定已经解决 AutoCrew fingerprint 问题。
最终点击前仍在 publish-plan.json 写实际 submitted_at 与 check_id。
表单提交同样先保存 submitting、字段来源和去重键，再点一次；结果不明不能重报。

## 浏览器辅助模块

在 `ego-browser nodejs` 内导入。Page 来自本任务的既有 taskSpace；不新开浏览器。

```js
const h = await import("/Users/jiaxintang/.codex/skills/publish-content/scripts/browser-helpers.mjs");
// selector 和 rootSelector 先从当前 DOM 验证，rootSelector 仅用于已观察到的 open shadow host。
const config = {selector: "[contenteditable]", rootSelector: null};
// 只在需要重填时调用。此操作会清空编辑器，先确认目标且发布包包含全文。
await h.replaceText(page, config, caption);
await h.focusEnd(page, config);
// 选择平台原生话题后使用 waitTopics；不要插入伪造标签 DOM。
await h.waitTopics(page, {...config, topicSelector: ".tiptap-topic"}, ["AI应用"]);
const readback = await h.readEditor(page, {...config, topicSelector: ".tiptap-topic"});
// assertReadback 独立比较描述文本与话题集合；失败不会改文案或继续发布。
h.assertReadback(readback, {caption, tags});
```

模块的原生 topicSelector 从平台手册起步，在当前页面确认。抖音用编辑器内的 `[contenteditable=false]`；视频号用 `.hl.topic`；小红书用 `.tiptap-topic`。
B站标签位于编辑器外，不用 readEditor 的 topicSelector；单独读实际标签列表并调用 assertReadback。
所有助手没有点击发布功能。模型仍负责 AI 声明、活动、排期、封面视觉核验和用户授权。

## 停止条件

- 上传没有进度：检查当前 input 与文件，不再次盲传。
- 文案读回不符：修正后重新比对。不要把重复正文当平台显示差异。
- 原生话题等待超时：观察候选与实际节点；一次有依据的替代仍失败，保留现场。
- 提交已点击：任何错误进入 submission_unknown，查管理页；不自动再次点击。
- 用户接管：停止空间和同一外部动作。不要以另一个 tab/工具继续。
- 产品回写失败：保留真实平台回执与待同步项，不修改平台作品来迁就登记。

## 验证与耗时记录

每平台记录开始、上传完成、表单完成、提交、回执时间；另计失败动作和用户介入次数。
本地检查/模拟 DOM 测试不证明真实网页可用。首次新手册用简单模型演练到“可提交”即可；真实发布必须有该作品的授权。
普通发布与活动研究分别计时。报告实际耗时，不承诺固定分钟数。

## 已确认的产品缺口（2026-10-15）

1. AutoCrew check 接受登记例外，但 video_kit/ego_lite_prepare 仍读旧稿状态。需在产品端统一检查来源；本 Skill 不绕过未授权 gate。
2. 视频号分享短链 weixin.qq.com/sph/... 已来自原生分享菜单，但 record 判 verified=false。需产品端识别域名与证据，不能仅凭接受一个 URL 就宣称公开可播放。
3. 示例字段与实际发布记录存在 post_id/item_id、public_url/url 差异。产品修复前保留原字段，不迁移已有数据。
