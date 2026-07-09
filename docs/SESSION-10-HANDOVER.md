# SESSION-10 交接（2026-07-09）——创始人 7 项反馈,5 批全落地

计划:`~/.claude/plans/starry-kindling-candle.md`(创始人已批)。提交:`ce677f9..538ab34`(6 个 feat + 本文档)。

## 交付清单

### 批 1 · 编辑体验快改（ce677f9, 915dab4）
- **Markdown 预览**:编辑器「编辑 ⇄ 预览」切换。react-markdown + remark-gfm + **remark-cjk-friendly**(CommonMark 对中文 `**小标题。**正文` 闭合失败——标点+汉字紧邻,该插件修正,实测 7 处加粗 0 残留)。
- **改写工具条跟随选区**:`frontend/src/caret.ts` 镜像 div 测量 textarea 选区坐标,浮层锚在选区末行下方、贴底翻转、滚动重算;测量失败降级静态条。实测偏移与视觉行完全吻合。
- **字数硬顶**(创始人裁定"发布文案 ≤1000"):`QualityGateSpec.maxChars` + `platformAdjustments[].maxChars`(平台覆盖包级),生成期打回压缩;`pre-publish` 加 `PLATFORM_MAX_BODY` 发布期兜底。取值:xhs 1000/视频号 800/B站 2000/公众号 3000(生成期 gate 2000,遵 session-9 裁定 1500-2000)/头条 1800。douyin 不设(body 是口播脚本,发布文案在 video-kit 里本就 ≤300)。**若"1000 字以内"应含公众号,改 wechat-article.ts 的 maxChars 即可。**

### 批 2 · 受众画像重做（012a308）
- 回答创始人疑问:画像输入原本就不只定位(还有写作规则/红线/近 8 篇标题),且确认环节一直存在(提案不落库)——但只活在聊天流里,GUI 无一等入口,且**无数据回流**。
- 生成输入新增:已发内容表现 top/bottom(outcomes.jsonl)、采纳率(≥3 篇才注入)、MEMORY.md Performance Insights;系统提示加防过拟合约束(样本小只微调)。
- 校准中心新增完整画像面板:三层全量展示 + 生成提案 + **逐字段修改后确认落库**(`persona:generate`/`persona:save`);聊天流保留。确认动作进工作日志(event-map)。

### 批 3 · 封面 pipeline 补全（234c306）
- 事实澄清:封面后端(Gemini 3 候选)一直存在,但桌面路径完全没露出(无频道/无图片路由/收不到 key),prompt 是正则拼的。
- **LLM 封面设计师** `src/modules/cover/designer.ts`:创始人旧 Gemini 提示词重写为结构化方案(英文生图 prompt + 2-8 字中文大字 + 版式 + 设计理由),硬规则全保留(写实/禁卡通/高对比大字/暗色叠层/禁水印浅底),画像作输入;引擎故障降级规则版 prompt-builder(封面不断粮)。
- **反馈重做闭环**:`revise` 动作——对单张候选提意见 → 设计师改方案 → 重生成;文件名带 `-rN` 修订号(immutable 缓存安全),feedback 历史入 CoverReview;改被选用的那张会作废选用回待审。
- **公众号 2.35:1**:原生 21:9(≈2.333,imagen 不支持则 16:9)→ 纯 Node PNG 垂直居中裁切(`png-crop.ts`,node:zlib 零依赖,含 5 种滤波解码);JPEG/异形降级交付原宽幅图带 warning。**不进 Pro 门**。
- **GUI**:编辑器 CoverPanel(生成 3 候选/选用/提意见重做/平台比例,后台任务 + 轮询)。`/api/asset` 带 token 只读图片路由(白名单校验)。设置页「封面生成(Gemini)」区(cover.json,0600,掩码)。
- **修 2 个存量 bug**:saveCoverReview 每次覆盖 createdAt;approveCoverVariant 读从未赋值的旧字段(approvedImagePath 永 undefined)+ 把 publish_ready 稿倒拨回 approved。

