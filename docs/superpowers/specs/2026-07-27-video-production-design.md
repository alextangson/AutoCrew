# 文案→成片：视频生产线 · 设计 spec v2

日期：2026-07-27 ｜ 状态：已过 codex 评审（25 P1 + 5 P2 全部吸收，处置表见 §12）｜ 关联：video-production-research（2026-07-26 调研）、PRD-v4、deep-research spec（job/SSE 先例）、inbox spec（worker/注入纪律）

## 0. 背景与裁决

### 0.1 创始人裁决记录
- 2026-07-26：做「文案→视频剪辑」，要前沿 AI 剪辑方案 + 音色克隆作为灵活模块。
- 2026-07-27：定向——赛道 FDE/AI；**真人出镜口播为主线**（每周集中拍一批），屏录/程序化画面 + 克隆音色为轻量线；**纯 AI 生成视频只作 B-roll 补充**。
- 2026-07-27：默认值确认——AI 镜头每条 ≤3 个 / ¥30 上限（V0b 先 1 个）；音频走火山豆包声音复刻 2.0；每周拍一批。

### 0.2 存量裁决处置表
| 原裁决 | 处置 |
|---|---|
| PRD-v4 §10-C「剪辑师 v4 不入职、装配单 MVP 亦不做」 | **推翻**（创始人 2026-07-26/27 指示）。剪辑师（editor）以本 spec 入职 |
| IA v5 §46「成片是用户的活」 | **修订**：成片由系统产出，审片与发布仍是人的活 |
| platform-risk-reviews「B 级预填暂缓至视频链就绪」 | 前置条件在 V0 落地后满足，可另行重启评审（不在本 spec） |
| PRD-v4 发布分级（人亲手点发布）、agent 互聊禁止 | **不变** |

### 0.3 定位
成片是 Content `approved` 之后的后置阶段，与 videoKit（发布件）并列，绝不塞进生成管线。一切入口只投递任务，不阻塞聊天。

## 1. 范围与分期总览（P2-27/28 的答案）

- **V0a · 确定性骨架**（最小可走通，无任何 LLM/AI 生成参与）：A-roll 导入 → ASR 转写 → 人工选段（默认全 keep）→ **确定性组装**（底轨全程 A-roll + 逐词字幕 + 可手动指定 0-N 个屏录 B-roll 槽位）→ 渲染 → 审片 → 发布件（AI 标注判定=false 路径也被验证）。
- **V0b · 智能层**：LLM 粗剪建议（keep/flag 建议，人终裁）＋ LLM timeline 组装（受控枚举）＋ 程序化图形组件 ＋ AI 镜头采购链（**硬限 1 个/条**，含幂等与台账）。
- **V1**：豆包复刻 2.0 + 克隆音色 + P1 配音条目（TTS 锚）+ 修补句（渲染层盖脸校验）+ **自动粗剪**（静音/口癖检测——与 V0b 的「LLM 建议」是两回事，术语就此分开）+ BGM 拍点卡点 + 素材面板（重抽/换 prompt）+ 可灵 adapter + 剪映草稿逃生口 + AI 镜头默认配额升至 3。
- **V2**：pattern cards 注入 timeline 生成、完播率→timeline 特征归因回喂、P1 试错→真人重讲闭环、多账号 identity、OmniHuman 数字人席、托管定时。

## 2. 数据模型

### 2.1 落点：视频状态独立于 Content（P1-9 的答案）
仓库现状（2026-07-27 更新）：本节写作时 `local-store.updateContent()` 是非原子读改写且吞异常返回 null，并发写 Content 会互相覆盖——该问题已修（commit bc9a64a：全部 meta.json 写路径 tmp+rename 原子写 + 逐 content 串行队列，null 只表示不存在、其余失败向上抛）。**视频线状态仍不进 Content**——理由从「绕开底座风险」换成职责边界：phase×state 是构建管线的高频中间态，膨胀进稿件元数据只会让 Content 变成杂物抽屉：

