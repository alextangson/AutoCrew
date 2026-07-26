# 深调研 loop + 真实素材采集 · 设计 spec v2

日期：2026-07-26 ｜ 状态：已过 codex 评审（16 P1 + 2 P2 全部吸收，处置表见 §11）｜ 关联：收件箱 spec（复用抓取加固/串行 worker/注入纪律）

## 0. 背景与裁决

### 0.1 创始人诉求（2026-07-26）
1. 调研太薄，应有多视角洞察反馈内容；2. 调研途中遇到的真实素材（图片/截图/视频）同步保存为该内容素材（现在配图全是 AI 生成）；3. Agent Teams 澄清：协作走产物交接不互聊（PRD-v4 §4.1 不变），深调研是新增专职成员。

### 0.2 定位
给「已决定要写」的选题做深度情报：四视角并行侦察 → 综合成带**跨视角张力点**的调研简报 → 注入写稿；沿途采集真实图片入候选素材。成本闸：只按需触发，不给雷达全量跑。

### 0.3 裁决点（待创始人过目时确认）
**调研素材的归属**：现有两套素材模型都不适配（content 素材必须绑 contentId，而深调研发生在选题期；library 是「引用本地已有文件」模型；两者都无 candidate/来源/授权字段）。**推荐**：新增选题级研究素材存储 `<dataDir>/research/assets/<topicId>/`（独立 index，含 candidate 态与来源字段），开写后在配图放置时**导入**为该 content 的素材（拷贝+登记来源，走既有人工确认流程）。备选：扩展全局 library 模型（侵入既有语义，不推荐）。

## 1. 数据流

```
选题卡按钮 / 总编辑 deep_research 工具（都只是投递任务）
  → 研究任务（持久化 job：queued→running→succeeded|partial|failed，带 lease）
    → 检索代理 broker（四路共用：搜索+读页缓存、配额、来源登记、素材候选的确定性采集）
    → 四视角子运行并行（allSettled+各自 deadline；证据只能引用 broker 登记过的 sourceId）
    → 综合子运行 → 简报 briefs/<topicId>.v<N>.json（不可变版本+原子写）
  → R1b：候选图片经加固下载入研究素材库（candidate 态）
  → 写稿统一入口（generate-script）注入简报；旧简报在新版成功前一直有效
```

## 2. 研究任务模型（P1-3/4/9/10/11/16 的答案）

- 存储：`<dataDir>/research/jobs.jsonl`（append-only、按 topicId latest-wins——复用收件箱台账读写纪律）。job：`{topicId, status: "queued"|"running"|"succeeded"|"partial"|"failed", claimedAt?, startedAt, settledAt?, perspectives: {name, status, errorCode?}[], briefRevision?, errorCode?, failReason?, topicHash}`。
- 执行：进程内**单例串行 runner**（同收件箱 worker 纪律：所有入口只投递；chat 工具与 IPC 按钮都是**异步投递即返回**，绝不阻塞聊天）。同选题重复触发：job 非终态 → 返回「进行中」；**跨进程/重启防重**靠 job 的 claimedAt lease（30 分钟），启动回收过期 running → 重置 queued 并可见标注。
- 进度：SSE `research:updated {topicId}`（同 inbox:updated 的写后触发纪律）；查询通道 `research:status {topic_id}` 返回 job 全量 + 当前有效简报 revision。
- 选题生命周期：任务启动即**给选题续期一次**（视为有动作，不被 3 天回收）；选题被删 → 进行中 job 落 failed（原因可见），简报文件保留但无引用。简报存 `topicHash`（标题+描述 hash），写稿时若与当前选题不符 → 注入仍执行但 prompt 标注「简报基于旧版选题」，选题卡显示「已过期，建议重跑」。
- 重跑读语义：**当前有效简报 = 最近一次 succeeded/partial 的 revision**（记在 job.briefRevision）；重跑失败不回退该指针，旧简报继续可用。

## 3. 检索代理 broker（P1-5/6/8 + P2-18 的答案）

四路共用一个 broker 实例（per-job）：
- `search(query)`：走 search-provider（博查/Tavily）；**配额：每视角 ≤4 次、全 job ≤14 次**；结果登记 source registry。
- `fetchPage(url)`：走 `fetchExternalPage`（SSRF 加固版）；**配额：每视角 ≤6 页、全 job ≤20 页、总文本 ≤300KB**；同 URL 跨视角**缓存共享**（四路撞同一页只抓一次）；每次抓取登记 `{sourceId, finalUrl, fetchedAt, textHash}` 并缓存全文供校验。
- **素材候选由 broker 确定性采集**（不信模型转述 URL）：读页时抽 `<img src/srcset 最大候选>`、`og:image`，相对 URL 按 base 解析，跳过 data:/svg/追踪像素（URL 启发 + 尺寸属性 <200px 跳过），每页 ≤10、全 job ≤40，登记为 `{assetId, url, sourcePageUrl}`——模型只能按 assetId 选择并补 caption。
- 硬预算：除上述配额外，每视角墙钟 deadline 4 分钟、输出 token 15k（runLoop 既有软预算 + broker 配额 + deadline 三层合围；runLoop 预算是「下一轮前检查」的软上限，文档如实注明）。

