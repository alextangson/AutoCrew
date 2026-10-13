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
- 两层规矩，分工不同。档案（`start` 的 `rules`、`voice_samples`、`never`）是通用底线：说人话、真实、不编亲历、不和系列撞车、口播格式（交纯朗读正文，不写画面、镜头、停顿标注），任何体裁都守。体裁手册管结构：开头、中段、收获、收尾怎么搭。两者在结构上冲突时以手册为准；底线不让。
- 一条稿只认一本手册，就是立意时选的那本那一版（`angle` 回执和 `start` 的 `progress.playbook` 给全文）。手册中途升级，这条稿也不换。
- `save` / `angle` / `prepare_final` 之后的每条回复，结尾都给回执里的 `workbench_url`：`[在工作台打开第 N 版](<workbench_url>)`（N 是回执里的 `version`，`prepare_final` 用你交的 `base_version`）。
- 存盘失败（`storage_error` / `storage_unavailable`）就停下，把原始错误告诉创始人；不得把稿子写成库外文件继续推进。

## 1 衍生

`autocrew_draft {action:"start", inspiration:"<创始人原话>"}`；灵感对应已有选题就加 `topic_id`，一手材料跟着选题带回 `firsthand`（接手已有稿用 `content_id`，按回执的 `progress` 从断点接着做）。从灵感展开 3–5 个方向，每个一行：讲什么、给谁看。参照 `context.series` 别和最近几条撞主线。

## 2 调研

查这个方向的真事、真数据、同类视频怎么讲、哪条爆了。搜索、读网页都用你自己的工具。要在稿里引用的原话或数字，用 `verify_quote{content_id, url, quote}` 登记：服务端现抓原网页逐字比对，过了才进证据台账、回证据编号。被拒说明那段不在原文里，回原网页重新逐字复制。你自己的工具打不开原网页时，照样带 URL 调 `verify_quote`（服务端自己抓）；服务端也抓不到，这条就是未核验，不能当事实写。不用问创始人。

再花约 10 分钟收目标用户的原话：相关抖音视频的评论和提问（用 `ego-browser` 技能在创始人已登录的浏览器里只读看，不点赞、不评论、不发私信），和相关 YouTube 视频的评论（`npm run craft:fetch -- <视频网址> --comments 50`，结果在本机缓存里）。能收几条算几条，不凑数量，每条记出处链接。这些原话只当调研线索：不要用 `verify_quote` 登记，写进稿里一律按未核验材料处理。抖音看不了（没登录、页面变了）就如实告诉创始人，改用 YouTube 评论，不编。

## 3 立意

先读 `context.playbooks_index`：5 本体裁手册各自「什么时候选它」。按手上的材料判断每个方向适合哪种体裁——体裁由材料决定，不是由题目决定。`context.playbooks_error` 有值就停下告诉创始人，别凭记忆写。

给 3 个立意，每张卡标一个体裁，选卡即选体裁。每张包含：体裁、我们的判断（一句）、给谁看、一手素材（来自哪条 `firsthand` 或创始人原话；没有就写没有）、贯穿全篇的那个例子、爆点（观众能转述出去的那一句，以及它出现在第几秒）、开头 15 秒原话、为什么可能爆（引 `context.hits` 或对标视频的真实数字；没有数字就写没有）、4–6 行论证链。主线必须是我们自己的判断，外部资料只做证据。开头从用户原话、创始人的素材或我们的判断出发，不是你想象的场景；第一句点出一个具体对象（产品名、数字，或观众手上正在做的事）。开头、爆点位置等结构细节照那本手册。

实验演示必须有创始人亲手做过的事。没有现成亲历：先问他能不能当场做一次、做什么（实验设计可以你提，必须他做）；他说先不做，这张卡改走「信息差/产品」或「干货方法」，别编实验。

创始人没选定（如「A 和 B 都不错」）就追问一句：选哪个，还是合成一个。选定或改写后，`angle{content_id, base_version, genre, main_line, for_whom, opening, why_viral, chain, founder_words, chosen_option}`：`genre` 是那张卡的体裁 id（`ganhuo` / `shiyan` / `fanchangshi` / `xinxicha` / `renwu`），`founder_words` 照抄他的原话，`main_line` 写选中项的完整主线，`chosen_option` 放当时给他看的那个选项全文——他只回一个「B」，以后也看得懂。回执的 `playbook` 是那本手册的全文：之后写和改都照它。

## 4 写

按选定的主线、论证链和手册写全文，`save{content_id, base_version, title, body}`。`format_warnings` 有内容就改掉再存。

第一版存下后，自己跑一次 Codex 审稿（对照手册看主线、爆点、开头，只是参考）：把本技能目录下 `codex-review-prompt.md` 里的 `{{RULES}}`、`{{ANGLE}}`、`{{CRAFT}}`、`{{BODY}}` 换成档案规则、选定的立意、立意时选的那本手册全文（`angle` 回执或 `progress.playbook.text`；旧稿没有就写「无，按通用判据」）、当前正文，存成一个临时文件，再跑

```bash
codex exec --skip-git-repo-check --sandbox read-only - < 填好的提示词文件
```

