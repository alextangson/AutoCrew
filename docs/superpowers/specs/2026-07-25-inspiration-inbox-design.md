# 灵感收件箱 + 对标拆解卡 · 设计 spec v2

日期：2026-07-25 ｜ 状态：已过 codex 评审（30 条发现全部吸收，处置表见 §9）｜ 前置裁决：见 §0.3

## 0. 背景与裁决

### 0.1 痛点（创始人原话归纳）
刷到好内容（X、抖音）想转发链接给 AutoCrew，但它「现在没有学习的地方」——五条灵感入库路径全部要求开着工作台在对话里同步触发，手机上的捕获时刻全部流失；对标内容拆解只有总编辑口头拆一次，拆完即散，不沉淀、不复用。

### 0.2 目标
随手转发 → 异步消化 → 结构化沉淀（选题灵感 或 对标拆解卡）→ 喂回写稿。每一步失败可见，绝不静默丢。

### 0.3 裁决记录（2026-07-25，创始人拍板）
- 入口通道：**Telegram bot（主）+ 浏览器扩展右键（辅）**。
- 消化深度：**拆解卡 + 灵感库双轨**。
- 推翻旧裁决：PRD-v2「IM 通道归宿主 AgentOS」在收件箱场景下不再适用——产品形态已是独立本地 server，TG bot 长轮询纯出站。
- 关联但另案：公众号 P0 已验收、P1 调度解禁。收件箱 worker 是事件驱动，不依赖调度器。

## 1. 数据流总览

```
手机 TG 转发 ─→ TG polling worker ─┐
                                    ├→ inbox 队列(inbox.jsonl, 状态机) → 解析器(按域名) → LLM 判定分流 ─┬→ 灵感库(topics, 走单条 intake 门)
桌面扩展右键 ─→ 本地 server HTTP ──┘                                                                    └→ 拆解卡库(patterns.jsonl)
        每步状态回执（TG 回消息 + 工作台收件箱视图）                                单一注入点：script-prompt 组装时按相关性选卡
```

## 2. 入口通道

### 2.1 Telegram bot（主通道）

**工作区归属（先定死，不留模糊）**：AutoCrew 支持多工作区，而同一 bot 的 `getUpdates` 只允许一个消费游标。因此：
- worker 是 **server 进程内全局单例**，配置文件放**全局** `~/.autocrew/inbox.json`（600 权限，不随工作区），字段：`botToken`、`botId`（首次 `getMe` 获取并锁定）、`allowedUserIds[]`、`targetWorkspaceId`、`proxyUrl?`。
- 所有消息**固定落 `targetWorkspaceId` 指定的工作区**，不跟随「当前工作区」切换。换目标 = 改配置。由 `src/desktop/settings.ts` 统一读写，token 掩码返回。

**polling 纪律**：
- 长轮询 `getUpdates(timeout=50s)`；网络错误指数退避 + 抖动（1s→60s 封顶）；`429` 尊重 `retry_after`；`401` → worker 转 `blocked` 态并在 doctor/设置页提示 token 失效；`409`（同 token 另有消费者）→ worker 停止并 doctor 报红，不自旋。
- 优雅停机：abort 在途 poll，**不推进 offset**。
- **offset 推进纪律（丢消息的关键）**：先把 update 持久化为 inbox item（fsync 落盘成功），才允许把 offset 推进到「连续持久化成功的最高 update_id + 1」。崩溃窗口语义 = at-least-once，重复投递由幂等键吸收（§3.1）。offset 存 `~/.autocrew/inbox/tg-offset.json`，文件内带 `botId`；换 token 后 `getMe` 的 botId 不一致则重置 offset。token 变更由设置保存钩子热重启 worker。
- 离线语义：Telegram 只保留未取更新 24h，超过即丢——命名边界，doctor 显示 worker 最近成功 poll 时间 / 最后 update_id / 最老 pending 时长（**不做**带外 getUpdates「积压探测」，会抢游标）。

