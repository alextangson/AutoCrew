---
name: write-script
description: |
  抖音口播从一句灵感写到定稿：衍生 → 调研 → 立意 → 写 → 改 → 定稿。用户要写一条抖音口播、给了一句灵感、说「写一篇新的」「这条视频开工」时激活。这是真正动笔的技能。其他平台走旧流程（读 autocrew://writing-guide）。
---

# 抖音口播：灵感到定稿

你一个人在这个会话里写完一篇。AutoCrew（`autocrew_draft`）只存稿、给数据、核事实；流程由你按下面 6 步推进。创始人只在三处表态：选立意、提修改、说「定了」。

一个会话只做一篇。讲解片等别的作品另开会话。

## 硬规矩

- 没有素材不编亲历。一手材料只来自创始人的原话或 `start` 返回的 `firsthand`。
- 写作规则只有 `start` 返回的档案（`rules`、`voice_samples`、`never`），不另立一套。口播格式只补一条：交纯朗读正文，不写画面、镜头、停顿标注。
- 存盘失败（`storage_error` / `storage_unavailable`）就停下，把原始错误告诉创始人；不得把稿子写成库外文件继续推进。

## 1 衍生

`autocrew_draft {action:"start", inspiration:"<创始人原话>"}`（接手已有稿用 `content_id`，按回执的 `progress` 从断点接着做）。从灵感展开 3–5 个方向，每个一行：讲什么、给谁看。参照 `context.series` 别和最近几条撞主线。

## 2 调研

查这个方向的真事、真数据、同类视频怎么讲、哪条爆了。搜索用你自己的工具；要引用的网页用 `read{content_id,url}` 抓原文，再 `cite{content_id,page_id,quote}` 逐字登记，拿到证据编号。`cite` 被拒说明那段不在原文里，重新从 `read` 的原文复制。不用问创始人。

## 3 立意

给 3 个立意，每个包含：我们的判断（一句）、给谁看、开头 15 秒原话、为什么可能爆（引 `context.hits` 或对标视频的真实数字，没有就写没有）、4–6 行论证链。主线必须是我们自己的判断，外部资料只做证据。

创始人选定或改写后，`angle{content_id, main_line, for_whom, opening, why_viral, chain, founder_words}`，`founder_words` 照抄他的原话。

## 4 写

按选定的主线和论证链写全文，`save{content_id, title, body}`。第一版存下后 Codex 会在后台审一次（主线、收获、开头），只是提示：`review{content_id}` 取结果，摆给创始人参考，不据此自己大改。`format_warnings` 有内容就改掉再存。

## 5 改

创始人说改哪里就只改哪里，别的不动，改完 `save`。不再重审；他要再审才 `review{rerun:true}`。他的意见改变了主线或受众，就回到第 3 步重出立意（已有调研保留），重新 `angle` 后再写。

## 6 定稿

创始人在对话里说「定了」，你调 `prepare_final{content_id, citations}`：把稿中每处引述、数字、对外部事实的断言对上证据编号，对不上的给空数组。它出一份出处清单、把稿推到「等你认稿」。把回执里的 `workbench_url` 给创始人，请他在工作台看清单、对没出处的项选保留或让你补，再点「定了」。「定了」只有他能点，你不能代替；之后再改正文，清单作废，要重新 `prepare_final`。

```json
{ "action": "prepare_final", "content_id": "…", "citations": [{ "text": "稿里逐字的一句", "evidence_ids": ["ev-d1"] }] }
```

## 「你定」

第 1 步或第 3 步创始人说「你定」：你可以自己选，但把选了哪个、为什么摆出来；第 3 步的 `founder_words` 记「你定」原话。

## 被占用

回 `claim_held` 是另一个会话在写这篇：照实告诉创始人。回执说已闲置满 10 分钟时，他同意了才带 `takeover:true` 重试。
