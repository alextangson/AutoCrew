# 剪辑师工作流 v2 · 三道审核门 + 字幕重做（终稿）

> 前序：`2026-08-22-landscape-video-editor.md`（P0/P1 已落 main：`605cb31`、`e4578ed`）。本文只写增量。
> v2 终稿 = 吸收 codex 评审（2026-08-23）。被推翻的三个初稿决定：预览自环复用 cut runner（并发模型错误）、填槽原地改 plan（违反版本化纪律）、字幕块渲染端自算（违反 manifest 冻结契约）。

## 0. 创始人反馈 → 裁决

| # | 反馈 | 裁决 |
|---|---|---|
| 1 | 不要逐词黄色强调特效，字幕阴影+脱底即可 | emphasis 机制整删（§3，删除清单齐全） |
| 2 | AI 做好字幕断句，每屏恰到好处 | 字幕块按语义单元冻进 manifest（§2） |
| 3 | 逐字飞入太 low，暗底可以 | 生成工艺红线（§5.2） |
| 4 | 三道审核：粗剪看片 → B-roll 描述 → 成片 | 门内交互重构（§4），门的数量与位置不变 |
| 5 | B-roll 用 erduo 生成 | 可以；创始人在环，不做无头自动化（§5） |

## 1. 不变量

- 三门格局不变（cut / edit / review），只改门内交互。
- 预览是预览：低规格快出可重渲；正式成片永远全规格冻结渲染；预览文件绝不冒充成片。
- 版本化产物只增不改：任何"修改"都是派生新 revision（填槽、重选段、重预览请求全同此理）。
- manifest 是跨 workspace 冻结契约：字幕块、时间映射全部在 assemble 侧算完冻结，渲染端只做视觉布局。

## 2. 字幕重做

### 2.1 数据流：cue 冻进 manifest（RenderManifest 升 v3）

现状问题：assemble 把 edit-units 拍平成词流，单元边界在 `projectWordsToOutput` 丢失，渲染端纯宽度分组自然断错。改为：

```ts
captions: {
  style: "plain",
  cues: [{ cueId, startMs, endMs, words }]   // 输出时间域，assemble 冻结
}
```

- **cue 切分全部在 assemble**：kept 单元投影到输出域 → 单元过长时块内二次切分（优先标点，其次最大词间时隙，最后宽度预算硬切）→ 冻结。
- **渲染端只管 cue 内布局**：≤2 行、行宽 ≤80% 画布、字号自适应；显示窗 = cue 的 startMs..endMs，**删除现有 1 秒 linger**（块间无残影）。
- 单元来源按 `edit-units.origin` 分派（注意：真实字段是 origin，初稿写的 segmentation 不存在）：`"llm"` → 语义 cue；`"raw"` → assemble 内退回宽度分组产 cue。**渲染端永远只认 cues，单一路径**。
- 空 words 的单元产不出 cue，跳过（该段无字幕——尾部无词时间戳的既有问题另案在修）。
- 超长单 token（URL/英文长词）超行宽：字号下压到该 cue 放得下为止，绝不溢出画布。

### 2.2 样式

- `WordHighlightCaptions` 重写为 `Captions`：全词 `primaryColor`，无逐词变色无 scale。
- 阴影保留 + **底板常开**（创始人手剪基准就是黑底板白字）；`captionBackdropSpans` 按时段开关的整条逻辑删除。
- registry `captions` 枚举 `word-highlight` → `plain`。
- `captionTheme.emphasisColor` **改名 `accentColor`**，不删——标题卡还在用它当强调色（codex 点名，直接删会弄坏 HookTitle）。

### 2.3 manifest v3 与旧产物

- v3 变更：`captions.cues` 取代 `captions.words`+`emphasisWords`；identity 字段改名。宽高 fps 字面量不动。
- 旧 v2 manifest 重渲：zod 拒绝 + 人话指路（与画幅 v2 同策略），且**补上 render/failed 的死路出口**：新增受控回退边 `render/failed → assemble/queued` 与 `video:reassemble` 动作——否则 retry 永远重投同一份废 manifest，"指路重组装"对 render/failed 用户是假话（codex 点名）。
- 已 done 旧成片：MP4 直接可播，不受影响；重开边现有链路走得通。

## 3. emphasis 机制整删（落点清单 = 验收清单）

