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