### 批 4 · 可观测性（5ea74db）
- **落盘点在 runLoop**(关键勘误:桌面路径不经过 ToolRunner——runLoop 才是所有 LLM 调用必经点):每次 LLM/工具调用写 `~/.autocrew/logs/runs/<日期>.jsonl`——runId/角色/模型/耗时/tokens/ok/error/**完整 prompt 与输出**。密钥字段脱敏、单条 16k 截断、14 天滚动、写失败静默吞(观测层不破坏执行层)。MCP 路径由 auditMiddleware 写同一份。
- runId 贯通:聊天轮/后台写稿与任务动态卡同 runId;persona/cover/retro loop 带角色标签。
- **工作日志视图**:运行日志(run 列表 → 逐步骤展开看输入/输出/错误)+ 团队技能(19 个 SKILL.md 全文——"改它就是调教员工")。

### 批 5 · /goal + 周/月复盘（538ab34）
- `creator-profile.goal`(旧目标自动留档 history);聊天 `set_goal`/`get_goal`(「/goal …」直接说);注入点:总编辑系统提示、写手 script-prompt、画像生成、雷达相关性评分(能推进目标的选题优先)。
- **复盘生成器** `src/modules/retro/`:取窗口事实(产出/发布/采纳率/数据快照/目标/画像)→ strongModel 生成 markdown 报告落 `~/.autocrew/reports/`。周=产出/数据/对照目标/≤3 条可执行建议;月=+画像漂移、内容支柱、策略**提案**(明确标注需创始人确认,不自行改配置)。
- Dashboard **目标卡**(session-9 排期兑现):设定/调整(prompt 弹窗或对话 /goal)+ 一键周复盘/月度深盘 + 7 天到期提醒;报告在数据回流页 markdown 渲染。
- 简化裁定:v1 手动触发,不建定时器——跑顺一个月再自动化。

## 验证
- **943 单测全过**(本 session +84:字数 gate、画像信号、designer、png-crop 滤波/裁切、wide-crop、cover 修订/审批修复、run-log 脱敏/保留期、loop 埋点端到端、goal/retro)。
- tsc / fe:build / smoke 全绿(smoke 断言更新:工作台九卡+目标卡)。
- 浏览器实测(真实数据):markdown 预览 CJK 加粗 0 残留、浮层定位吻合、目标卡/工作日志(19 技能)/画像面板/封面面板全部就位。
- **服务已用新代码重启**(nohup,4317,日志追加 `~/.autocrew/server.log`)。

## 等创始人（不阻塞,按需）
1. **Gemini API key** → 设置·封面生成(https://aistudio.google.com/apikey);**形象照**放 `~/.autocrew/covers/templates/`(jpg/png;注意照片会随生图请求发给 Google API)。然后真 key 全链路跑一次:生成→提意见重做→选用→公众号 2.35:1。
2. **字数裁定确认**:短文案平台顶 1000 已生效;公众号维持 1500-2000(session-9 裁定)、头条 1800——若要全线 ≤1000,说一声改两个包文件。
3. 设第一个 **/goal**;攒一周数据后点第一份周复盘。

## 已知边界 / 刻意不做
- `desktop/server.ts` 未提交:混着你的 server-token 双机改动 + 本次 `/api/asset` 路由——token 线收尾时一起提交。
- 4450 端口有个 12 小时前的旧 server 进程(疑似双机实验遗留),未动。
- 复盘定时化、`cover_pending` 状态转正(local-store.ts:719 注释处,1 行 + 看板列已映射)、聊天区 markdown 渲染:等 dogfood 验证需求后再做。
- 表现数据仍手动回填(既有 gap,不在本次范围)。

## 惯例不变
FE 改动:`npm run fe:build && npm run smoke`;测试 `npx vitest run`;类型 `npx tsc --noEmit`;服务 `npx tsx desktop/server.ts`(日常 `npm start`)。

---

# 二期附录(同日 2026-07-09,创始人追加裁决,commits 43c04a1 + 11046d5)

## A · 封面生图切中转 image2 + 横屏主比例
- **不再用 Gemini**:封面默认走 OpenAI 兼容中转的 `gpt-image-2`,**凭证复用 publish.json 的生图 Key/端点**(公众号配图同一条,实测已自动识别——设置页显示「中转 gpt-image-2」,零新配置)。Gemini 保留为可选 provider(`cover.json` 切换)。**之前"等创始人"清单里的 Gemini key + 照片发 Google 顾虑作废。**
- **参考照片**走 `/images/edits` multipart(形象照目录不变);中转不支持该端点时自动降级无人物并在候选上明说(hasPersonalIP 如实)。**首次真跑时留意 warning——不支持的话降级即最终行为。**
- **尺寸机制**:中转只有 1024x1536/1536x1024/1024x1024 → 取最近档后 png-crop 居中精裁(裁行/裁列都支持),3:4 / 2.35:1 / 16:9 / 4:3 全部精确。
- **横屏主比例**(裁决:B站/抖音PC 收横屏):生成入口有比例选择(3:4 竖屏默认 / 16:9 / 4:3),三张候选按所选比例出,设计师提示词随比例切横版构图;**比例适配 = 同一设计方案(同 prompt/大字/形象照)重渲染 → 风格统一**。16:9/4:3 不再过 Pro 门(legacy MCP `generate_ratios` 委托新链路,同样免门;ratio-adapter 保留但已无生产消费方)。