- `contents/<id>/video/state.json`：视频构建全量状态，**tmp+rename 原子写 + 模块内逐 content 串行队列**（promise 链，与修复后的 local-store 同款）。
- Content 仅两处最小接触：终点盖 `videoReadyAt`（只盖一次，publishedAt 纪律）；成片登记为既有语义的 content asset（§6.4）——两处都落在修复后的 `updateContent`/`addAsset` 上，天然原子且串行。
- local-store 非原子问题当时**另立独立任务卡**——**已销**（2026-07-27，commit bc9a64a，全量 vitest 1967 项通过）。

### 2.2 `video/state.json`（phase × state，P1-4/5 的答案）
```ts
{ schemaVersion: 1, entryType: "aroll",
  phase: "ingest"|"transcribe"|"cut"|"assemble"|"render"|"review"|"done",
  state: "idle"|"queued"|"running"|"awaiting_human"|"blocked"|"failed"|"done",
  blockedReason?: "asr_not_ready"|"ffmpeg_missing"|"key_missing"|"aroll_drifted"|"budget_exceeded",
  failedPhase?: string, errorCode?: string, failReason?: string,   // 失败恢复点：重试 = 重投 failedPhase，回到其前置人工门产物
  revisions: { transcript?: number, cut?: number, timeline?: number, rendered?: number },
  inputManifest?: { bodyHash, videoKitHash?, identityHash },       // 生成所用输入指纹（P1-13/17）
  stale?: { body?: boolean, aroll?: boolean },                     // 输入漂移标注，不自动重跑
  updatedAt }
```
迁移表（仅列合法迁移，其余一律拒绝并可见）：`idle→queued(投递)`；`queued→running(claim)`；`running→awaiting_human(转写完/渲染完)｜failed｜blocked`；`awaiting_human→queued(人工确认推进下一 phase)`；`failed→queued(重试 failedPhase)`；`blocked→queued(阻因消除)`；`review 确认→done`。

### 2.3 transcript 与 cut 分离（P1-12 的答案）
- `video/transcript.v<N>.json`（**不可变 ASR 事实**，源时间域）：`{ schemaVersion, source: "funasr", segments: [{id, text, startMs, endMs, words: [{w, startMs, endMs}]}], scriptAlignment?: {matchedRatio} }`。重跑 ASR 才产生新 revision。
- `video/cut.v<M>.json`（**剪辑决策**，可多轮）：`{ transcriptRevision, keeps: segmentId[], flags: [{segmentId, flag: "misread"|"repeat"|"offtopic"}], origin: "default_all"|"llm"|"human", baseCutRevision? }`。LLM 建议与人工终裁都是新 cut revision，ASR 数据零复制。

### 2.4 双时间域与 EDL（P1-1 的答案）
剪掉片段后「A-roll 源时间」≠「成片输出时间」。定义确定性纯函数 `buildOutputMap(transcript, cut)`：
```ts
outputMap: [{ segmentId, sourceStartMs, sourceEndMs, outputStartMs }]   // keep 段按序拼接
```
- **timeline 一律工作在输出时间域**；主音轨 = keep 段音频按 outputMap 拼接（+loudnorm）。
- 字幕词级时间戳**不复制进 timeline**：渲染时经 outputMap 投影到输出域（纯函数，单测锁定）。
- A-roll 画面同理按 outputMap 切割拼接。