生产代码：`editor.ts`（契约+prompt）、`editor-plan.ts`（归一/未命中/上限）、`phases.ts`（staging/读取）、`service.ts`（确认参数+产物写入）、`timeline-build.ts`（emphasis.vN 读写+timeline 字段）、`types.ts`、`timeline-validate.ts`、`assemble.ts`（冻结+identity）、`timeline-registry.json`、`video-handlers.ts`（IPC payload）、`frontend/src/lib.ts`、`VideoPlanStep.tsx`（chips）、`render/src/manifest.ts`、`VideoComposition.tsx`、`WordHighlightCaptions.tsx`→`Captions.tsx`、`render/src/emphasis.ts` 删除。

测试：`editor/editor-plan/phases/service/assemble/timeline-validate/timeline-registry/types/video-handlers` 各 test 更新；`render/src/emphasis.test.ts` 删除；`render/src/time.test.ts` 改为无 linger + cue 语义。

**别误删**：`frontend/src/editor/live-markdown.ts` 的 `Emphasis` 是 Markdown 斜体，与此无关。旧 `emphasis.v*.json` 留盘无害不迁移。

## 4. 三道审核门

### 4.1 门一 · 粗剪审核（看片）

**初次预览**：cut job 运行段顺序执行"粗剪 LLM → 预览渲染"，然后停 `cut/awaiting_human`。预览失败降级进门（列表照常可确认，横幅可见）。

**门内重渲——独立辅助 job，不是 VideoPhase**（codex ①裁决采纳，初稿的自环复用 cut runner 作废）：
- 主状态全程钉在 `cut/awaiting_human`，确认不被渲染阻塞（门就是门）。
- 请求产物不可变：`cut-preview-request.v<P>.json` `{keeps, baseCutRevision, baseTranscriptRevision, renderAlgoVersion}`——**不写正式 cut revision**，草稿不污染 cut 语义；`cut_confirm` 才写 human cut revision。
- 状态侧字段：`preview: {requestedRevision, readyRevision, error?}`。settle 校验 lease + 仍是当前 requested revision + 仍在 cut 门；旧结果标 superseded 丢弃，不更新播放器指针。latest-wins 的最低实现 = 旧结果不发布（per-preview abort 是优化项，不在本期硬性要求）。
- 产物 `preview.v<P>.mp4`：tmp → ffprobe 断言（h264/960×540/30fps/有音轨/时长）→ rename；**不登记稿件 asset**；成功后删除更老的 preview 文件（保留策略：只留最新）。
- 预览 manifest 与正式**共享同一个 manifest builder**（无 overlay 无 BGM 无标题卡，但有 anchor 音轨与字幕 cues），不许出现第二套时间映射逻辑。
- 媒体端点无需后端改造（video 目录下安全 mp4 已放行），只加前端 URL helper。

**渲染规格**：render CLI 增 `--profile preview|final`（不开放散参数）。preview = Remotion `scale: 0.5` + `x264Preset: "veryfast"` + `crf: 28`；manifest 尺寸保持 1920×1080 契约，靠 scale 输出 960×540。`runRenderJob` 不复用（它断言全规格+登记 asset），另立 preview 执行器。速度是目标不是承诺。

### 4.2 门二 · B-roll 计划审核（三类来源 + 门内填槽）

plan overlay 的 source 判别联合：

```ts
source:
  | { kind: "asset", ref: AssetRef, name, type, durationMs?, fingerprint }  // 快照钉住，不再用 b1/b2 临时号对外
  | { kind: "generate", description, mediaKind: "video" | "image" }
```