最长等 8 分钟。把它输出的 JSON 原样用 `save{content_id, base_version, body:<同一版正文>, review_notes}` 附在这一版上，再摆给创始人参考；别据此自己大改。Codex 没装、没登录、超时或输出不合格，就把原因原文当 `review_notes` 附上，照常往下走。

## 5 改

创始人说改哪里就只改哪里，别的不动，改完 `save`。意见是方向性的、没指具体句子（如「缺用户心理洞察」）：先给一段简短诊断和具体改动清单，等他确认再动稿。不再重审；他要再审就按第 4 步再跑一次 Codex。他的意见改变了主线或受众，就回到第 3 步重出立意（已有调研保留），重新 `angle` 后再写；重写的第一版按第 4 步再跑一次 Codex 审稿。

每次按他的意见改完 `save`，都带 `feedback.founder_words`：他这次的原话，逐字。再判断这条意见是只管这篇，还是以后每篇都该这样：
- 只管这篇（针对某一句、某个例子）：不传 `lessons`。
- 针对这种体裁的写法（「干货稿开头要先亮名字」这类，换个体裁就不一定对）：放进 `lessons`，`scope` 是 `playbook:<体裁 id>`。它不进档案，而是挂成那本手册的待批提案；回执 outcome 是 `playbook_proposed` / `playbook_duplicate`（同文已在待批）/ `blocked_by_rejected`（他否决过）。
- 能推广到所有体裁：概括成一条通用写法（不照抄只针对这篇的话，≤200 字），放进 `lessons`，`scope` 是 `voice_core`（所有平台）或 `platform:douyin`。先对照 `start` 回执 `context.profile` 里的 `rules_detail`（生效）、`pending_rules`（待批）、`rejected_rules`（他否决过的）判断：意思已有 → `relation:"duplicate"` + `relates_to:<那条 id>`；和已有规则矛盾 → `"conflict"` + `relates_to`；否则 `"new"`。否决过的意思不要换个说法再提。

```json
{ "action": "save", "content_id": "…", "base_version": 4, "body": "…", "feedback": { "founder_words": "开头别再问「你是不是也」了", "lessons": [{ "rule": "开头不用「你是不是也……」式设问，直接从一个具体瞬间说起", "scope": "platform:douyin", "relation": "new" }] } }
```

改稿过程中不问他「以后都这样吗」，规则只记成待批，定稿时一次问。回执的 `lessons` 是每条的去向；有 `lessons_error` 说明这一版存了但规则没记进档案，把原因如实告诉他。

## 6 定稿

创始人在对话里说「定了」，你调 `prepare_final{content_id, base_version, citations}`：把稿中每处引述、数字、对外部事实的断言对上证据编号，对不上的给空数组。每项可带 `kind`：默认 `claim`（要出处的事实）；类比、编的例子（「打个比方」「我编个例子」）标 `example`，我们自己的判断标 `judgment`——这两种不列为没出处，工作台折叠放在「示意/判断，不需要出处」里。`text` 要是整句；句里有归因或台账对得上的数字时，标了也不生效。它出一份出处清单、把稿推到「等你认稿」。请创始人点工作台链接看清单、对没出处的项选保留或让你补，再点「定了」。「定了」只有他能点，你不能代替；之后再改正文，清单作废，要重新 `prepare_final`。

`prepare_final` 回执里的 `pending_lessons` 是这篇攒下的待批规则和手册提案（`kind:"playbook"` 的是手册提案，批的是 `approve_playbook` / `reject_playbook`）：在同一条消息里按编号列给他（规则原文 + 他当时的原话；有 `conflicts_with` 的把两条并排，让他选替换 / 都留 / 不要），附「现在生效 `active_rule_count` / `rule_cap` 条」。`repeated_rules` 是早就有、这次他又提的规则：告诉他「这条已有，说明它没管住」。他回「1、3 要，2 不要，4 替换第 X 条」后，先 `autocrew_review_inbox{action:"list", content_id}` 拿到每条的 `item_id` / `gen`，再逐条 `decide`：要 = `approve_rule`，不要 = `reject_rule`，替换 = `replace_rule` + `target_rule_id`，`founder_words` 照抄他的话。他只说「你定 / 都行」不算批准，问他要哪条；回 `rule_cap_reached` 就把现有生效规则列给他，问换掉哪条。手册提案同理：list 里 `type:"playbook_change"` 的那件，brief 有改前改后。他没回就不管，规则和提案留在「等你拍板」里。

```json
{ "action": "prepare_final", "content_id": "…", "base_version": 3, "citations": [{ "text": "稿里逐字的一句", "evidence_ids": ["ev-d1"] }, { "text": "打个比方，……", "evidence_ids": [], "kind": "example" }] }
```

## 「你定」

第 1 步或第 3 步创始人说「你定」：你可以自己选，但把选了哪个、为什么摆出来；第 3 步的 `founder_words` 记「你定」原话。

## 版本号

`save` / `angle` / `prepare_final` 都带 `base_version`：你最后读到的版本号（`start` 的 `progress.version`，之后每次 `save` 回执里的 `version`）。回 `version_conflict` 说明中间有人改过稿，多半是创始人在工作台手改：读回执里的 `latest_body` 和 `diff`，在最新版上重改，带 `latest_version` 再交，不要拿旧稿盖回去。