### 2.5 timeline JSON（schemaVersion 1；底轨+覆盖轨，P1-20 的答案）
```ts
{ schemaVersion: 1, fps: 30, width: 1080, height: 1920,
  anchor: { kind: "aroll", transcriptRevision, cutRevision },      // V1 加 kind:"tts"
  base: { type: "aroll" },                        // 底轨恒全程覆盖输出域——空洞按构造不可能
  overlays: [{ clipId, outputStartMs, durationMs,  // 覆盖轨：盖在底轨上，主音轨/字幕不受影响
               source: { type: "screen", assetId, inMs?, outMs?, fit }
                     | { type: "graphic", template: GraphicEnum, props }
                     | { type: "ai", assetId }
                     | { type: "image", assetId },
               transition?: TransitionEnum }],     // overlays 互不重叠；与底轨 z-order 固定：base < overlay < captions
  captions: { style: CaptionEnum, emphasisWords?: string[] },
  titleCard?: { template: TitleEnum, text, durationMs },           // 语义=输出域开头的覆盖层，不前插不改时长
  audio: { anchorGainDb: 0, bgm?: { file, gainDb, duckDb } } }     // bgm V1
```
校验（zod 全量）：枚举命中；overlays 不重叠、不越界输出域；assetId 在素材清单且 ready；durationMs>0。LLM 产出不合法 → 错误字符串自纠 ≤2 轮（generate-script 同款），仍败 → failed 可见。

### 2.6 素材清单与 AssetRef（P1-2 的答案）
仓库现状：`Content.assets` 无 id/状态；`library-store` 才有 id/path/missing。视频素材自建清单：
- `video/assets.json`：`[{ assetId, kind: "aroll"|"screen"|"ai"|"image", ref: AssetRef, status: "pending"|"generating"|"ready"|"failed"|"confirmed", fingerprint: {size, mtime, quickHash}, provenance?: {prompt, provider, taskId, requestId, costYuan} }]`
- `AssetRef = {kind:"library", id} | {kind:"content", filename} | {kind:"video", file}`（video = `contents/<id>/video/assets/` 下生成物）。统一 resolver：解析绝对路径 + 存在性 + fingerprint 复检。

### 2.7 受控枚举单一来源（P1-18 的答案）
`src/modules/video/timeline-registry.json`（**纯 JSON，无代码依赖**）：各枚举及其 props schema 描述。主进程 zod 校验从它构建；render workspace 以相对路径读取同一文件并做**第二次校验**（render CLI 是最终守门）。**禁止跨 workspace import TS 源码**。V0 各枚举 1 款：`code-block`/`cut`+`fade`/`word-highlight`/`hook-title`。

### 2.8 render manifest（冻结点，P1-14/24 的答案）
assemble 终点产出 `video/render-manifest.v<K>.json`：`{ timelineRevision, cutRevision, transcriptRevision, assets: [{assetId, absPath, fingerprint}], identityHash, provenance: { hasAiClips, hasClonedVoice } }`。**render 只消费冻结 manifest**；发布件的 AI 标注判定**只读被审那版 rendered manifest 的 provenance**，绝不读"当前 timeline"。

## 3. 执行模型（P1-6/7/8/10 的答案）

- `<dataDir>/video/jobs.jsonl`：append-only。job：
```ts
{ jobId, contentId, phase: "transcribe"|"assemble"|"render",
  inputKey,                              // {transcript|cut|timeline}Revision 组合，读视图按 {contentId, phase, inputKey} latest-wins
  status: "queued"|"running"|"succeeded"|"failed",
  attempts, leaseOwner,                  // pid+launchId
  claimedAt?, heartbeatAt?, startedAt?, settledAt?,
  outputRevision?, errorCode?, failReason? }
```
- **lease 10 分钟 + 心跳 60 秒续租**（渲染可长跑）；启动回收「心跳过期的 running」。
- **settle 带 CAS**：完成时校验 `leaseOwner` 仍是自己 **且** state.json 当前期望的 inputKey 未变；不满足 → 结果只登记为历史产物（文件保留），不推进状态（旧 revision 渲染完不许污染新状态）。
- 进程内单例串行 runner（渲染吃满 CPU）；所有入口投递即返回。
- 写盘：jobs.jsonl append + state.json 原子写，同 content 更新走串行队列（§2.1）。

## 4. 真人素材线

### 4.1 前置校验（P1-16 的答案）
`video:build_start` 入口 eligibility：content 存在且未删；status ∈ {approved 及之后}（含 published，允许重剪）；平台 ∈ VIDEO_PLATFORMS。运行中 content 被删 → job failed 原因可见（deep-research 同款）；workspace 切换 → video runner 随 dataDir 重建（inbox-runtime 同款）。