**消息协议与安全**：
- **仅处理 `allowedUserIds` 内的消息；白名单外静默忽略**（不回执，避免探测）。消息与抓取内容一律当数据（§3.6）。
- 纯链接 / 链接+备注 → 入队；纯文字 → 灵感笔记（幂等键 = 规范化文本 hash，7 天窗口）；图片/文件/贴纸 → 回执「v1 只吃链接和文字」。
- 回执：入队即回「已收到，消化中」；完成回判定与落点；失败回人话原因 + 指引。item 上持久化 `chatId`、`updateId`、`receiptStatus(pending|sent|failed)`——**后台任务完成时靠 item 自身字段知道回给谁**；回执发送失败重试 3 次后标 `receiptFailed`，工作台可见，不阻塞消化。

### 2.2 浏览器扩展右键（辅通道，V1.5）
- 走**本地 server HTTP（token 认证）**：`POST /api/inbox { url, note?, pageTitle? }` → 入同一队列。**不走 native host**（native host 直写根 dataDir、不知工作区归属——现有 `ingest_rows` 的路径不适用于此）。
- 扩展 manifest 需新增 `contextMenus` 权限；入队前仅接受 http/https URL。

### 2.3 明确排除的通道
个人微信 bot（封号 + 合规红线）、公网 webhook、邮件轮询。

## 3. 消化管线

### 3.1 队列与状态机
- `<targetWorkspace dataDir>/inbox/inbox.jsonl`，append-only、按 id latest-wins。**inbox.jsonl 是永久台账**：digested/rejected 记录不删，保可追溯与「从收件箱一键重新入库」。
- item：`{id, url?|text?, canonicalUrl?, note?, source, chatId?, updateId?, receivedAt, status, stage?, verdict?, targetIds?, errorCode?, failReason?, retryable?, attempts, claimedAt?, receiptStatus?}`
- **状态语义拆三种，不共用 failed**：
  - `rejected`——确定性拒绝（unusable/定位不符/内容太薄）。不重试。回执说明原因。
  - `blocked`——等外部条件（缺 TikHub key、缺引擎、TG token 失效）。**配置变更事件触发重试**，不计入 attempts。
  - `failed`——可重试故障（网络/超时/5xx）。attempts≤3，指数退避。
  - 正常流：`pending → fetching → digested`。
- **并发与恢复**：全部处理收敛到**单一进程内 worker 串行执行**——TG 入站、启动补扫、手动重试都只是「向 worker 队列投递请求」，不各自处理，天然免锁。`fetching` 带 `claimedAt` lease（10 分钟），启动时回收过期 claim 重置为 pending（覆盖「处理中崩溃」）。
- **幂等键 = canonicalUrl**：解重定向（≤5 跳，仅 http/https，每跳过 SSRF 检查）后按域名规范化——x.com 取 status id、抖音取 video id、通用去 tracking 参数（显式清单：`utm_*`、`fbclid`、`gclid`、`spm`、`share_token`，不做通配删参）。短链解析失败 → 幂等键 = 原始 URL。查重范围：**inbox + topics + patterns 三库**。
- **`both` 的原子性**：目标 id 确定性派生（卡 `pat-<itemId>`、题按 canonicalUrl 查重），item 上记 `stage(card_done|topic_done)` checkpoint，重试从断点续做，每个落库端各自幂等——重复执行不产生第二张卡。

### 3.2 解析器（按域名路由）

| 域名 | 解析器 | 契约要点 | 缺依赖时 |
|---|---|---|---|
| 其余（含公众号文章） | 加固版网页抓取（V1.0） | 见下「抓取加固」 | 反爬/空文 → failed/rejected |
| x.com / twitter.com | twitterapi.io **tweet-by-id 端点**（V1.1，新能力——现有 `x.ts` 只有按账号拉时间线，**不能复用**，需新写请求/响应 schema/错误码/超时/fixture） | 文本、作者、赞转数 | 缺 key → blocked + 指引 |
| douyin.com / v.douyin.com | **justoneapi**（V1.1，取代原定 TikHub，2026-07-25 创始人 key 实测通过）：`share-url-transfer/v1` 解析 v.douyin.com 短链 → `get-video-detail/v2` 取详情。响应为抖音原始结构，desc/author.nickname/create_time/statistics{digg,comment,collect,share} 实测齐全（play_count 恒 0，抖音公开面不给播放量）；token 走 query 参数；错误码 100→blocked、301→retryable、302/303 限流、601/602 余额→blocked；官方建议超时 120s。`tikhub.ts` stub 由 justoneapi adapter 取代 | 文案、作者、赞评藏、发布时间；**ASR 转写不做** | 缺 key → blocked + 指引 |

