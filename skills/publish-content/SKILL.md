---
name: publish-content
description: >
  用 ego lite 将已审核视频发布到抖音、视频号、小红书和 B站，核查活动、安排排期、保存回执并回填已授权活动表。
  支持中断恢复；制作或封面审核本身不授权投稿。
---

# 视频发布

目标：执行已批准发布包，保存每个平台的真实结果。主流程负责路由；一次只读当前平台手册。
所有网页操作用 `ego-browser`。首次读它的 Skill 和用户 managed overrides，遵守当前 API。
昵称默认哈姆雷鹿，仍须核对目标账号稳定 ID。不同平台共用同一视频的 content_id。

## 先决定从哪里继续

读项目 `06-publish/publish-plan.json` 和 `06-publish/execution-state.json`（若有）。
已有回执优先于口头进度；已提交不重新上传。结果不明先查作品管理。
用户接管时停止整个空间和同一外部操作；明确交回后恢复同一空间。

| 当前情况 | 下一步与必读材料 |
|---|---|
| 缺发布包、首次执行、授权或检查有疑问 | [发布契约](references/publishing-contract.md)，完成来源、素材、授权和 AutoCrew 检查 |
| 需要活动匹配或返稿 | [活动与跟进](references/campaigns-and-followup.md)；候选缓存只是线索，参与前核实有效规则 |
| 发布包已检查且授权完整 | 运行下述本地核验，再读当前平台手册 |
| 已提交/审核中/定时中 | 只查回执、公开状态和到期返稿；不再次点击发布 |
| 异常或恢复任务 | [执行与恢复](references/execution.md)，按已保存的下一步继续 |

## 正常执行顺序

1. 准备账号、完整文案、原生话题清单、封面槽、AI/商业声明、活动、带时区排期。
2. 按发布契约运行 AutoCrew check；告知四平台活动计划。复用覆盖同一发布件的已有授权，不重复问。
3. 固定本轮发布内容。先核对本地文件和页面账号，再上传。上传中允许填表。
4. 按当前平台手册填写。每个有异步结果的动作，等成功条件成立后继续。
5. 集中读回标题、完整描述、话题、声明、活动、排期；逐槽核对封面裁切。
6. 最终点击前，把 check_id、实际 submitted_at、submission_unknown 写入 publish-plan.json。
   获授权且检查通过才点击一次；本地脚本不能授权发布。
7. 保存平台回执，再转下一平台。公开后完成已授权返稿，用 AutoCrew record 登记真实结果。

平台手册：[抖音](references/douyin.md) · [视频号](references/wechat-video.md) ·
[小红书](references/xiaohongshu.md) · [B站](references/bilibili.md)。

## 本地辅助工具

```bash
python3 /Users/jiaxintang/.codex/skills/publish-content/scripts/preflight.py /绝对路径/06-publish/publish-plan.json
```

脚本只核查文件、哈希、必要字段和恢复状态，不替代 AutoCrew check、人工授权或网页核验。
退出码非零时按报告修正，不能用它改审批记录。

富文本读回与话题等待使用 [browser-helpers.mjs](scripts/browser-helpers.mjs)，用法见
[执行与恢复](references/execution.md)。它只通过传入的 ego Page 操作 DOM；不发布、不上传、不读取私有框架状态。

## 执行纪律

- 一批发布只用一个 ego 空间。优先完成一个平台的填写、提交、回执；等待上传时才切换其他已准备平台。
- 结构定位优先。不要固定本次 ref 或坐标；遇 shadow DOM 用已观察到的控件上下文。
- 工具调用成功不等于操作成功。文案看读回，上传看进度/完成，封面看保存后的槽位。
- 一次失败后检查状态；同一路径不盲试。一次有依据的替代仍失败，就保留现场和精确阻碍。
- 已核对且未变的字段不反复抓整页。截图留给封面裁切、无语义控件和结果证据。
- 简单模型执行已确定发布包；内容修改、陌生页面结构、未知提交结果进入异常处理，不自行猜测。
- 保留 published、submitted、reviewing、scheduled 的区别；AutoCrew 登记结果单独记录。
- check 与旧打包入口冲突时，不反复调用或伪造注册。沿用用户已授权的例外范围；未覆盖的阻碍按发布契约处理。
- 完成后按 ego Skill 收尾。审核等待或系统登记缺陷不等于发布失败，准确报告剩余项。
