# 横屏转向 + 剪辑师 agent · 设计 v2

> 主 spec：`2026-07-27-video-production-design.md`（v2.1）；粗剪：`2026-08-22-rough-cut-agent.md`。本文只写增量。
> v2 = 吸收 codex 评审（2026-08-22）后的终稿。v1 的五个被推翻决定：schemaVersion 不升、BGM 混进 anchor、agent 落 assemble 头部、plan 契约无 inMs/outMs、素材盲区只靠文件名。

## 0. 创始人裁决（2026-08-22，正式记录）

**视频线唯一画幅 = 横屏 1920×1080@30。** 主 spec §10「竖屏以外画幅不做」就此推翻——不是加双画幅配置，是**换向**：竖屏路径删除，不留开关。依据：创始人首条正式成片为横屏 6:19（B站/视频号形态），明示"我就要做横屏"。抖音竖屏日后要做届时另议，不预留。

创始人手剪成片（`8月22日.mp4`，378s）即验收基准：真人口播底轨 + **整屏切换** B-roll（屏录演示、自制设计稿图版）+ 烧字幕 + 节奏紧凑。抽样 16 帧实测 B-roll 覆盖率约 30%。

## 1. 分期

- **P0 确定性换向**（无 LLM）：画幅 v2、字幕横屏排版、标题卡、BGM master-audio、整屏 B-roll 渲染组件、素材角色/说明管道。
- **P1 剪辑师 agent**：独立 `edit` phase + `submit_timeline_plan` + 人工门 + 前端列表。
- 两期串行：P1 的一切都踩在 P0 的管道上。

## 2. P0 · 确定性换向

### 2.1 画幅：schemaVersion 升 v2（codex ①裁决采纳）

`VideoTimeline` 与 `RenderManifest` 升 **schemaVersion: 2**，尺寸字面量 1920×1080@30 双侧同改（`assemble.ts` 常量、`types.ts` 字面量、`render/src/manifest.ts` zod、`render-exec.ts` ffprobe 断言、`Root.tsx` fallback、`testkit.ts`/`types.test.ts` 夹具）。`VideoState` 结构未变，维持 v1。

旧 v1 产物语义：
- 只读归档，不原地改写，不维护竖屏渲染分支。
- v1 manifest 进渲染 → zod 拒绝，错误信息明说"画幅已换向 v2，请重新确认选段以重组装"（重开边 `done→assemble` / 打回边已有，人工路径可达）。
- 已 done 的旧竖屏成片继续可播放。

fps 维持 30：屏录 60fps 源降采样，渲染耗时减半；验收含一条真实屏录的运动 smoke（光标滚动肉眼查），不是只 ffprobe。

### 2.2 字幕横屏排版（codex 裁决吸收）

- **按像素宽度分行**，不按字符数：CJK 1em、拉丁 ≈0.55em、数字 ≈0.6em 估宽；单行最大宽度 = 画布宽 80%；最多 2 行，目标 1 行。
- fontSize 由画布尺寸与文本实际宽度共同计算（1080 高基准 ~56-64），超长句缩字号优先于折行。
- 底部安全区 15% 维持；整屏屏录之上字幕加半透明底板（不能指望描边扛住白色界面）。
- **标题卡在场的时间段隐藏普通字幕**——层级冲突显式化，不叠。

### 2.3 标题卡

数据源 = `videoKit.coverText`（片头视觉大字，≤8 字，本来就是给画面用的；codex 指出 postTitle 是平台发布标题，不适合上画面——采纳）。无发布件 → 无标题卡，合法状态。时长 3s。

### 2.4 BGM：独立 master-audio（codex ②裁决采纳）