**抓取加固（信任边界已变——URL 来自外部转发，不再是本机可信用户）**：
- 新建 `fetchExternalPage()`（inbox 专用，不动 chat 路径的 `fetchPageText`，其「不拦私网」假设保留并注释）：
  - **SSRF 防护**：拒绝 localhost / 私网段 / 链路本地 / 环回，DNS 解析后按 IP 校验，**每一跳重定向重新校验**。
  - **响应上限**：流式读取，2MB 字节封顶即断（不整体 `res.text()`）；`Content-Type` 仅接受 text/html 与 text/plain；15s 超时。
- 代理：**不假设「系统代理」**（Node fetch 不自动走系统代理）。`proxyUrl` 显式配置，经 undici `ProxyAgent` dispatcher 绑定到 TG 客户端（大陆网络必须）；twitterapi.io/TikHub 默认直连、可选走同一代理。代理串含凭证时日志脱敏。

### 3.3 LLM 判定分流
- 单次 `runLoop`，scout 路由，submit-tool 模式（`submit_inbox_verdict`）。**该 run 只挂 submit 工具，无任何副作用工具**——外部内容影响不了工具选择。
- 输出契约：**按 verdict 条件校验**（zod）——`exemplar/both` 必填卡字段、`inspiration/both` 必填选题字段；校验失败走修复轮（同 quality-gate 模式，≤2 轮）；模型未调 submit 工具 → failed（retryable）。
- verdict 四值：`inspiration` / `exemplar` / `both` / `unusable`（落 rejected，回执原因）。
- 引擎不可用 → blocked（引擎配置变更时自动重试），**不做关键词降级**。

### 3.4 灵感入库：抽「单条 intake 门」
现有 `radar-intake` 是批量消费 radar cache 的（带批次上限 + 引擎失败关键词降级），**不能直接复用**。重构：从中抽出 `gateTopicCandidate()`（定位硬门 + 查重 + 7 天落选记忆，无批量上限、无降级），radar 批量路径与 inbox 单条路径共用。inbox 入库的 topic：reason=「收件箱 · 转发」+ 备注，`link=canonicalUrl`。
**过期裁决**：inbox 来源的灵感与雷达同权——3 天未用进回收站（不搞第二套过期制度）；「沉淀」由永久的 inbox 台账与拆解卡承担，收件箱视图可对过期项一键重新入库。

### 3.5 拆解卡实体与注入
- `<dataDir>/patterns/patterns.jsonl`，append-only、按 id latest-wins，**带 `revision`、`updatedAt`、`deletedAt`（墓碑）**——支持补注、删除；删除后同链接再转发，查重会命中墓碑 → 回执「此前拆解卡已删除；要重拆请重新转发并附『重拆』备注」（显式覆盖而非静默复活；实现取备注关键词而非 /redo 命令，免去 bot 命令面）。
- `PatternCard: {id, sourceUrl, canonicalUrl, sourcePlatform: "douyin"|"x"|"wechat_article"|"web", applicablePlatforms: PlatformId[], author?, title, hook, structure[3-6], first5s?, whyItWorks[1-3], themes[1-3], stats?{likes,comments,collects,capturedAt}, founderNote?, sourceInboxId, revision, createdAt, updatedAt, deletedAt?}`
  - **来源平台与适用平台是两个字段**：sourcePlatform 记录从哪拆的；applicablePlatforms 是输出平台枚举（douyin/wechat_video/xiaohongshu/…），LLM 建议、创始人可改。