### 4.2 Ingest 与可复现性（P1-15 的答案）
A-roll 选自素材库或路径直选，**引用不复制**；`ffprobe` 校验容器/时长（>30 分钟拒收）。登记 fingerprint `{absPath, size, mtime, quickHash: sha256(首1MB+末1MB+size)}`——全量 hash 对 2GB 文件太贵，quickHash 是显式取舍。**每个 phase 开跑前复检**：漂移 → `blocked: aroll_drifted`，人确认后重转写或换文件；可选 `snapshotCopy` 配置（默认关）给要强可复现的人。

### 4.3 ASR sidecar（FunASR）
- `sidecars/asr/`：pyproject + uv；Paraformer fa-zh 字级时间戳；契约 `uv run asr.py --audio <path> --out <json>`（§2.3 结构），stderr 进 run-log，长音频内部 VAD 分段。
- 首跑模型下载 ~1GB：doctor 检查项 + `video:asr_warmup` 预热；未就绪 = `blocked: asr_not_ready` + 装法指引。

### 4.4 选段（V0a 人工，V0b 加 LLM 建议）
- V0a：cut.v1 = `origin: "default_all"` 全 keep，人工在分句视图勾选 → cut.v2 `origin: "human"`。
- V0b：scout 路由产 `submit_rough_cut {keeps, flags}`——**只能引用存在的 segmentId**，非法引用打回自纠；`matchedRatio < 0.5` 时不给 LLM 建议权（全 keep + 「差异大请手工选段」提示）。口播稿取 `Content.body`（**仓库无 Content.draft 字段**——v1 spec 笔误，以 body/versions 为准），hash 进 inputManifest。
- **人工确认带乐观锁（P1-11）**：`video:cut_confirm` 必须带 `baseTranscriptRevision + baseCutRevision`；与当前不符 → 冲突返回，UI 重载。`video:review_confirm` 同理带 `renderedRevision`。

## 5. 音频层

- V0 主音轨 = A-roll keep 段拼接 → `ffmpeg loudnorm` 双 pass -14 LUFS（常量）。BGM V1（静态 -18dB + duck -12dB 起步，卡点后续）。
- V1 接口预留：豆包复刻 2.0（`api/v3/tts/*`，`enable_subtitle` 词级时间戳；justoneapi 式封装）；克隆音色（5 秒样本+授权声明）；修补句渲染层校验：**修补区间必须被非 aroll overlay 覆盖**。timeline 只认 `anchor` 抽象，换 TTS 锚不改结构。

## 6. 合成渲染层

### 6.1 render workspace
`render/` 独立 workspace（remotion v4、@remotion/captions、@remotion/fonts、zod）；**主 package.json 零新增**。契约：`npm --prefix render run render -- --manifest <path> --out <path>`；进度 JSON lines 走 stdout → job 进度；stderr 环形截断 256KB 进 job。外部二进制 ffmpeg/ffprobe：doctor 检查 + brew 指引。字体本地化 + 子集化构建脚本。渲染并发首跑 `remotion benchmark` 写入配置。

### 6.2 渲染事务边界（P1-19 的答案）
渲染输出到 `final.v<K>.mp4.tmp` → **ffprobe 校验**（容器完整、1080×1920、30fps、时长=输出域总长 ±0.5s）→ rename 就位。失败产物改名 `.failed` 留档，**绝不登记为 asset**。

### 6.3 V0 组件库（进库才进生产）
`ARollFrame`（底轨全屏+安全区）、`WordHighlightCaptions`（逐词高亮+强调色）、`ScreenRecClip`（圆角设备框）、`CodeBlock`（代码高亮打字进场）、`HookTitle`、转场 `cut`/`fade`。新模板：Claude Code + Remotion Skills 开发 → registry.json 登记 → 测试 → 才可被 LLM 引用。

