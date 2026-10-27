# 改名清单：AutoCrew → Director's Chair · 导演椅（2026-10-27 创始人已定）

2026-10-27。起因：GitHub 上有同名的 CrewAI 工具（yanniedog/Autocrew，187★），「crew」在开发者圈约等于 agent 框架，招来的是程序员不是创作者。新名点题「你只管创作和拍板」：你坐导演椅，剧组替你干活。

原则：**对外全换，对内的机器标识先不动**。已经装了的人、已经接好的 Claude Code / Codex 配置一个都不用改。

## 1. 对外要换的（用户看得到）

| # | 位置 | 现在 | 改成 | 规模 |
|---|---|---|---|---|
| 1 | GitHub 仓库名 | alextangson/AutoCrew | alextangson/directors-chair | 设置里点一下；GitHub 自动把旧地址跳到新地址，老用户 pull / 更新提示照常 |
| 2 | 仓库简介、topics | 空 | 「导演椅 Director's Chair：中文创作者的开源 AI 新媒体团队，你只管创作和拍板」 | 1 处 |
| 3 | 工作台网页标题 | 「AutoCrew 编辑部」 | 「导演椅」 | 1 处 |
| 4 | 工作台界面文案 | 29 个文件、82 处「AutoCrew」 | 中文界面一律「导演椅」 | 机械替换 + 逐处看语句通不通 |
| 5 | 服务端会显示给用户的中文提示 | 约 167 处（报错、通知、引导、同步出错文件等） | 「导演椅」 | 同上；只改会出现在界面/通知/文件里的，测试里断言的文案同步改 |
| 6 | README、CHANGELOG 抬头、docs/SETUP-FOR-AGENTS.md | AutoCrew + 旧仓库地址 | 新名 + 新地址 | 一起改，顺带把 README 过时的两段换掉（上一轮草稿） |
| 7 | 其他 docs（约 100 个文件） | 历史规格、复盘 | **不改**：是历史记录，改了反而对不上当时的提交 | — |
| 8 | 官网产品页 s-tello.com/autocrew | 旧名 | 新路径 /directors-chair，旧路径跳转过去 | 本地 s-tello 仓库里没搜到这一页的源码，需要你告诉我在哪 |
| 9 | 两支宣传片片尾（MCP 宣传片、《催更》） | 画面里写死 AutoCrew | 待你定：重渲片尾 / 先不动 | 要重渲就是两支片子各一次导出 |
| 10 | 发版 | — | 改完发 v0.7.0，更新说明第一条写「AutoCrew 改名叫导演椅了，用法不变」 | — |

## 2. 对内先不动的（机器标识）

| 位置 | 为什么不动 |
|---|---|
| 命令行 `autocrew`（`autocrew doctor/update/init`） | 用户的脚本、文档、agent 安装步骤都写的是它 |
| MCP 服务名 `autocrew`、31 个 `autocrew_*` 工具名 | 每个人的 Claude Code / Codex / WorkBuddy 配置和技能包里都写死了；一改全部断连 |
| `~/.autocrew` 配置目录、`AUTOCREW_*` 环境变量 | 改了老用户的密钥和设置就找不到了 |
| `package.json` 的 name | 不发 npm，没人看得到 |
| 你的资料库文件夹 `~/AutoCrew资料库` 和 NAS 上的路径 | 改路径要整库迁移，风险大收益零 |

补一条防混淆：MCP 服务说明里加一句「导演椅（Director's Chair，原名 AutoCrew）」，这样用户跟 agent 说「导演椅」，agent 知道就是这套 `autocrew_*` 工具。

## 3. 定案（2026-10-27）

1. 仓库名 `directors-chair`
2. 宣传片片尾先不动
3. 官网产品页由会话去找源码
4. 新用户资料库默认名不改

## 4. 注意

- 改名后**永远不要再在 alextangson 下建一个叫 AutoCrew 的仓库**：那样会截断旧地址的跳转，老用户的更新就断了。
- 改名前确认没人正在用旧地址做发布/拉取（CI、别的会话的 push）。