## 4. 视角子运行

工具带：`search`/`read_page`（broker 背书）+ 对标视角另有只读 `list_patterns`。`submit_perspective` schema（zod + 修复轮 ≤2）：
```
{ insights: {text, sourceIds: string[1..]}[2-6],       // 每条洞察必须引用登记过的来源
  evidence: {claim, sourceId, quote}[0-8],             // 提交时代码侧校验：sourceId 存在 && quote（空白归一后）确为该页子串，不符打回修复
  assetPicks: {assetId, caption}[0-10],                // 只能选 broker 登记的 assetId
  gaps: string[] }
```
- 「视角成功」的判定收紧（P1-13）：结构合法 **且** insights ≥2 条各带有效 sourceId；证据可为空但洞察不许无来源。
- 四视角任务书差异同 v1（受众痛点注入画像/证据要数字/反方找站不住/对标先读卡再搜）。抓取内容定界块 + 截断 + 不执行指令（收件箱 §3.6 同款，含伪造定界符消毒）。

## 5. 综合与简报

- `Promise.allSettled` 收四路；≥2 成功 → 综合（missingPerspectives 点名 + job=partial）；<2 → job=failed（各路原因在 job.perspectives 可见），不产简报。
- `submit_brief`：`{schemaVersion: 1, summary ≤200字, perspectives（原样保留）, tensions: string[0-3]（**允许空**，空时写明「未发现明确张力」——不逼模型编）, angleSuggestions[2-3], evidence（合并去重、保 sourceId→URL 映射）, assetPicks（合并去重）, missingPerspectives, generatedAt, revision, topicHash}`。
- 存储：`<dataDir>/research/briefs/<topicId>.v<revision>.json`，**不可变版本**（P1-12：usedBriefRevision 永远可回溯到确切输入）；写盘 tmp+rename 原子（仓库既有写法）；损坏/未知 schemaVersion → 视为无简报并可见告警，不崩。
- 综合走 scout 路由；实测质量不足升 writer 是一行配置。

## 6. 写稿注入（P1-2/14 的答案）

- **注入点在 `generate-script.ts` 统一入口**（桌面/聊天/MCP 三条路行为一致）。research 槽全局预算 4000 字符：简报优先 ≤2800（summary+tensions+angleSuggestions+evidence 带来源域名），知识库检索用剩余预算补位；拆解卡槽维持独立预算不变。优先级与预算写成常量并测试锁定。
- （前置依赖：知识库检索本身下沉到该入口——已作为独立任务卡拆出，先落它，本特性在其上叠加简报优先级。）
- 定界块 + 字段级转义/截断；`usedBriefRevision` 进 run-log 与 content 元数据。

## 7. 素材采集与下载（R1b；P1-1/6/7 + P2-17 的答案）

- 下载器 `fetchExternalImage`：同款 SSRF（含每跳复检）；**格式白名单 PNG/JPEG/WebP**（Content-Type 与 **magic bytes 双校验**，SVG 明确拒绝——主动内容）；5MB 流式封顶；从格式头读像素尺寸，>6000×6000 拒绝（解码炸弹面；不引新图像依赖、不做真实解码，残余面注明）；落盘文件名 = 内容 hash。
- 存入研究素材库（§0.3 裁决点结构）：`{assetId, topicId, file, sourceUrl, sourcePageUrl, caption, capturedAt, status: "candidate", license: "unknown"}`；按 URL 规范化 hash 全库去重（已有则引用）。
- **硬闸**：candidate 素材绝不自动进正文；配图放置界面可见「研究素材」分组（带来源 URL 与「授权需自查」标注），放置即导入为 content 素材并走既有确认流程。
- 单张下载失败 → 简报里该素材降级「仅链接」；全军覆没 → 简报点名（防盗链/网络）。视频不下载：`video_link` 仅引用（沿收件箱排除项）；R2 若配 justoneapi 附赞藏数据。

## 8. IPC/UI 全清单（P1-16）