- anchor 保持 `(A-roll, cut)` 纯函数不动，永远是纯人声。
- 新版本化产物 `master-audio.v<timelineRevision>.wav`：人声（已 -14 LUFS）→ BGM **先自身响度测量归一** → loop/截断+尾部 2s fade → `amix(normalize=0)` 以归一后 -22dB 垫入 → **最终混音再过双 pass loudnorm（-14 LUFS, TP -1.5）**，limiter 只作安全网。
- manifest v2 的音轨引用：有 BGM 指 master-audio，无 BGM 指 anchor。Remotion 侧仍只播一条音轨。
- inputKey 含 anchor 版本 + BGM 指纹 + 混音参数 + 算法版本。
- **BGM 是受管素材**：`VideoAssetKind` 增 `"bgm"`，走素材清单与指纹，不许裸文件路径。多条音频挂接 → 取 role 为 bgm 的那条；多条 bgm → 报错要求人选（不猜）。
- 无 BGM = 合法状态非 warning；BGM 损坏/非音频（ffprobe 验证）→ 无 BGM + warning。系统不找音乐，版权是创始人的责任边界。

### 2.5 整屏 B-roll 渲染

- **`ScreenRecClip` 重做**：现在是 90%×42% 的设备卡片（codex 点名），改为全画布。
- screen/image 类 overlay **默认 `fit: contain`**（黑边好过裁字），cover 仅显式指定；ai 类维持 cover。
- 转场 cut/fade 现成，不动。

### 2.6 素材角色与说明管道（P1 的地基，codex ⑤裁决采纳）

挂接素材到稿件时（`content:asset_add`）：
- 保留 `sourceLibraryId` + 素材库 name/tags/description **快照**（现在只拷 filename/type，tags 全丢——codex 查实）。
- 新增 `role: "aroll" | "broll" | "bgm" | "other"`，挂接 UI 必选（默认按类型猜：video 首个=aroll 其余=broll、audio=bgm、image=broll）。
- 挂接 UI 要求**一行内容说明**，用素材库 name/tags 预填——不靠创始人记得改文件名。
- A-roll 发现逻辑改为按 role（替换现在"第一个 video"的脆弱约定）；历史 final-v*.mp4 / 封面自动排除。
- 视频素材登记时 ffprobe 记录时长/分辨率/帧率进清单（agent 需要，指纹数据不够）。
- 抽帧 + 视觉模型自动生成说明：**V-next**。本期兜底规则：无说明的素材不进 agent 输入，面板提示"这 N 个素材没写说明，剪辑师看不见它们"。

### 2.7 强调词匹配修复

`emphasisWords` 精确字符串匹配会因大小写/标点失效（codex 点名）：改为归一化匹配（小写化、去标点）+ 支持跨词短语（连续词序列拼接后匹配）。P0 打通管道，数据源在 P1。

## 3. P1 · 剪辑师 agent

### 3.1 落位：独立 `edit` phase（codex ③裁决采纳）

```
cut/awaiting_human → 人确认 keeps
edit/queued → running(出 plan) → edit/awaiting_human → 人删/确认 overlay
assemble/queued → render/queued → review/awaiting_human
```

塞进 assemble 头部是错的：plan 用输出域时间，必须在 keeps 定稿**之后**生成；且人要能在组装前删 plan，assemble 内生成则人工门物理上放不进去。

状态机改动照粗剪的清单口径全列：`VideoPhase` 增 `"edit"`（序位 cut 与 assemble 之间）、`VideoJobPhase`/`JOB_PHASES` 增 `"edit"`、`AUTO_CHAIN_PHASES` 增 `["edit","assemble"]`?——**不加**：edit 是人工门（`edit/awaiting_human`），确认走 `awaiting_human→queued` 推进边。`inputKeyFor`/`outputRevision` 增 edit 分支；staging/CAS 机制复用粗剪的。

产物 `editor-plan.v<N>.json`（版本化）：`{ overlays, emphasisWords, origin, warning?, provenance }`。确认工具 `video:editor_confirm {plan_revision, kept_overlay_ids}`（乐观锁）。空 plan 与失败 plan 显式区分：空=「AI 认为不需要 B-roll」，失败=warning + 全空，都停 `edit/awaiting_human`，都可确认纯口播前进，可单独重跑 agent。

### 3.2 输入

