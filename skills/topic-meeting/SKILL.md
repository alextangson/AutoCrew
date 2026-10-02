---
name: topic-meeting
description: |
  选题会：用账号定位 + 回流数据给下一批内容下注，并对上次的下注对账。创作者说「开选题会」「这周写什么」「内容规划」「帮我找选题」「排一下这周的片单」时使用。产出是本周片单和可证伪的下注，不开工写稿。
---

# 选题会

这场会要回答一件事：下一批写什么，凭什么，赌它怎么样。灵感库的入库分和立意卡的证据分都不代表传播潜力，所以数字只从简报里来，判断由创作者拍板。条数和配比当场问，不预设。

## 开会

1. **读简报** `autocrew_insights {action:"meeting_brief"}`。返回 `ok:false` 就停会：把原始错误告诉创作者，不凭记忆开会。`brief.attention` 里的每一条（回流未开启/过期、未绑定作品、冷启动、量纲未核的指标）开场先说。
2. **对账** `brief.pendingBets`：逐条报 中 / 没中 / 数据不够 / 未到期 / 无法对账 和 `reason`。「中」= 高于同平台同龄基线中位数。中或没中的，问创作者一句「按当时手里的信息重来，还会这么选吗」，原话记下；「无法对账」的把 `unmatched` 念给他，确认是哪条作品。
3. **补标签** `brief.untagged`：已发作品缺形式（教学/观点/亲历/案例/测评）或画像（core/adjacent/surprise）的，一次问清，逐条 `autocrew_insights {action:"meeting_tag", tag:{work_key, format, persona_key}}`。
4. **出候选**：来自灵感库（`autocrew_topic {action:"list"}`）和你提的新题（如爆款续集）。新题用 `autocrew_topic {action:"create", source:"meeting"}` 入库，描述里标「待调研」。灵感库空或都不合适，就只提真想写的，不凑数。每个候选写清：
   - 给谁看：档案画像层 key + 当前名字（`brief.personas`）
   - 观众拿走什么：看完能做的一件事或能下的一个判断。「看懂 X」「了解 X」不算，保存时会被拒
   - 形式与内容线；为什么现在
   - 数据依据：引简报里具体作品和数字；没有就写「无数据依据，纯判断」
   - 赌什么：一句可证伪的话，落成 `watch{platform, metric, day: 3|7}`，metric 只能从 `brief.availableMetrics` 该平台里选
   - 事前验尸：到期没中最可能的一个原因，给最强的那个
5. **拍板**：创作者选中、改或毙。每个选中位由他给「高于基线中位数」的概率（具体百分数），你不代填。
6. **落库**：先 `autocrew_insights {action:"meeting_get"}` 拿 `revision`（新会为 0），再
   `autocrew_insights {action:"meeting_save", meeting:{expected_revision, slots, rejected, reviews}}`；slot 字段见工具说明 `autocrew://tool-guide/autocrew_insights`。一个都没选也要存（空片单 + 毙题理由）。报 `conflict` 说明别的会话刚存过：重读、给创作者看差异，再存。

## 用数字的规矩

- 引用分组或基线必须带 n；`status:"insufficient"`（n<5）只列数，不下结论。
- 只在同平台同天龄（D+3/D+7）之间比较；离群作品（`brief.outliers`，>5× 同平台中位数）单独说，不进基线。
- 冷启动期（回流刚开，前 4–6 周）基线大多不够：照样下注，如实说「数据不够」，不拿累计数冒充同龄比较。
- 简报里标 `unverified`（「未核」）的指标只能参考。

## 边界

- 选中≠开工：片单只在看板「选题」列置顶并打「本周片单」标签。写稿仍是一条一个会话（`video-session`），这里不开写稿窗口。
- 选中的题已经在写或被认领：`meeting_save` 回执的 `topicStatus` 会写明，照实告诉创作者，不新建、不抢认领。
- 选中的题已有立意卡或选中角度：保存会被拒，先问创作者「重跑立意」还是「接受偏离」，填进该位 `angle_decision`。
- 会议位让选题免于 3 天自动过期，只到下次开会；下次没再选中就恢复正常过期。
- 纪要自动出现在「我的内容/选题会」，不要手写文件。