- **注入点只有一个：`script-prompt` 组装时**（写稿入口）。~~koubo pack、video-kit 各自加槽~~——koubo 是静态包不该塞动态数据；video-kit 是稿后发布件、注入范例会让发布件偏离已审稿。
- **按相关性选卡，不是「最近 5 张」**：applicablePlatforms 含当前目标平台 AND themes 与选题标题/角度有交集；上限 3 张、按 updatedAt 稳定排序；无匹配则整槽省略。生成请求带 `usePatterns:false` 可显式关闭。
- prompt 纪律：卡内容作为定界数据块注入，字段级长度上限（hook≤100 字、structure 每步≤50 字），明示「借钩子类型与结构骨架，禁止改写其文案」。
- **使用追踪（为数据回喂留口）**：每次生成把注入的 pattern id 写入 run-log 与 content 元数据（`usedPatternIds`），后续飞轮可归因「用了卡的稿 vs 没用的」。
- chat 既有「对标拆解」路径（规则 11）同步改为落卡，两条路统一。

### 3.6 注入防护（真实机制，不是一句声明）
- 分流 run 无副作用工具（§3.3）；抓取内容截断（4000 字）后以定界块注入，链接与 markup 剥离；创始人备注单独字段、不与抓取内容拼接；卡片入 prompt 前按字段上限裁剪。外部内容永远进不了系统提示与工具参数模板。

## 4. 工作台（实现清单，不是一句「新增视图」）

- IPC 通道：`inbox:list`、`inbox:retry`、`inbox:delete`、`inbox:reingest`、`inbox:settings_get/set`（token 掩码）、`patterns:list`、`patterns:update`（founderNote/applicablePlatforms）、`patterns:delete`；各配 channel contract + handler + 前端 API。
- SSE 事件 `inbox:updated` 驱动视图刷新（复用现有事件总线）。
- 收件箱视图：pending/blocked/failed/rejected 分组，blocked 项直链设置页；digested 项链到落点。空态 = 配对引导（建 bot、填 token、验证连通按钮）。「移除」是展示层 `hiddenAt` 隐藏（可恢复）：台账 append-only 不破，被移除项仍参与查重——同链接再转发回「已收录过」。
- 拆解卡列表：表格 + 删除 + 补注。v1 不做编辑器。
- doctor 三项：TG worker（最近成功 poll / 最老 pending 时长 / 401、409 状态）、TikHub key、patterns 库可读写。

## 5. 边界与验收

设计五问浓缩：状态机四态 + blocked 由配置事件唤醒；最坏输入见 §3.1/§3.2；防呆 = 白名单静默忽略 + 三库幂等 + 墓碑显式覆盖 + 命令面为零（「/」开头一律回引导语不入台账，含每个用户必发的 /start）；失败可见 = 回执 + 视图双通道，绝不静默降级；命名不做 = 微信个人号 bot、公网 webhook、ASR、视频下载、拆解卡直出稿件、>24h 离线找回。

验收用例（发布前逐条走，含 codex 补充的崩溃/并发面）：
1. 转发 X/抖音链接（V1.0 **不特判**：走通用抓取，抓不到正文按判定落 rejected/failed，有测试锁死防提前加 blocked 特判；V1.1 上专用解析器后 → 卡/题落库回执，缺 key → blocked）。
2. 转发普通文章链接 → digested，回执含判定与落点；工作台可见。
3. blocked 语义（等外部条件、配置变更自动唤醒）在 V1.0 由**引擎不可达**路径验收：引擎恢复/保存引擎配置 → 自动重试转 digested。TikHub 缺 key 的 blocked 属 V1.1。
4. 同链接转发两次（含并发同时到达）→ 恰一条 digested，第二次回「已收录过」。
5. **崩溃矩阵**：在「入队后未推进 offset」「fetching 中」「card_done 未 topic_done」三点 kill 进程 → 重启后分别：TG 重投被幂等吸收；lease 回收重跑；从 checkpoint 续做且不重复落卡。
6. TG 回执发送失败 → item 标 receiptFailed，工作台可见，消化结果不丢。
7. 429/断网 → 退避重试；409 → worker 停 + doctor 红。
8. 恶意输入：重定向到 127.0.0.1/内网 IP → 拒绝；>2MB 响应 → 截断中止；50 跳重定向 → 5 跳丢弃。
9. 拆解卡落库后生成口播稿（目标平台匹配 + 主题相关）→ run-log prompt 含定界 pattern 块与 usedPatternIds（不断言具体文案）；无相关卡时 prompt 无此槽。
10. 非白名单账号发消息 → 无响应、无入队。
11. 改 bot token（换 bot）→ offset 重置、worker 热重启；改 targetWorkspaceId → 新消息落新工作区。

