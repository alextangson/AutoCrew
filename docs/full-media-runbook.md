# 全媒体链路：一条中文视频 → 抖音四平台 + 公众号长文 + 英文版（YouTube / X）

更新于 2026-10-25。spec：`docs/specs/2026-10-23-full-media-english-and-wechat-spec.md`。下表「真跑」= 在创始人真实资料库和真实平台上走通过；「测试」= 只在自动化测试 / demo 里验证过。

## 一张图

```
写稿 → 认稿 → 拍 A-roll → 剪辑（Codex，ChatCut）→ 成片审过 ──┬─→ 中文封面 → 4 个视频平台发布包 → 发布（抖音/视频号/小红书/B站）
                                                            ├─→ 公众号长文（派生）→ 写稿/配图/封面 → 整包批 → 推草稿 → 编辑器收尾 → 扫码定时
                                                            └─→ 英文版（派生）→ 双语稿批 → 配音 → 对口型+英文字幕 → 英文成片审 → 缩略图 → 英文发布包批 → YouTube/X 定时
```

两条派生线只在「设置 → 运营平台」勾了对应平台时才开（公众号 / YouTube、X）。中文成片换版后，派生稿自动标「已过期」、发不出去，用 `rebind` 绑到新成片。

## 每一环谁来做、走通了没有

| 环节 | 谁做 | 状态 |
|---|---|---|
| 中文：写稿 → 剪辑 → 审片 → 发 4 平台 | 会话写稿；Codex 剪辑（ChatCut）；创始人认稿/审片/扫码 | 真跑（已在用） |
| 公众号：派生、写稿、自审、标题、配图（Codex 生图 + 官方图）、封面（沿用视频封面重排）、整包批 | Claude/Codex 会话 + 创始人批 | **真跑**（10-24「深度思考」） |
| 公众号：推草稿、编辑器收尾（声明、视频号卡片、定时）、扫码 | 会话用 ego-lite；创始人扫码 | **真跑**（10-24 定时 21:00） |
| 英文：派生 | 会话 | 真跑 |
| 英文：双语稿、配音、对口型、字幕、缩略图、英文发布包、YouTube/X 发布 | 前台会话 + 创始人确认付费 / 扫码登录 | 测试 + 10-23 demo；**整条没真跑过** |

## 让链路通的三个前提（这次真跑踩出来的）

1. **剪辑时字幕必须单独一条轨，并且多导一版「无字幕母版」，用 `record kind=clean_master` 登记。** 英文版要在干净画面上换配音、压英文字幕；没登记母版时 `edition op:dub` 直接拒，回执的 next_action 写明怎么登记。剪映里把字幕烧进画面导出的老视频，英文版没法做（「深度思考」就卡在这）。
2. **成片字幕要登记进资料库**（`record kind:srt` 绑这版成片）。公众号长文按它写，英文配音按它卡时间。没登记时公众号退回用定稿正文，英文版直接拒。
3. **ElevenLabs 的 Voice ID 要填。** 设置 → 接入更多 → 英文版配音：Voice ID 填 `E3xCuJvK3vXyJgMz1CqP`（Key 已在钥匙串，可留空）。不填第一次配音必失败。

## 交给 Codex 时要说什么

Codex 的剪辑技能包在 `~/.codex/skills/personal-ip-video-loop`（真实目录，不随仓库更新）。仓库里的新规矩它**不会自己知道**，在派活时加下面这段（或请会话把它写进技能包）：

### 中文剪辑时追加（每条视频都要）

```
这条视频之后要出英文版和公众号长文，所以剪辑交付多两件事：
1. 字幕保持为 ChatCut 里单独的一条字幕轨，不要烧进画面后再接着剪。
2. 成片审过之后，除了带字幕的成片，再导出一版同样剪辑、同样 B-roll 和配乐、但关掉字幕轨的「无字幕母版」，1920×1080；文件名带「无字幕」。
3. 用 autocrew_content record 登记：带字幕的成片 kind:cut；成片字幕 kind:srt（绑这版成片，时间要和成片一致）；无字幕母版 kind:clean_master captions_off:true（绑审过的成片；AutoCrew 核 1920×1080、有音轨、时长和成片差不过 0.5 秒，字幕有没有烧进画面查不出来，captions_off 是剪辑方的声明）。
```

### 英文版剪辑（对口型 + 英文字幕）

这一段**要在前台做**：ChatCut 付费生成（配音、对口型）只有 ChatCut 窗口开着、有人点确认才放行；后台跑的 Codex 任务（审批策略 never）会被直接拒。所以要么在这个 Claude 会话里做，要么创始人开着 Codex 应用、在场点确认时让 Codex 做。让 Codex 做时这样说：

```
做英文版剪辑，英文版 content_id=<英文版 id>，按仓库 skills/video-session/references/en-edition-recipe.md 一步步做。
先确认：英文脚本已批、dub 已出（edition op:status / dub）。
ChatCut 动手前 mkdir ~/.cache/autocrew-yt/chatcut.lock，做完放锁；开着 ChatCut 窗口（target_project openWindow=true），每次付费生成前先报价等我确认。
画面用 edition op:dub 回执里的 picture_source（源视频登记的无字幕母版，kind=clean_master）；口型参考视频要带原中文人声、小于 50MB（超长就切段）；字幕用 edition op:captions 的 burn_command。
做完 record kind:cut / kind:srt / kind:aroll 到英文版这条稿，mark_ready，等我在「等你拍板」里审片。
```

## 一条视频完整走一遍（会话侧的调用顺序）

**公众号**：`autocrew_content {action:"wechat_article", content_id:<源视频>, article:{op:"derive"}}` → `autocrew_writer pack`（复用源视频调研）→ 写 → `submit` → `review_desk` 自审 → `set_titles` → `generate_images` / `attach_web_image` → 封面（Codex 按视频封面重排成左字右图横幅）`set_cover` → 创始人选标题、声明（`choose_title` / `set_creation_source`）→ 「等你拍板」整包批 → `push_draft`（先 `dry_run`）→ `begin_editor` → ego-lite 按 `skills/publish-content/references/wechat-mp.md` → `final_check` → 点发表 → 扫码 → `record_scheduled` → 到点后 `record_scheduled published:true`。

**英文版**：`en_edition derive` → `source` → `set_script`（双语、换例带出处）→ 「等你拍板」批稿 → Codex 出 16:9 缩略图 → `set_thumbnail` → `dub` → 前台剪辑（上面那段）→ 英文成片审 → `chapters` → `autocrew_pre_publish video_kit`（youtube / x）→ 「等你拍板」批英文发布包 → `ego_lite_prepare` → 按 `youtube.md` / `x.md` 定时，点之前 `final_check`。

## 真跑时要知道的坑

- 公众号接口要 IP 白名单；家里宽带 IP 会变，推送报 40164 就去后台加当前 IP。
- 公众号排版主题在资料库自己的设置里（`~/.autocrew/libraries/<库 id>/workspaces/default/publish.json` 的 `wechatMp.theme`），不是 `~/.autocrew/publish.json`。现在是 `claude-scroll`。
- 编辑器草稿卡片的两个图标没有文字，先悬停看提示（删除 / 编辑）再点；时间选择器要发完整鼠标事件；点发表后还有一层「继续发表」确认；扫码框不是普通弹窗。
- ego-lite 在后台时截图会超时：要截官方图，取页面元素在本机渲染。
- 旧流程导入的视频：没有新流程审片记录时按旧的「成片完成」标记认；视频号已发但发布台没确认时，按资料库里的发布回执算已公开。
