---
name: content-review
surfaces: gui, harness
gui_summary: 审查本次规划、事实和表达，并解释实际受众点评与待处理项
description: 内容审核：区分机械检查、语义审稿、受众建议与作者认可，定位具体问题，不制造质量分数。
trigger: 当用户说“审核”“review”“检查内容”“这篇能发吗”时触发
---

# 文案审核

由当前宿主读目标稿全文、本次要求与证据，判断规划、主张、事实和表达。普通 MCP 审稿不依赖后台模型配置；单个模型切换角色仍是自审，不能称为独立审稿。

## 正式交稿链

新稿或正式修改按 `write-script`：`autocrew_workflow prepare → 宿主调研与选角 → autocrew_writer pack → 宿主写作 → submit`。默认 `review=host`，收到 `awaiting_host_review` 后执行：

1. `autocrew_review_desk {action:"pack", content_id}` 领取当前版本的审稿包，通读 `system` / `user`、规划、证据与正文；保存 `review_pack_id`、写稿 `attempt` 和 `draft_hash`。
2. 宿主实际完成规划、事实、表达和受众检查。按返回 schema 组织 `issues`；逐项引用原句、原因及建议，空问题仅用于确实审完且未发现问题的稿件。
3. `autocrew_review_desk {action:"submit", content_id, review_pack_id, attempt, issues}`，按工具 schema 可附 `audience`。不提交过期稿的结果，不改写写稿 attempt 或伪造其他审稿人的身份。
4. `autocrew_writer {action:"submit_status", content_id}` 核对实际状态。阻断项需修改并重新交审；已收稿仍需披露残留问题。`accepted_unreviewed` 明确未审，不能说通过。

正式提交示例（标识与原句须替换为本次审稿包的真实值）：

```json
{
  "action":"submit",
  "content_id":"content-current",
  "review_pack_id":"review-current",
  "attempt":1,
  "issues":[{
    "severity":"advisory",
    "quote":"这段话反复解释同一件事",
    "rule":"重复影响阅读",
    "instruction":"合并重复解释，保留已明确的事实与原意。"
  }]
}
```

回执 `review_source.kind=host_self_review` 表示单宿主自审，质量标记为 `host_self_reviewed`；其他宿主审阅按实际来源报告，仍不能自动宣称独立评审。用户认可与发布批准始终分开。

`audience_review` 有实际提交的结果才解释读者反应与流失位置；`unavailable` / `skipped` 报告原因。模拟受众建议不等于真实用户测试，也不强迫写手改成统一套路。

只有用户明确选择后台审稿时才使用 `review=engine`；默认不为审稿探测端点或要求配置 engine。`review=none` 表示明确跳过，不是自审通过。

## 单独点评已有稿

`autocrew_content {action:"get", id}` 读全文，`autocrew_editorial {action:"inspect", content_id}` 核对版本与反馈。只要求点评就给对话审阅，不改正文或批准状态；要正式记录审稿结果才走 review_desk，按实际工具前置条件执行。

基础检查可用 `autocrew_review {action:"full_review", content_id}`，它只检查机械文字与格式，不能提供可靠 AI 痕迹判断或语义质量通过。需要改稿则带原 `content_id`、`topic_id`、`platform` 与 `force:true` 重领写作包，不另建副本。

## 判断标准

- 规划：读者、目的、主张、提纲、必写与禁写是否兑现。
- 事实：证据的对象、时间、范围与上下文是否支撑主张；数字命中不等于说法成立。
- 表达：空话、重复、跳跃和过度包装是否影响理解。长句、专业词、没有反问或 CTA 本身不是错误。
- 受众：读者得到什么、哪里会困惑或失去兴趣，说明推断依据与限制。

用“问题原句 → 为什么影响本稿 → 建议怎么改”。真实用户反馈通过 `memory-distill` 保存；模型不能给自己写用户采纳。发布前另走 `pre-publish`，搜索、图像和视频额度仍与宿主模型独立。

## GUI

本节仅供 AutoCrew 工作台加载；纯 MCP 宿主执行上文。

1. 用 `get_draft` 读当前全文；不确定对象时先 `list_drafts`。结合上下文已有写作要求与真实材料，检查规划、事实、论证和表达，不给虚假的 AI 痕迹分数或质量总分。
2. 当前可见 `audience_review` 时，用稿件 id 请求受众停留点评，说明哪类人可能停留、哪句可能流失。画像未校准或审稿失败时如实披露；模拟意见不能当真实用户测试。
3. 用户只要求审阅时给具体问题与建议，不改正文、不替作者批准。用户要求修改时，有当前修改焦点就用 `revise_focus` 出提案；否则按问题范围用 `revise_draft`，不为审稿强制添加 CTA、反常识问句或数字。
4. 改稿后的结果不沿用旧的审稿结论。模型未见的材料要说明缺口；不能把文本检查通过说成已批准发布。