### 6.4 成片登记与播放（P1-3 的答案）
- 成片经既有 `assets/` 语义登记（`final-v<K>.mp4` 拷入 `contents/<id>/assets/`，Asset.type="video"）；中间产物留 `video/`。
- **新增鉴权媒体端点**（server.ts）：`GET /api/video/media/<contentId>/<file>`——server-token 鉴权 + 路径白名单（仅 video/ 与 assets/ 下已登记文件）+ **HTTP Range 支持**（前端 `<video>` 拖进度条必需）。没有它 video_review 播不了本地成片。

## 7. AI 镜头采购（V0b 起；硬限 1 个/条，V1 升 3）

### 7.1 幂等（P1-21 的答案）
`video/procurement.jsonl`：**先写 `{requestId, status: "submitting", prompt, estYuan}` 再发网络请求**；供应商受理 → 补 `taskId, status: "submitted"` → 轮询 → `done|failed`。启动对账：`submitting` 且无 taskId 的孤儿 → 标 `unknown` 并**呈现给人裁决**（供应商无幂等键时绝不盲重提）；有 taskId 的按 ID 续查。
### 7.2 预算台账（P1-22 的答案）
`video/spend.jsonl`：提交前按**版本化价目表**（常量：Seedance ¥0.95/秒@720p，标注生效日期）写 `reserve {requestId, estYuan}`；结果落 `settle {actualYuan | released}`。预算判定 = settled + 未结 reserve < 上限；超限 → `blocked: budget_exceeded`，拒绝投递不是提醒。重试计费按新 reserve 记账。
### 7.3 失败重排（P1-23 的答案）
镜头 failed → **assemble 内显式子步骤**：LLM 收到失败槽位重产 timeline（新 revision，全量校验），该 AI 槽位改 graphic/screen；不是渲染期悄悄兜底。
### 7.4 提示词安全
确定性词表过滤（名人/影视 IP）+ prompt 纪律双层；prompt/参数/费用全量进 run-log。首帧走既有 relay `gpt-image-2` → i2v（火山 Seedance 一家起步）。

## 8. 配置、IPC、SSE 全接线

### 8.1 配置
`<dataDir>/video.json`（600，掩码/掩码回传守恒/变更热重启三件套照 settings-inbox）：`{ volcAppId?, volcAccessToken?, voiceId?, budget: {aiShotsPerContent, aiYuanPerContent}, renderConcurrency?, snapshotCopy?: boolean }`。`video-identity.json`：V0 `{captionTheme: {font, primaryColor, emphasisColor}, codeTheme}`。
### 8.2 IPC（channels + channel-contracts + ipc 三处登记；handler 按模块新建 `video-handlers.ts`，payload 校验与异常包装沿既有 handler 惯例——`wrapExecute` 仅用于其本职的 execute 注入，P2-26）
`video:build_start {content_id}`、`video:status {content_id}`、`video:transcript_get`、`video:cut_confirm {content_id, keeps, flags, base_transcript_revision, base_cut_revision}`、`video:review_confirm {content_id, rendered_revision}`、`video:retry {content_id}`（重投 failedPhase）、`video:asr_warmup`、`video:settings_get/set`。
### 8.3 SSE 完整链（P1-25 的答案）
仅登记通道不产生事件——四件套：① 状态每次落盘后 `broadcast("video:updated", {contentId})`（desktop/server.ts）；② 前端 `transport.ts` 事件联合类型加 `video:updated`；③ 订阅方收到后重拉 `video:status`；④ **SSE 断线重连后无条件重拉一次**（事件可能丢）。
### 8.4 chat/UI/计时
chat 工具 `build_video`（投递）；`AGENT_LABELS` 加 `editor`；系统提示补一条。UI：Editor「成片」卡（状态机按钮）+ 分句选段视图 + 审片视图（媒体端点播放 + 确认/打回）。发布件卡片按 §2.8 provenance 显示 AI 标注硬提示。`videoReadyAt` 盖戳；`production-timing` 加第四段——**仅对启用视频构建的 content 统计，独立 `missingVideoStamps` 计数，不污染既有三段**（P2-29）。

## 9. 分期任务切割