## 6. 与现有裁决/架构的关系
不触碰：agent 互聊禁令、成片不做（裁决 C）、发布人工闸。调度器（P1）另案；worker 事件驱动即可工作。

## 7. 分期（按 codex 建议重切，风险前置）

- **V1.0（最小闭环）**：TG worker（polling 纪律 + offset 纪律 + 状态机 + lease）＋加固网页抓取＋LLM 分流＋单条 intake 门重构＋拆解卡库＋script-prompt 单点注入＋收件箱视图（列表/重试/删除）＋doctor。**通用文章先通，X/抖音后上**。
- **V1.1**：X tweet-by-id 解析器＋justoneapi 抖音解析器（各带 fixture 与限流纪律；justoneapi 另有 user-profile-v3 / user-published-videos / video-search-v4 / hot-search-v1，直接覆盖 V2 对标监控与选题雷达抖音源的抓取面）。
- **V1.5**：扩展右键（经本地 server HTTP）。
- **V2（另写 spec）**：对标账号常驻监控 = 录入账号 → 定期拉新 → 自动进本管道（复用全部消化链，只加抓取源）。

## 8. 待裁决
无——通道与深度已由创始人拍板；codex 30 条已全部吸收，处置见 §9。

## 9. codex 评审处置表（2026-07-25，26×P1 + 4×P2）

| # | 发现 | 处置 |
|---|---|---|
| 1 | TG worker 无工作区归属 | 吸收：全局单例 + targetWorkspaceId 固定落库（§2.1） |
| 2 | offset 先推进会丢消息 | 吸收：先持久化后推进，at-least-once + 幂等（§2.1） |
| 3 | item 缺回执字段 | 吸收：chatId/updateId/receiptStatus + 重试与可见（§2.1/§3.1） |
| 4 | fetching 崩溃永久卡死 | 吸收：claimedAt lease + 启动回收（§3.1) |
| 5 | failed 一词三义 | 吸收：rejected/blocked/failed 三态（§3.1） |
| 6 | 无并发 claim | 吸收：一切处理收敛单 worker 串行（§3.1） |
| 7 | both 非原子 | 吸收：确定性 id + stage checkpoint + 各端幂等（§3.1） |
| 8 | SSRF 信任边界变化 | 吸收：fetchExternalPage 拦私网 + 每跳复检（§3.2） |
| 9 | 响应体无上限 | 吸收：流式 2MB 封顶 + Content-Type 白名单（§3.2） |
| 10 | 「系统代理」不成立 | 吸收：显式 proxyUrl + undici ProxyAgent + 日志脱敏（§3.2） |
| 11 | 三解析器高估现有能力 | 吸收：x.ts 不复用、tikhub 重写，双双移入 V1.1 带契约与 fixture（§3.2/§7） |
| 12 | radar-intake 不能直接复用 | 吸收：抽 gateTopicCandidate 单条门，无降级无批量上限（§3.4） |
| 13 | 3 天过期与「沉淀」冲突 | 裁决：同权 3 天过期；沉淀由永久 inbox 台账 + 拆解卡承担，可一键重入（§3.4） |
| 14 | append-only 与删改冲突 | 吸收：revision/updatedAt/deletedAt 墓碑；item 加 canonicalUrl/stage/errorCode/retryable（§3.1/§3.5） |
| 15 | URL 幂等不完整 | 吸收：显式 strip 清单 + 按域规范化 + 短链失败回退原 URL + 单 worker 消并发（§3.1） |
| 16 | 查重漏 patterns | 吸收：三库查重 + 文字笔记 hash 幂等（§3.1/§2.1） |
| 17 | 「最近 5 张」随机污染 | 吸收：平台+主题相关性选卡、上限 3、可关闭、无匹配不注入（§3.5） |
| 18 | 三注入面重复 | 吸收：只留 script-prompt 单点（§3.5) |
| 19 | 平台枚举混用 | 吸收：sourcePlatform 与 applicablePlatforms 分字段（§3.5） |
| 20 | 注入防护是口号 | 吸收：无副作用工具的分流 run + 定界块 + 字段级上限 + 备注隔离（§3.6） |
| 21 | LLM 输出契约缺失 | 吸收：按 verdict 条件 schema + 修复轮 + 未调工具的失败路径（§3.3） |
| 22 | polling 缺错误纪律 | 吸收：409/401/429/退避/优雅停机全定义（§2.1） |
| 23 | token 轮换与 offset 身份 | 吸收：offset 文件带 botId，换 bot 重置 + 热重启（§2.1） |
| 24 | 扩展经 native host 写错工作区 | 吸收：改走本地 server HTTP（§2.2） |
| 25 | 扩展权限漏项 | 吸收：contextMenus 权限 + URL 校验入清单（§2.2） |
| 26 | 工作台依赖没列全 | 吸收：IPC/contract/SSE/前端 API 全清单（§4） |
| 27 | doctor 积压检查会抢游标 | 吸收：改测 worker 心跳/最老 pending，不带外 getUpdates（§2.1/§4） |
| 28 | 验收缺崩溃/并发面 | 吸收：崩溃矩阵 + 并发重复 + 恶意重定向等 11 条（§5） |
| 29 | 学习闭环无归因 | 吸收：usedPatternIds 进 run-log 与 content 元数据（§3.5） |
| 30 | V1 范围过大 | 吸收：重切 V1.0（通用抓取先行）/V1.1（X+抖音）/V1.5（扩展）（§7） |

