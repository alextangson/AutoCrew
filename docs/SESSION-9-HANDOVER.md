# SESSION-9 交接：relay 裁决落地（1500-2000 字）+ 孤儿占位稿 reconcile

> 日期：2026-07-08 · 起点 commit `4b1fb7a` · 终点 commit `7983811`（2 个提交 + 本文档）
> 803 单测全过，`npm run smoke` PASS，tsc 干净。
> 一句话：**SESSION-8 的第一优先裁决已出并落地——公众号默认字数 1500-2000，真实生成 82 秒稳定完成，relay 天花板问题关闭；§3.1 孤儿占位稿也修了。生成链不再有已知阻塞。**

---

## 1. 创始人裁决（2026-07-08，本 session 开头）

SESSION-8 §4 三选一（换 provider / 缩字数 / 断点续跑）→ **创始人裁决：字数默认 1500-2000 字**（比交接里建议的 3500-4000 更短）。落点：

- `src/modules/packs/wechat-article.ts`：writerRole、body 规则、platformAdjustments 全部 1500-2000；密度约束等比缩放（案例 3→1、数据引用 5→3、配图标记 4→2、信息增量 3→2），quality gate `5000/5/4 → 1500/3/2`。
- 缘由注释写进 pack 头：改回长文时密度约束要一起调。
- `loop.ts` max_tokens 16000 不动（上限非目标，流式下留余量零成本）。
- 断点续跑（工程根治）没有排期，只是不再是 P0 前提。

**真实生成验证**（隔离 dataDir + 创始人 engine.json，处方来自 SESSION-8 §6.1）：
82 秒完成 / 1734 中文字符 / 2 配图标记 / gate 零失败 / 违禁词零命中 / `draft_ready` / 4243 tokens。旧 5000-6000 字需 ~4 分钟且必被 relay 掐断——**天花板问题就此关闭，别再实测长文**。

## 2. 孤儿占位稿 reconcile（SESSION-8 §3.1，已修）

- `src/desktop/orphan-reconcile.ts` + 4 个测试；`desktop/server.ts` 在 `listen()` **之前** await 执行（先清孤儿再开门，与本进程新生成零竞态）。
- 只认生成占位稿哨兵标题前缀（`content-save` 允许手工稿也存 `drafting`，不能按 status 一刀切）；哨兵已收敛为 `generate-script.ts` 导出常量 `GENERATING_TITLE_PREFIX` / `INTERRUPTED_TITLE_PREFIX`（renderer 的 board/workbench.js 正则同字面量，改动需同步）。
- 标记形状 = 运行时失败路径同形状（中断标题前缀 + `lastError`，status 保持 `drafting`），UI 徽章/横幅/重试按钮零改动生效。
- 不设「N 分钟无更新」门槛：listen 时本进程不可能有活生成；并行 MCP 进程的活稿被误标会在其转正/失败时整体覆盖自愈。全部工作区都扫，事件落各自 events.jsonl。

## 3. 全链 dogfood 完成（同日下半场，创始人授权自主跑完）

**整条链首次真实跑通**：灵感库选题 → 派活 brief（read_url 核实原文素材注入 research）→ 成稿 85s/1727 字 → 总编辑审改（6 处修复 + 标点归一，updateContent 留版本痕）→ `approved` → 违禁词门 → 原生生图 2 张（110s，首图作封面）→ `publish.py` 推入公众号草稿箱（media_id 已返回）。
成品：《有人靠删 AI 代码一周收 1 万美元：AI 写码的账，创业者该怎么算》，`content-1783526526667-ko8nln`。**待创始人**：草稿箱检查排版 → 群发 → 回工作台点「确认已发布」（回填链起点）。

