---
name: topic-meeting
description: |
  选题会：针对一个选题（或只是一句灵感），派几路调研从不同维度并行查，出 3–4 张立意卡，由创始人用原话定一张或给出自己的角度——定了才能开写。创作者说「开选题会」「这个题怎么写」「帮我想想这个角度」「写一篇新的」，或开写入口回 needs_founder_angle 时使用。产出是创始人选定的立意，不写稿。
---

# 选题会

抖音口播不开这个会：走 `write-script`（立意在它的第 3 步由创始人定）。这里只用于其他平台。

一条内容开写前的最后一道关：先把这个题从几个方向查透，摆出几张真正不同的立意卡，由创始人拍板。你负责查、整理、推荐；选哪张只能是创始人的原话。没有跳过选卡或跳过调研的通道。

## 开会

1. **定题**：已有选题用 `topic_id`；只有一句灵感就 `autocrew_workflow {action:"prepare", inspiration:"<原话>", platform, requirements}`，会自动建题。创作者自带材料用 `research_mode:"provided"` + `research`，照样要出卡。
2. **领任务**：prepare 回 `awaiting_host_research` 和 `research_task`。五路调研：受众 audience、证据 evidence、反方 counter、对标 benchmark 四个视角，加一路「账号数据」（工具按排期会简报确定性生成，不用你查）。
3. **并行查**：能派子代理就并行。对每个缺的视角调 `autocrew_scout {action:"claim", topic_id, task_id, perspective}`，把回执里的 `perspective_token` 和 `pack` 交给一个子代理；子代理的 `search` / `read_page` / `cite` / `perspective` 提交都带这枚令牌。同一视角已被领走会回 `perspective_claimed`，换一个。不能并行就自己按 `next_action` 一路一路做。
4. **钩子查证**并在证据视角里：开头钩子要用的事实，必须来自 `read_page` 抓回的原文并 `cite` 过。
5. **失败要看得见**：某一路查不下去就 `fail_perspective{perspective, reason, perspective_token}` 写明原因；回执的 `perspectives` 一直摆着 failed / timed_out（令牌闲置 30 分钟算超时）。补材料后重新 `claim` 那一路重跑；账号数据失败用 `account_data` 重跑。五路不齐 `synthesize` 会拒，不要硬凑。
6. **综合 → 出卡**：`synthesize` 交综合，再按回执 `pack` 交 `angles`：3–4 张真正不同的卡。每张写清主张、证据、缺口、观众拿走什么（看完能做的一件事或能下的一个判断），以及 `why_may_perform`——只引账号数据里的数字并带 n，没有就照写「无数据依据」。转发尴尬（只提醒、不扣分）：观众把这条转给同事朋友会不会暴露不想暴露的处境，有就在卡上提一句。

## 让创始人定

- 把每张卡的主张、证据、缺口、观众收获、数据依据摆给他看，说你推荐哪张、为什么；不替他选。
- 他选了：`autocrew_workflow {action:"select_angle", topic_id, angle_id, brief_revision, founder_words:"<他的原话>"}`；他改了卡面就加 `card`。
- 他要写自己的角度：`select_angle{topic_id, direction:"<角度>", founder_words:"<他的原话>"}`，之后 prepare / pack 带同一句 `direction`。
- `founder_words` 照抄他这轮说的话，不转述、不代填；他还没表态就停下来问。
- 回 `ready_to_write` 才算开完会，按 `next_action` 领写作包开写（视频走 `video-session`）。

## 边界

- 已有真稿的选题（存量稿、改稿、真稿的平台变体）和创作者手动导入的成稿不用开会。
- 开写入口回 `needs_founder_angle` 就是这场会还没开完；回 `angle_gate_read_failed` 是稿件或选题记录读不出，把原始错误告诉创作者，停下。
- 排期会（`schedule-meeting`）是可选的周度排期，不替代这里。