## 10. V1.0 验收记录（2026-07-25）

分支 `claude/autocrew-dynamic-workflow-automation-211a38`，提交链 `00dd332`(A) → `69f1458`(B) → `f3c0f18`(C1) → `8dd49f7`(B4+集成) → `1a5b040`(C2+C3)。**tsc 干净、1545 vitest 全绿、lint 0 error、前端构建通过、真实 server 启动冒烟通过**（not_configured 可见态 + inbox:status/doctor:inbox/inbox:list 经鉴权 HTTP 全部正确）。

| §5 用例 | 证据 |
|---|---|
| 1 X/抖音不特判 | digest-pipeline.test（域名特判有反向锁测试） |
| 2 普通文章 digested | digest-pipeline.test happy path 三路 |
| 3 blocked→唤醒 | inbox-runtime.test（引擎配置保存→唤醒→digested，真 setEngineSettings 链路） |
| 4 同链接幂等（含并发） | digest-pipeline.test 三库查重 + inbox-store.test + 单 worker 串行测试 |
| 5 崩溃矩阵 | telegram-poller.test（append 中途真失败重启不丢不重）、inbox-worker.test（lease 回收）、digest-pipeline.test（card_done 续做 revision=1） |
| 6 回执失败不丢结果 | telegram-poller.test + digest-pipeline.test |
| 7 429/退避/409 停 | telegram-poller.test 逐条 |
| 8 SSRF/2MB/重定向 | fetch-external.test（46 例地址矩阵 + 流式变异验证） |
| 9 注入块 + usedPatternIds | pattern-select.test + script-prompt.test + generate-script-patterns.test + run-log.test |
| 10 白名单外无响应 | telegram-poller.test（含 offset 照常推进） |
| 11 换 token 重置 offset / 换工作区 | telegram-poller.test（botId 比对）+ inbox-runtime.test（配置变更热重启） |

**未验收（如实声明）**：真实 Telegram 网络冒烟（需创始人 bot token + 出站代理，交付后第一步）；X/抖音专用解析器与扩展右键属 V1.1/V1.5 未实现。