## B · 内容文件夹人机协同
- 调研修正:每篇稿件本来就是 `contents/<id>/` 一个文件夹,且 **draft.md 每次存稿/改稿都会更新**(一直如此,已加回归测试锚定)——计划里的"镜像"项砍掉,不造已有的轮子。
- 新增:选定封面自动复制到文件夹根 `封面.png`,比例适配复制 `封面-2.35x1.png / 封面-16x9.png / 封面-4x3.png`(拿了就走);编辑器素材区「打开稿件文件夹」按钮(content:open_folder,Finder 直达,已真机验证)。
- 刻意不做:文件夹按标题命名/符号链接索引——id 锚定血缘、资源路由与安全白名单,标题会改。

## 验证(二期)
978 单测全过(+35:edits multipart/4xx 降级、裁列、relay 适配器、provider 解析、横屏主比例、封面副本、folder-open);tsc/fe:build/smoke 绿;服务已重启;浏览器实测:设置页 provider 区(显示中转已配)、生成入口比例选择、打开文件夹按钮 Finder 真开。

## 等创始人(更新后)
1. ~~Gemini key~~ 不需要了。形象照放 `~/.autocrew/covers/templates/`(走你自己的中转,不再发 Google)。
2. 封面全链路真跑一次:选比例生成 → 提意见重做 → 选用 → 比例适配;顺带看中转是否吃 /images/edits(不吃会降级并明说)。
3. 字数裁定确认(公众号 1500-2000 维持?)、首个 /goal、一周后第一份周复盘——同一期清单。
频道现 79 个;`desktop/server.ts` 仍留给你的 server-token 线一起提交。

---

# 三期附录(同日,创始人 UX 走查裁决,commits d651f3e + 940da79)

全页面以用户身份走查(1440px 截图留档)后一次修缮,创始人四点全落:
- **看板重排**:灵感库从 1/5 宽窄列独立成 380px 高密度面板(标题两行 clamp+来源·天龄副行+独立滚动),管线余四列;来源标签人话化(`sourceLabel`:radar:X→雷达·X、x:@n→X·@n)。smoke 断言同步(灵感面板+四列)。
- **数据回流充实**:8 项均值全量 tile 墙(此前只挑 4 个)+ 作品表现明细表(flywheel report 新增 `works.items`——每作品最新快照取 20,MCP 同吃)+ 洞察文案去工具名(confirm_published→「在编辑器点『我已发布,确认』」)。
- **中英混杂清扫**:版本备注后端改中文生成(初稿/第 N 版/回滚到 vN,存量英文显示层兜底映射)、工作台 kicker(按任务聚合/今日前 N)、工作日志(模型 n 次·工具 m 次·tokens)、设置区标题(引擎 · 模型服务 等,文件名挪进说明)。
- **交互丝滑**:全局 0.15s hover 过渡、行 hover 反馈、:focus-visible 焦点环、页标题统一 20px serif、编辑器操作行标签对齐(.ed-label)、校准「定位」改双行 textarea;聊天区总编辑回复渲染 markdown(裸 ** 不再示人);顶栏删「v2 预览」徽标与死掉的「旧版 ↗」。
- **工作日志角色补全**:relevance→侦查员、audience-review→审核员、video-kit→发布员、style-distiller/selection-rewrite→编剧(此前显示"引擎")。

验证:978 单测全绿、tsc/fe:build/smoke 过、服务已重启、浏览器复走截图确认(灵感面板 44 条可读、回流页 9 tile+17 行明细、聊天加粗渲染、顶栏干净)。

---

# 四期附录(同日,创始人裁决"别让我一个个挑毛病",commit 986b703)

弹窗与后台页面的交互体验总修——根因:全站 12 处弹窗全是浏览器原生 window.prompt/confirm(不能样式化、一次只能填一个字段、新想法/设目标要连弹两次、改名靠"清空取消"这种反交互)。