Dogfood 抓到并当场修掉的产品 bug：
- `33d3e7c` **humanizer 三宗罪**：往每篇文章插同一句硬编码"说白了"模板句（全网同指纹+无关内容）；逗号→句号正则硬切长句切出病句（一篇三处）；`/深度/g` 裸删肢解"深度学习"。已删/收窄 + 回归测试钉死。
- `cd1abb7` **发布链中转支持 + 原生生图**（PRD-v4 §9 去桥化第一步）：`publish.json` 新增 `wechatMp.imageBaseUrl/imageModel`；配了中转 → AutoCrew 原生 fetch 生图（120s 自控超时，b64/url 双形状），不再被外部 seedream 脚本的 30s 死线误杀 gpt-image-*（天然 40-90s）；未配中转 → 外部脚本路径零变化。创始人的 key 在 `~/.autocrew/publish.json`（600 权限，勿入库勿打印）。
- reconcile 首次真实生效：server 启动标记 3 篇 session-8 遗留孤儿稿。

**教训（下个 session 别再踩）**：不要去创始人系统里找 key/凭据（权限分类器会拦，也不该找）——缺凭据时给创始人一条他自己终端跑的写入命令；不要改 `~/.openclaw` 下的外部脚本（同样被拦），在自己产品墙内解决。

## 4. 下一步（按优先级）

1. **等创始人群发后点「确认已发布」**，T+1/T+3 回填数据 → 第一个真实采纳率/回流数据点。
2. **对话链（总编辑 chat）走一遍同样的发布**——本次是模块级驱动，chat 的 push_wechat_draft 确认卡还没真实过一次。
3. SESSION-8 §5 的排期项前提未变（第二批 Dashboard 组件、目标卡、发布日历、B 级发布），不要偷跑。
4. **前端 React 化**（frontend v2 契约 A 期）仍排在公众号链 P0 验收后。

## 4.5 IA v5 启动(同日第三段,创始人 /goal 全量指令)

契约:`docs/superpowers/specs/2026-07-08-ia-v5-full-newsroom.md`(北极星四问/员工编制/六主线/分期)。
**已落地**(每段独立提交,843 单测/smoke 全绿):
- **V5.0** 编辑器保命:标题可编辑、重写原因自由输入(reasonNote 新字段)、框选发现性提示(`32c8f70`)
- **V5.1** 受众画像系统:三层画像类型+归一化(存量 muse 数据形状终于被消费)、generate/save_persona
  校准流(chat 承载,未确认不落库)、受众停留审(审核员新维度,advisory)、写手 prompt 注入画像、
  styleCalibrated 可达(`b50d4d0`)
- **V5.2** 编辑引擎:选区上下文中心开窗(修头部截断缺陷)、保存带"为什么改"进 diff_note(`8c6aa9c`)
- **V5.3** 情报进水:搜索 provider 抽象(bocha/tavily,search.json 0600)、scout_inspiration 侦查员
  工具(定位+画像推导搜索词→语义过滤→入库)、设置页搜索区、新通道 settings:search_get/set(`dfa4094`)
- **V5.4a** 图文平台:X/Reddit/头条三包+剪贴板链(X 自动分楼 CJK×2 口径)+逐平台风控评审文档;
  X 真实生成验收 29s 双楼干净(`dc5d926`)

**未做**(契约已排期):V5.4b 视频三平台发布件+分镜(要动 pack-schema,单独做);V5.5 React 前端
A-D 期(编辑器/看板/校准 UI 终局载体)+Dashboard 四问重排;V5.6 设置中心收口。
**等创始人**:搜索 API key(配置在设置页即可用);X/Reddit 开发者凭据+persona 语言裁决
(风控评审文档 §2/§3);头条/视频预填是否值得做(先用一周剪贴板)。

## 5. 惯例提醒（继承 SESSION-8，仍然有效）

- 改前端必先 `npm run smoke`；写完自己开浏览器 dogfood 再交付。
- 起 server：`npx tsx desktop/server.ts`；单测 `npx vitest run`（812）；类型 `npx tsc --noEmit`。
- 禁止上云（PRD-v4 §11）。