- **V0a**：§2 全部数据模型 + §3 job 骨架 + §4.1-4.4(人工路径) + §5(V0) + §6 全部 + §8 全部。无 LLM、无 AI 采购、无 BGM。
- **V0b**：LLM 粗剪建议 + LLM timeline（writer 路由）+ graphic 组件启用 + §7 采购链（配额 1）。
- **V1/V2**：见 §1。

## 10. 边界清单（验收即此清单）

1. 状态：phase×state 全可见可查询；blocked 四原因各有人话指引；failed 带 failedPhase 且 `video:retry` 只重投该 phase。
2. 最坏输入：>30 分钟/损坏容器拒收；空转写（纯音乐）→ cut 空结果提示；matchedRatio<0.5 → 全 keep 提示；A-roll 移动/改动 → aroll_drifted 阻断；LLM 非法引用 segmentId/assetId → 打回 ≤2 轮；AI 镜头拒审/超时 → 单镜头 failed + 重排子步骤；渲染崩溃 → .failed 留档可重试。
3. 并发防呆：同 content 重复投递合并（inputKey latest-wins）；渲染中确认旧版被乐观锁拒绝；旧 revision settle 被 CAS 拒绝只留历史；跨进程重复渲染被心跳 lease 阻止。
4. 幂等与钱：submitting 孤儿对账呈人裁决，绝不盲重提；预算 reserve+settle 台账可审计；价目表带版本。
5. 失败可见：全链无静默降级；stderr 截断留档；AI 标注只读 rendered manifest provenance。
6. 明确不做（V0）：全自动发布、剪映导出、MCP 工具、双 TTS、多账号、对标视频 ASR、BGM 卡点、竖屏以外画幅。（local-store 原子化改造原列此处，任务卡已销——2026-07-27 修复落地，§2.1）

验收用例：创始人真拍一条 → V0a 全链到 done → 发布件含标注判定（false 路径）→ 真实发抖音；transcribe 中杀进程重启 → 心跳过期回收重排；两窗口并发 cut_confirm → 后到者冲突可见；改稿两轮 → cut v3/timeline v2/render v2 链路一致且旧 mp4 留档；A-roll 拍后被改名 → assemble 前复检 blocked；ffprobe 断言 1080×1920/30fps/时长=输出域±0.5s（**不做逐帧 golden**）；V0b：预算超限拒投递、submitting 孤儿重启后呈现人裁决、AI 槽位失败重排出新 revision。

## 11. 测试策略（P2-30 的答案）

- 纯函数重点：`buildOutputMap`（含空 keep/单段/全删边界）、字幕投影、timeline zod 矩阵、迁移表、乐观锁/CAS、预算判定。
- 契约测试：**mock ASR sidecar（固定 JSON 输出的假脚本）常开**——验 spawn/超时/信号/半文件/进程树清理；真 FunASR 用 3 秒 fixture 在本地 `npm run smoke:video` 跑（doctor 报告上次真跑时间，CI skip 计数可见不静默）；render CLI 以 1 秒 manifest 真渲染 + ffprobe 断言，进本地 check 门。
- DI：`deps?: {runLoopImpl?, fetchImpl?, spawnImpl?, nowImpl?}` 全线；LLM 输出不 exact-match。

## 12. codex 处置表（25 P1 + 5 P2）

