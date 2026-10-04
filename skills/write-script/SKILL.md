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
- `save` / `angle` / `prepare_final` 之后的每条回复，结尾都给回执里的 `workbench_url`：`[在工作台打开第 N 版](<workbench_url>)`（N 是回执里的 `version`，`prepare_final` 用你交的 `base_version`）。
- 存盘失败（`storage_error` / `storage_unavailable`）就停下，把原始错误告诉创始人；不得把稿子写成库外文件继续推进。

## 1 衍生

`autocrew_draft {action:"start", inspiration:"<创始人原话>"}`；灵感对应已有选题就加 `topic_id`，一手材料跟着选题带回 `firsthand`（接手已有稿用 `content_id`，按回执的 `progress` 从断点接着做）。从灵感展开 3–5 个方向，每个一行：讲什么、给谁看。参照 `context.series` 别和最近几条撞主线。

## 2 调研

查这个方向的真事、真数据、同类视频怎么讲、哪条爆了。搜索、读网页都用你自己的工具。要在稿里引用的原话或数字，用 `verify_quote{content_id, url, quote}` 登记：服务端现抓原网页逐字比对，过了才进证据台账、回证据编号。被拒说明那段不在原文里，回原网页重新逐字复制。你自己的工具打不开原网页时，照样带 URL 调 `verify_quote`（服务端自己抓）；服务端也抓不到，这条就是未核验，不能当事实写。不用问创始人。

## 3 立意

给 3 个立意，每个包含：我们的判断（一句）、给谁看、开头 15 秒原话、为什么可能爆（引 `context.hits` 或对标视频的真实数字，没有就写没有）、4–6 行论证链。主线必须是我们自己的判断，外部资料只做证据。

创始人没选定（如「A 和 B 都不错」）就追问一句：选哪个，还是合成一个。选定或改写后，`angle{content_id, base_version, main_line, for_whom, opening, why_viral, chain, founder_words, chosen_option}`：`founder_words` 照抄他的原话，`main_line` 写选中项的完整主线，`chosen_option` 放当时给他看的那个选项全文——他只回一个「B」，以后也看得懂。

## 4 写

按选定的主线和论证链写全文，`save{content_id, base_version, title, body}`。`format_warnings` 有内容就改掉再存。

第一版存下后，自己跑一次 Codex 审稿（只看主线、收获、开头，只是参考）：把本技能目录下 `codex-review-prompt.md` 里的 `{{RULES}}`、`{{ANGLE}}`、`{{BODY}}` 换成档案规则、选定的立意、当前正文，存成一个临时文件，再跑

```bash
codex exec --skip-git-repo-check --sandbox read-only - < 填好的提示词文件
```

最长等 8 分钟。把它输出的 JSON 原样用 `save{content_id, base_version, body:<同一版正文>, review_notes}` 附在这一版上，再摆给创始人参考；别据此自己大改。Codex 没装、没登录、超时或输出不合格，就把原因原文当 `review_notes` 附上，照常往下走。

## 5 改

创始人说改哪里就只改哪里，别的不动，改完 `save`。意见是方向性的、没指具体句子（如「缺用户心理洞察」）：先给一段简短诊断和具体改动清单，等他确认再动稿。不再重审；他要再审就按第 4 步再跑一次 Codex。他的意见改变了主线或受众，就回到第 3 步重出立意（已有调研保留），重新 `angle` 后再写；重写的第一版按第 4 步再跑一次 Codex 审稿。

## 6 定稿

创始人在对话里说「定了」，你调 `prepare_final{content_id, base_version, citations}`：把稿中每处引述、数字、对外部事实的断言对上证据编号，对不上的给空数组。每项可带 `kind`：默认 `claim`（要出处的事实）；类比、编的例子（「打个比方」「我编个例子」）标 `example`，我们自己的判断标 `judgment`——这两种不列为没出处，工作台折叠放在「示意/判断，不需要出处」里。`text` 要是整句；句里有归因或台账对得上的数字时，标了也不生效。它出一份出处清单、把稿推到「等你认稿」。请创始人点工作台链接看清单、对没出处的项选保留或让你补，再点「定了」。「定了」只有他能点，你不能代替；之后再改正文，清单作废，要重新 `prepare_final`。

```json
{ "action": "prepare_final", "content_id": "…", "base_version": 3, "citations": [{ "text": "稿里逐字的一句", "evidence_ids": ["ev-d1"] }, { "text": "打个比方，……", "evidence_ids": [], "kind": "example" }] }
```

## 「你定」

第 1 步或第 3 步创始人说「你定」：你可以自己选，但把选了哪个、为什么摆出来；第 3 步的 `founder_words` 记「你定」原话。

## 版本号

`save` / `angle` / `prepare_final` 都带 `base_version`：你最后读到的版本号（`start` 的 `progress.version`，之后每次 `save` 回执里的 `version`）。回 `version_conflict` 说明中间有人改过稿，多半是创始人在工作台手改：读回执里的 `latest_body` 和 `diff`，在最新版上重改，带 `latest_version` 再交，不要拿旧稿盖回去。