- `generate` 槽有完整 outputStartMs/durationMs，计入覆盖率与禁区校验（它就是未来的画面）。description 必须可直接当生成指令（§5.2 规范）。`styleHint` 砍掉（无消费者）。
- **删除 editor preflight 的零素材短路**：没有已挂素材时 LLM 照样跑——它现在可以全提 generate 槽（codex 点名，这条短路留着 generate 就永远不会在零素材稿件上出现）。
- **填槽 = 派生新 plan revision**（codex ③裁决采纳）：`video:editor_slot_fill {plan_revision, overlay_id, library_id}` → 读当前 plan → 写 `editor-plan.v<N+1>`（`origin:"human"`, `basePlanRevision:N`，仅目标槽 source 替换为 asset 快照）→ 原子更新 `revisions.editor`。乐观锁：plan_revision 不符 → 冲突重载。多窗口后提交者冲突，不覆盖。
- 填槽校验按 mediaKind：video → 时长 ≥ 槽位 durationMs，`inMs=0, outMs=durationMs`（V-next 再做取段）；image → 无时长检查。填槽时即打指纹快照，assemble 复检对着**填槽时的快照**（不是 assemble 才第一次建）。
- 确认：只有 asset 槽写入 overlay slots；未填 generate 槽**显式丢弃**（面板明示"N 个待生成槽未填充，确认后跳过"）。丢弃后无需重算硬限：全部约束都是 overlay 存在性的上界（覆盖率/禁区/单段时长），只删不增不可能新违反——此理由写进代码注释。
- 门内上传素材入口直达（复用素材附件）+「重新跑剪辑师」已有。
- 升级兼容：旧 `editor-plan.v1`（含 emphasisWords、b1 号）停在门上时：读取容忍未知字段并忽略；旧 plan 确认走新逻辑（asset 槽映射兜底 b 号→目录）。一次性容忍，不留长期 shim。

### 4.3 门三 · 成片审核（不变）

全规格渲染：AB roll + BGM + 转场。review 门与打回边不动。

## 5. erduo 协作（产品约定，零状态机代码）

- 定位：创始人在环的外部镜头供应商。它自带 canary 人选门，无头自动化与其设计相抵触，不做 provider/taskId/自动化接口。
- **§5.2 描述规范**（写进剪辑师 system prompt）：generate 槽 description = 画面主体 + 关键文字内容 + 节奏（例："数字滚动 80%→20%，暗底细网格，克制"），禁止空话。
- **§5.3 生成工艺红线**（创始人品味，2026-08-23）：禁止逐字 3D 飞入/字符拆解组装；暗底细网格气质保留；动效=整块淡入/位移/遮罩揭示+克制缓动；表现力峰值给语义不给字符杂技。

## 6. 边界清单

| # | 边界 | 期望 |
|---|---|---|
| 1 | 初次预览渲染失败 | 门照开可确认，横幅可见（I5） |
| 2 | 连点重渲 | 新 request revision 递增；旧结果 settle 时发现非当前 → superseded 丢弃 |
| 3 | 预览渲染中直接确认 | 合法；确认后迟到的预览结果不得写状态（settle 校验"仍在 cut 门"） |
| 4 | 进程重启时预览 job 在跑 | lease 过期回收；stale settle 被 CAS 拒 |
| 5 | 预览半成品文件 | tmp→ffprobe→rename，媒体端点永远读不到半截 mp4 |
| 6 | 预览文件堆积 | 成功后删旧，只留最新 |
| 7 | cue 内超长 token | 字号下压兜底，绝不溢出 |
| 8 | 单元 words 为空 | 无 cue，该段无字幕，不崩 |
| 9 | `origin:"raw"` 单元 | assemble 内宽度分组产 cue，渲染端无感 |
| 10 | 旧 v2 manifest 重渲 | zod 拒绝 + 人话；render/failed 走 `video:reassemble` 回 assemble |
| 11 | 填槽素材时长不足（video） | 拒绝并提示；image 无此检查 |
| 12 | 填槽后素材被替换 | assemble 对填槽时指纹复检，漂移即 blocked |
| 13 | 全部 generate 未填后确认 | 纯口播出片 + 明示跳过数；硬限无需重算（只删不增） |
| 14 | 填槽后打回门一改 keeps | plan 因 inputKey 失效重跑；已填素材仍在素材库不丢 |
| 15 | 旧 plan（emphasis 字段/b 号）停在门上 | 容忍读 + 忽略未知字段，确认可走通 |
| 16 | 预览与正式规格漂移 | 共享 manifest builder，仅 profile 不同（结构性保证） |
| 17 | BGM 出现在预览里 | 不可能：预览 manifest 构造时不含 bgm 输入 |

## 7. 不做

- erduo 无头自动化、字幕独立断句 LLM、SFX、zoom、时间轴拖拽、per-preview AbortController（优化项后补）、generate 视频填槽取段（inMs/outMs 定 0 起）
- 不动粗剪判定与 P1 校验硬限；三门格局不变
- 不清理旧 emphasis.v*.json 盘上残留