- 通道：`research:deep_dive {topic_id}`（投递即返回 job 状态）、`research:status {topic_id}`、`research:list_assets {topic_id}`、`research:brief_get {topic_id, revision?}`；contracts/handlers/前端 API/SSE `research:updated` 各一套；chat 工具 `deep_research` 复用同一投递口。
- 选题卡状态机：无简报 → 「深调研」；进行中 → 进度（含各视角状态）；有简报 → 「生成于 X · 重跑」；partial → 附缺失视角；failed → 原因 + 重试；搜索 key 未配 → 按钮禁用 + 设置指引。

## 9. 边界清单（验收即此清单）

1. 状态：job 五态全部可见可查询；重启回收 running；简报过期标注。
2. 最坏输入：反爬页/超长页（截断）/防盗链图（降级）/伪造 quote（校验打回）/伪造 assetId（拒绝）/选题中途被删（failed 可见）。
3. 防呆：同选题并发触发合并；素材去重；重跑不打断旧简报可用性。
4. 失败可见：每视角失败原因入 job；下载失败逐条降级；配额耗尽在简报 gaps 点名。
5. 明确不做：视频下载、素材自动插正文、雷达全量自动触发、SVG、任务取消（R2）、多语言。

验收用例：四路全成→简报含 tensions（或显式空）且写稿 prompt 三条路径一致出现简报块；两路失败→partial+点名；伪造 quote 被打回后修复或视角失败；素材 candidate 态+来源齐全+SSRF/SVG/超像素拒绝矩阵；重跑 v2 失败→写稿仍用 v1；重启中断→job 回收重排；无简报选题→写稿行为与现状逐字一致；usedBriefRevision 可回溯到不可变文件。

## 10. 分期（P2-18 重切）

- **R1a（先行）**：job 模型 + broker（含来源登记与 quote 校验）+ 四视角 + 综合简报 + 统一注入 + IPC/选题卡。**素材只做「候选清单进简报」（链接级），不下载。**
- **R1b**：`fetchExternalImage` 加固下载 + 研究素材库 + 配图放置导入。
- **R2**：对标视角接 justoneapi 视频搜索、video_link 附数据、托管自动触发（挂 workflow-engine）、简报归因进数据回喂、任务取消。

## 11. codex 处置表（16 P1 + 2 P2）

| # | 发现 | 处置 |
|---|---|---|
| 1 | 素材归属未定义 | 裁决点：选题级研究素材库 + 放置时导入（§0.3/§7），待创始人确认 |
| 2 | research 槽前提与代码不符 | 吸收：注入下沉 generate-script 统一入口；知识库下沉拆成前置独立任务（§6） |
| 3 | 后台任务模型缺失 | 吸收：持久 job 五态 + lease + 启动回收 + SSE（§2） |
| 4 | 串行化不能靠进程内 Map | 吸收：job lease 30 分钟 + 非终态合并（§2） |
| 5 | 证据可伪造 | 吸收：broker 来源登记 + quote 子串校验打回（§3/§4） |
| 6 | 素材 URL 不应模型转述 | 吸收：broker 确定性采集，模型按 assetId 选（§3/§4） |
| 7 | 图片安全不足 | 吸收：格式白名单+magic bytes+像素上限+拒 SVG+hash 命名（§7） |
| 8 | 预算非硬约束 | 吸收：broker 配额（搜索/页数/字节）+ deadline + token 三层（§3），runLoop 软上限如实注明 |
| 9 | barrier 被最慢路拖死 | 吸收：allSettled + 每视角 4 分钟 deadline（§3/§5） |
| 10 | 重跑读语义缺失 | 吸收：briefRevision 指针只进不退，旧简报持续有效（§2） |
| 11 | 选题生命周期 | 吸收：启动续期一次、删除→failed、topicHash 过期标注（§2） |
| 12 | revision 与无历史冲突 | 吸收：不可变版本文件 v<N>.json（§5） |
| 13 | 成功判定松+强迫造张力 | 吸收：洞察≥2 且必须带来源；tensions 允许空（§4/§5） |
| 14 | prompt 安全与预算未落地 | 吸收：全局 4000 字符预算表 + 定界/转义/截断常量化锁测试（§6） |
| 15 | 简报写盘无原子性 | 吸收：tmp+rename + schemaVersion + 损坏可见降级（§5） |
| 16 | IPC 面不完整 | 吸收：四通道+SSE+选题卡状态机全清单（§8） |
| 17 | 图片抽取天真 | 吸收：srcset/相对 URL/追踪像素启发/双层上限（§3） |
| 18 | R1 过大 + broker 建议 | 吸收：重切 R1a（无下载）/R1b；broker 采纳为核心结构（§3/§10） |