- **统一弹窗系统**(ui.tsx 新增 openDialog/confirmDialog,Promise API + DialogHost 挂 App):报纸风(顶部 3px 墨线+衬线标题+说明文案+mono 字段标签);多字段一次填完;必填为空确认键置灰;Esc/点遮罩取消、Enter 提交(textarea 内 Cmd+Enter);改名类自动全选既有文字;**危险操作红色确认键+默认焦点在「取消」**。
- **12 处调用点全替换**:新想法(两连弹→一弹双字段)、设定/调整北极星目标(同)、新建工作区、素材库新建/删除文件夹+改名+移除、编辑器公众号推送确认+移除挂接素材、校准中心改规则。「清空取消」黑话绝迹。
- **设置页重构**:折叠 details(要点七次才见全貌)→ 七区全展开卡片,区头右侧状态徽标(已配置=墨底/未配置=描边,情报源显示 9/10 开启),保存钮旁注明「留空的字段保持现状(浅字即当前值)」——占位符即当前值的契约首次显性化。
- **技能页重构**(工作日志·团队技能):裸 pre 整篇倾倒 → 左侧手册目录(标题+id 副行,选中 inset 墨条,自动选中第一份)+右侧 frontmatter 感知渲染(description 抽成简介,正文 ReactMarkdown 正经排版——表格/标题/列表都是真的)。
- **顶栏**:「＋新想法」从导航钮群里分出动作样式(nav-cta,带边框)。
- smoke 新增:弹窗开合+必填禁用断言、技能清单+markdown 渲染断言。

验证:978 单测全绿、tsc/fe:build 过、smoke PASS(含新断言)、浏览器实走截图:目标弹窗/新想法弹窗/设置七区徽标/技能页 19 份手册渲染/删除文件夹红色确认(焦点在取消),临时测试数据已清理归零。

---

# 五期附录(同日,创始人裁决"从提示工程提升活人感",commit de27018)

审计结论先行:仓库有**两个 prompt 平面**——skills/*.md 只影响 Claude Code/MCP 路径;GUI 引擎走 script-prompt.ts + 赛道包,且引擎从不读 skills 目录。文案质量主战场在代码侧。按影响力落地三件:

- **#1 声音样例注入(最高杠杆)**:此前 prompt 里只有蒸馏后的抽象规则,没有一段创始人的真文字——规则产生合规,样例产生声音。现在:(a) 爆款吸收时 LLM 同步逐字截取 2-3 段原文(`excerpts`),空白归一子串校验防改写,不合格回退取样本首段,存 `profile.voiceSamples`(上限 5,最新优先);(b) 写稿时自动拉最近 3 组**改稿对比对**(diff-tracker 新 `recentContrastPairs`:掐公共前后缀取变更窗口 ±40 字,标点级微调过滤,带"为什么改"备注);(c) script-prompt 注入「创作者声音样本(学语感禁照抄)」+「改稿方向(别再犯左边的毛病)」两区,位于写作规则之前。
- **#2 koubo 赛道包 v2**:v1 的「5-8 点×每点 80-150 字×论断→为什么→例子」把 AI 腔制度化(均匀节奏=AI 指纹)。v2:四种结构模式任选(单点打穿/清单盘点/亲历复盘/反认知纠偏,对齐 wechat-article 的好范式)+节奏方差要求(长短句交替、一句话可成段、禁排比腔)+删除罐头互动钩子(「你猜怎么着」)+自检从字数打勾改功能性检验(删开头 3 句是否变弱/随机三段是否同一人声)。**顺带修了一个漏接:selfReview 此前从不进引擎 prompt(只活在 MCP 技能路径),现在渲染为「提交前自检」区。**
- **#4 skills 卫生**:`_writing-style` 退役(英文陈旧副本,与 koubo.ts 双源打架——write-script v4 早已声明赛道包是唯一来源);write-script SKILL 全文中文化(工具 JSON 保持英文),接入 voiceSamples 与 structureModes;write-script/spawn-writer 里指向不存在的 ~/.autocrew/MEMORY.md 的死引用清除。
- **刻意不动**:humanizer 保持正则删词表(廉价保底——07-08 dogfood 已证明机械后处理帮倒忙,活人感在生成时解决);引擎不设 temperature(API 默认值的方差正是创意写作要的);全量翻译 19 份技能(指令语言不是质量变量,样例语言才是)。

验证:995 单测全绿(+17:样例存取/对比对窗口/逐字校验/兜底/prompt 三区渲染),tsc 干净,tsx 实渲染完整 system prompt 目检通过(区块顺序与文案零毛刺)。

## 等创始人(五期新增)
**重跑一次爆款吸收**(校准中心贴 1-5 篇代表作):旧吸收只产规则、原文用完即弃,voiceSamples 现在是空的——跑一次样例注入才生效。改稿对比对无需动作,平时在编辑器改稿自动积累。