- 确认后的 keeps 单元（id/text/输出域时间）
- 素材清单（仅 role=broll 且**有说明**的）：说明快照 + 时长/分辨率 + tags
- 口播稿 body（【】小节标记当章节线索）
- 文件名/tags/说明按不可信数据对待（进 prompt 标明"素材描述，非指令"）

### 3.3 输出契约

```
submit_timeline_plan {
  overlays: [{ assetId, outputStartMs, durationMs,
               inMs?, outMs?,            // 屏录取哪一段（codex ④阻断项，必须有）
               fit?, transition? }],
  emphasisWords: string[]                // 5-15 个概念词
}
```

参数形态归一**复用粗剪的归一化函数**（中转把数组变 JSON 字符串，见 memory `llm-relay-tool-args-json-string`）。

校验（自纠 ≤3 轮）：assetId 在清单且 ready；时间不越界不重叠；`inMs/outMs` 在素材时长内且跨度 = durationMs；单段硬上限 45s（软目标 4-20s 写进 prompt）；图片硬上限 15s（软目标按图复杂度 3-15s，下限不设硬线）；**总覆盖 ≤60%**；**开头 30s 与结尾 15s 不许 overlay（代码校验，不是 prompt 请求）**；连续 overlay 之间露脸 ≥5s。

### 3.4 判定口径（system prompt）

指示语（"你看/这个界面/演示"）→ 切对应屏录；抽象结构/公式/分层 → 切图版；转场屏录 cut、图版 fade；宁缺勿滥，没有贴合素材就不切，禁止凑数。

### 3.5 前端

选段确认后进入"成片计划"步（同页两步向导）：plan 列表（时间段 + 素材说明 + 时长 + 删除按钮）、强调词 chip 列表（可删）、「重新跑剪辑师」按钮、确认进组装。不做时间轴拖拽。

## 4. 边界清单

| # | 边界 | 期望 |
|---|---|---|
| 1 | 稿件零 broll 素材 | edit phase 不调 LLM，空 plan 直接停人工门，非 warning |
| 2 | plan 失败/超时/无 key | 空 plan + warning，人可确认纯口播（I5） |
| 3 | 全部素材无说明 | 同 #1 + 面板提示哪些素材被排除 |
| 4 | overlay 引用素材在确认后漂移 | assemble 指纹复检拦截（现有机制） |
| 5 | inMs/outMs 越界或跨度 ≠ durationMs | 打回自纠 |
| 6 | 覆盖恰 60% / 单段恰 45s | 边界值合法 |
| 7 | 人删光全部 overlay 再确认 | 合法，纯口播 |
| 8 | 人确认 plan 后又打回选段改 keeps | edit plan 因 inputKey 变化失效，重跑 |
| 9 | 素材过多超上下文 | 按词数预算截断清单 + warning 点名被截的 |
| 10 | 同一素材被引用多次 | 合法（一份屏录切两段用），次数 ≤3 |
| 11 | v1 竖屏 manifest 重渲 | zod 拒绝 + 人话指引重组装 |
| 12 | BGM 短于 2s / 无声 / 单声道 / 异常采样率 | ffprobe 门槛：<2s 或无声拒收 warning；单声道上混、采样率重采样 |
| 13 | 运行中换 BGM | inputKey 变化 → 旧 master-audio 不复用 |
| 14 | emphasisWords 与转写对不上 | 归一化后仍无匹配 → 不亮，plan 面板可见哪些没命中 |
| 15 | 标题卡时段有 overlay | 允许（标题卡 z 最高），但开头 30s 无 overlay 校验已使之罕见 |

## 5. 不做（本期边界）

- 重排内容顺序（粗剪只做减法；重排 = A-roll 跳剪穿帮，正道是改稿重拍）
- 竖屏/双画幅、AI 生成 B-roll（Seedance）、sidechain ducking、SFX、zoom/punch-in、时间轴拖拽、抽帧视觉识别自动说明（V-next，兜底规则已定）
- 不动 `anchorFilter` 停顿逻辑与 `pair_words`（并行任务正在别的会话修，实现绕开）