| # | 发现 | 处置 |
|---|---|---|
| 1 | timeline 源/输出双时间域混用不可执行 | 吸收：EDL outputMap 纯函数 + timeline 全面改输出域 + 字幕投影（§2.4） |
| 2 | Content.assets 无 id/ready，assetId 无从解析 | 吸收：video/assets.json 清单 + AssetRef 判别联合 + resolver（§2.6） |
| 3 | video/ 目录与 Asset 语义冲突；无 mp4 播放端点 | 吸收：成片入 assets/ 既有语义；新增鉴权+Range 媒体端点（§6.4） |
| 4 | 状态模型缺 idle/blocked 等，phase 与结果混杂 | 吸收：phase × state 拆开 + 迁移表 + blockedReason 枚举（§2.2） |
| 5 | failed 丢失恢复点 | 吸收：failedPhase + video:retry 只重投该 phase（§2.2/§8.2） |
| 6 | 按 contentId latest-wins 丢任务 | 吸收：jobId + {contentId, phase, inputKey} 读视图（§3） |
| 7 | job schema 不完整 | 吸收：attempts/leaseOwner/heartbeatAt/outputRevision 等补齐（§3） |
| 8 | 固定 30 分钟 lease 重复渲染 | 吸收：10 分钟 lease + 60 秒心跳续租 + owner 校验（§3） |
| 9 | updateContent 非原子并发覆盖 | 吸收：视频状态独立 state.json + 原子写 + 串行队列；local-store 修复已落地（2026-07-27 bc9a64a，§2.1） |
| 10 | 旧 revision settle 污染新状态 | 吸收：settle CAS 校验 owner+inputKey，旧结果只留历史（§3） |
| 11 | 人工确认无乐观锁 | 吸收：cut/review confirm 必带 base revision，不符冲突返回（§4.4） |
| 12 | transcript 混合事实与编辑 | 吸收：不可变 transcript + 版本化 cut 决策分离（§2.3） |
| 13 | Content.draft 不存在；输入无版本绑定 | 吸收：以 body 为准 + inputManifest 指纹 + stale 标注（§2.2/§4.4） |
| 14 | assemble 产物与 DAG 不明 | 吸收：assemble 终点冻结 render-manifest，render 只吃 manifest（§2.8） |
| 15 | A-roll 引用不复制破坏可复现 | 吸收：fingerprint 登记 + 每 phase 复检 + aroll_drifted 阻断 + 可选快照（§4.2） |
| 16 | build 前置条件缺失 | 吸收：eligibility 校验 + 中途删除/workspace 切换行为（§4.1） |
| 17 | 「storyboard 若有」时序不确定 | 吸收：输入以 inputManifest 显式钉死，用没用、用哪版可回溯（§2.2） |
| 18 | 枚举同源跨 workspace 不闭合 | 吸收：registry 纯 JSON 单源，双侧各自校验，禁跨界 import（§2.7） |
| 19 | 渲染无事务边界 | 吸收：tmp → ffprobe → rename；.failed 留档不登记；stderr 截断（§6.2） |
| 20 | 视觉允许黑屏空洞；titleCard 语义不明 | 吸收：底轨+覆盖轨模型，空洞按构造不可能；titleCard=开头覆盖层（§2.5） |
| 21 | 任务 ID 先持久化仍会重复扣费 | 吸收：requestId 先写 submitting + 孤儿对账呈人裁决，禁盲重提（§7.1） |
| 22 | 预算无可计算口径 | 吸收：版本化价目表 + reserve/settle 台账 + 未结预占计入（§7.2） |
| 23 | AI 失败重排无 revision 语义 | 吸收：assemble 显式子步骤产新 revision 全量校验（§7.3） |
| 24 | AI 标注读当前 timeline 会标错 | 吸收：只读被审 rendered manifest 的 provenance（§2.8） |
| 25 | SSE 只登记通道不会有事件 | 吸收：broadcast + transport 联合类型 + 重拉 + 断线重连重拉四件套（§8.3） |
| 26 | wrapExecute 用法误读 | 吸收：按模块 handler 组织，wrapExecute 只做本职（§8.2） |
| 27 | V0 失败面过大非骨架 | 吸收：重切 V0a（确定性无 LLM）/V0b（智能层）（§1/§9） |
| 28 | 分期矛盾（粗剪术语/1vs3 镜头） | 吸收：LLM 建议(V0b)与自动粗剪(V1)术语分开；V0b 硬限 1 个（§1/§7） |
| 29 | production-timing 缺戳统计被污染 | 吸收：视频段仅对启用内容统计 + 独立 missingVideoStamps（§8.4） |
| 30 | ASR/渲染真链路 CI 永久 skip | 吸收：mock sidecar 契约常开 + smoke:video 真跑 + doctor 报告真跑时间（§11） |
