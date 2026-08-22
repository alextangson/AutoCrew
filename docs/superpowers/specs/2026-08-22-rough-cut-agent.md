# 粗剪 agent（V0b 第一刀）· 设计 v2

> 主 spec：`2026-07-27-video-production-design.md`（v2.1）。本文只写增量。
> 覆盖主 spec §1 V0b 的「LLM 粗剪建议」一项。LLM timeline 组装、AI 镜头采购、graphic 组件不在范围内。
> v2 = 吸收 codex 评审（2026-08-22）后的终稿；v1 的两轮 LLM 方案已废弃，理由见 §2。

## 0. 问题（实测）

2026-08-22 用一条真实口播跑通 V0a：15.5 分钟 / 1080×1920 / 30fps / HEVC。转写产物实测：

| 指标 | 值 |
|---|---|
| 有效语音 | 538s（VAD 已切掉 390s 静音） |
| 分句数 | 260，平均 2.1s |
| 句末非终止标点（断在句中） | 168 句 / 64% |
| 短于 1.5s 的碎片 | 100 句 / 38% |
| 词级时间戳覆盖率 | **95.7%**（2732/2856） |
| 词数与文本单元数不等的分句 | **96 / 260** |
| **words 完全为空的分句** | **10（尾部 seg-0251..0260）** |
| 时间戳非单调次数 | 0 |
| scriptCoverage（原 matchedRatio） | 0.499 |

两条结论：

1. **ASR 分句不能当剪辑单位。** VAD 按静音切，停顿 ≠ 句子边界。
2. **重录的废弃 take 与保留 take 共享同一个分句**，例如「阶工作效率确」= 好 take 结尾 + 重录开头。按整句取舍在物理上分不开它们。

### 0.1 顺带查实的两个既有缺陷（不在本文修复范围，另行立项）

- **尾部无字幕**：`pair_words`（`sidecars/asr/asr.py:110`）在文本单元数与时间戳数不等时 `zip` 取短的一侧，本例导致尾部 10 句拿不到任何词时间戳。这些分句在成片里**没有字幕**。
- **全留也会剪掉全部停顿**：`anchorFilter`（`src/modules/video/assemble.ts:137`）对每个 keep 段 `atrim` 后 `concat`，段间间隙一律丢弃。所以 V0a 的「全留」实际输出 538s 而非 928s，390s 停顿被剪光。语义重分单元后单元变长，单元内停顿会回来，方向是改善；但这个行为本身应当显式化。

## 1. 不变量

- **I1 词是原子。** 只对 ASR 词序列做**分组**与**取舍**，绝不新造、修改、插值 `w / startMs / endMs`。
- **I2 事实与派生分家。** `transcript.vN` 原样保留 FunASR 产物（`source:"funasr"` 不被冒用）。重分出来的剪辑单元落**独立产物** `edit-units.vK`，标明 `origin` 与 provenance。
- **I3 区间半开。** 一切词索引区间为 `[start, end)`。覆盖判定、补集运算、边界用例全按半开口径，杜绝闭区间尾部 off-by-one。
- **I4 建议是提案，不是决定。** LLM 只提交 drop 区间；keeps、单元划分、最终 cut 全部由代码算出。人工终裁与「恢复全留」随时可用。
- **I5 降级必须可见且不倒退。** 任何失败（LLM 不可用、无 key、校验不过、建议过激）→ 保留全留版进人工门 + 落 `warning` 字段 + 面板出横幅。**V0b 的失败绝不能让已经可用的 V0a 人工路径变成不可用。**

## 2. 方案：一次调用，只提交 drop 区间

v1 曾设计「先重新断句、再粗剪判定」两轮 LLM。**废弃**——只要 LLM 提交的是**词索引区间**而不是 segmentId，重新断句就不需要单独一轮：drop 区间的边界本身就是新的剪辑边界，补集即 keep。

同样否决的替代路线：
- **forced alignment**：适用于「已知正确文稿对齐音频」，而这里恰恰存在重录、改口、跑题、ASR 错词，强行对齐干净稿会把废弃 take 压到错误位置。且已有词级时间戳，再引一套依赖不解决剪辑判断。
- **调 VAD/ASR 参数**：能减少碎片，但拆不开同一 VAD 段内的「好 take 结尾 + 重录开头」，不解决根因。
- **让 LLM 直接输出毫秒**：数字会漂移，时间一律由代码从词索引映射。

### 2.1 词流与单元划分（纯代码，确定性）

1. 把 `transcript.segments[*].words` 按顺序拍平成全局词流，索引 `0..N)`。空 `words` 的分句自然不进流（本例尾部 10 句）。
2. LLM 提交 `drops: [{startWord, endWordExclusive, flag}]`。
3. 代码校验后，**在「drop 区间边界」∪「原 VAD 分句边界」两组切点上切分词流**，得到剪辑单元 `EditUnit[]`。
   - drop 边界保证 AI 的剪切点落在正确位置；
   - 原分句边界保证保留区被切成人能逐条勾的粒度（否则一个 keep 区可能长达一分钟，人没法点选修正）。
4. 每个单元结构与 `TranscriptSegment` 同形（`id/text/startMs/endMs/words`），`text` = 区间内词拼接，`startMs/endMs` = 首末词时间戳。**pipeline 无差别消费**：`buildOutputMap` / `projectWordsToOutput` 拿 `edit-units.segments` 与拿 `transcript.segments` 完全一样。

### 2.2 工具契约

```
submit_rough_cut {
  drops: [{ startWord: int, endWordExclusive: int, flag: "misread"|"repeat"|"offtopic" }]
}
```

代码侧校验（不合格返回错误字符串自纠，`maxTurns 3`）：
- `0 ≤ startWord < endWordExclusive ≤ N`
- 区间互不重叠；排序、去重、相邻合并由代码做，不要求模型有序
- 每个区间恰有一个 flag

### 2.3 防清空：按时长，不按句数

drop 总时长 > **有效语音时长的 50%** → **不应用建议**，落全留版 + `warning: "AI 建议删除超过一半，已保留全留版供人工处理"`。

按时长而非句数：模型可以通过制造长短句操纵句数比例，时长不能被这样操纵。且**不让模型自纠去迎合比例**——迎合比例的自纠会诱导它随便挑几段删来凑数。

### 2.4 scriptCoverage（原 matchedRatio）

字段更名为 `scriptCoverage`，因为它算的是「稿件二元组有多少在口播里出现过」——**集合召回率，不看顺序、不惩罚重复**（`asr.ts:197`）。所以 v1 里「0.499 是重录冗余造成的」这个说法是错的，重复 take 根本不会拉低它。它不是 alignment confidence，不该当 alignment confidence 用。

政策（取代主 spec §4.4 的 `<0.5` 全局否决）：
- **删除全局否决。** `<0.5` 照常给 `repeat` / `misread` 建议——这两类判断的依据是转写内部的重复与断裂，不依赖稿子正确。
- **`<0.5` 时禁止 `offtopic`。** 「跑题」是唯一必须以稿子为准绳的判断，稿音差异大时最容易被错稿带偏。工具层直接拒收 offtopic。
- **UI 显著警示**，并列出实际删除的区间。

### 2.5 前置健康检查（不合格直接跳过 AI 粗剪）

跑 LLM 之前先验词流健康度，任一不过 → 跳过建议、进全留人工门、落 `warning`：
- 词时间戳覆盖率 < 90%（本例 95.7%，通过）
- 词时间戳非单调（存在 `word[i].startMs < word[i-1].endMs`）
- `N == 0`

## 3. 落位：cut phase 获得计算步

`cut: queued → running → awaiting_human`。人工门没有被绕过——门是 `cut/awaiting_human`，只是在门前加了一道计算。

### 3.1 必须同改的代码点（codex 逐条点名，缺一即出错）

| 位置 | 改什么 | 不改会怎样 |
|---|---|---|
| `state-machine.ts` `AUTO_CHAIN_PHASES` | 增 `["transcribe","cut"]` | 迁移被拒 |
| `state-machine.test.ts:46` | 断言只有两对，需同步 | 测试红 |
| `types.ts` `VideoJobPhase` | 增 `"cut"` | 类型不过 |
| `runner.ts` `JOB_PHASES` | 增 `"cut"` | job 开不出来 |
| `runner.ts` `inputKeyFor()` | 单独处理 cut | 落进 transcribe 的 A-roll fallback，inputKey 全错 |
| `runner.ts` `outputRevision()` | 返回 `revisions.cut` | 未知 phase 一律取 `rendered`，记错版本 |
| `phases.ts` `executePhase()` | 增 `case "cut"` | 报 not_runnable |

### 3.2 inputKey 必须含全部输入

```
transcript:<N>+body:<sha256-8>+algo:<promptVersion>+route:<modelRouteHash>
```

只写 `transcript:<N>` 不够：粗剪还消费 `Content.body`、prompt 版本与模型路由。稿子改了而 transcript revision 没变时，旧输入的结果会被当成新结果推进。

### 3.3 产物先落 staging，CAS 成功后再定版本

**这是必须修的崩溃窗口**：现在产物在 CAS 之前写盘。cut job 写出 `cut.v2` 后崩溃 → lease 回收重跑 → 按 state 里的 cut v1 再写 `cut.v2` → 撞上不可覆盖文件 → 永久失败。LLM 非确定性，不能简单覆盖了事。

做法：先写 `edit-units.<jobId>.staging.json` / `cut.<jobId>.staging.json`，settle CAS 成功后再 rename 成正式 revision。

### 3.4 失败语义：需要第三种出口

现在 `StepResult.ok=false` 一律被 runner 结算成 `cut/failed`（`runner.ts:183`），但粗剪失败必须停在 `cut/awaiting_human`（人还能手工选段）。新增：

```ts
| { ok: true; next: VideoStateRef; revisions?: Partial<VideoRevisions>; warning: string }
```

即「跑完了但建议没产出」，状态照常推进到人工门，`warning` 落进 cut/edit-units 供 UI 显示。

配套：`video:retry` 现在只接受 `failed`/`blocked`，无法单独重试建议。增加从 `cut/awaiting_human → cut/queued` 的「重新跑 AI 粗剪」入口；**人工已提交过 human revision 后禁止后台建议覆盖**。

### 3.5 无 key 不阻断

`key_missing` 在本阶段**不得**走 `blocked`。没有引擎配置 → 直接进全留人工门 + `warning: "AI 粗剪未运行（引擎未配置）"`。否则新增 V0b 会把已经可用的 V0a 弄成不可用（I5）。

## 4. 产物

`video/edit-units.v<K>.json`：

```ts
{
  schemaVersion: 1,
  transcriptRevision: number,
  origin: "raw" | "llm",
  segments: TranscriptSegment[],   // 与 transcript.segments 同形状
  suggestedDrops: string[],        // 建议剔除的 unit id
  flags: CutFlag[],
  provenance?: { model, promptVersion, bodyHash, generatedAt },
  warning?: string,
}
```

- `origin: "raw"` = transcript.segments 原样搬运（transcribe 阶段写，作为兜底）
- `origin: "llm"` = 按 drop 区间重分
- 消费方读 `edit-units.vK` 存在则用之，不存在回落 `transcript.segments`（老产物兼容）

`cut.v<M>`：`keeps` = 单元 id 全集减 `suggestedDrops`，`origin: "llm"`，`baseCutRevision: 1`。

## 5. 判定口径（写进 system prompt）

- 同一句说了多遍 → 留最后一遍完整的，其余 `repeat`
- 明显口误、说一半改口、卡壳重来 → `misread`
- 与口播稿主线无关的闲话 → `offtopic`（`scriptCoverage < 0.5` 时禁用）
- **语气词、轻微停顿不剔** —— 那是口播节奏，剔干净会变成播音腔

## 6. 前端

`VideoCutPanel` 已按 `cut.keeps` 预勾、已渲染 flag chip，主体不改。增量：

- 结果条：「AI 粗剪：剔除 N 段 / 共 M 段，预计成片 X 分 Y 秒」
- **「恢复全留」现场计算**当前 edit-units 的全集，**不能钉死 `cut.v1`**——重跑 transcribe 会继续递增 cut revision（`phases.ts:100`），v1 会指向错版本
- 横幅：`warning` 非空时原样显示；`scriptCoverage < 0.5` 时提示逐句复核
- 「重新跑 AI 粗剪」按钮（仅当无 human revision 时可用）
- 恢复全留后 **AI flag 保留为只读证据**，不清除（人需要知道 AI 当时认为哪里有问题）

## 7. 边界清单（验收即按此表）

| # | 边界 | 期望 |
|---|---|---|
| 1 | LLM 超时 / 不调工具 / 无 key | 全留进人工门 + warning，**不 blocked** |
| 2 | drop 区间越界 / 重叠 / 零长度 / 乱序 / 重复 | 工具打回自纠；3 轮仍败按 #1 |
| 3 | drop 总时长 > 有效语音 50% | 不应用，全留 + warning（不让模型自纠凑比例） |
| 4 | drops 为空 | 合法，`origin:"llm"` 全 keep，面板显示「AI 认为无需剔除」 |
| 5 | 词覆盖率 < 90% / 时间戳非单调 / N==0 | 跳过 AI，全留 + warning |
| 6 | 分句 words 为空（本例尾部 10 句） | 不进词流；不崩；其 text 不参与单元 |
| 7 | 运行中 `Content.body` 改动 | inputKey 变化 → 旧结果不得推进（settle 核对输入快照） |
| 8 | 写出 staging 后、settle 前崩溃 | 回收重跑不撞文件；staging 可安全覆盖 |
| 9 | lease 被接管后旧调用返回 | CAS 拒绝，不污染新 job 状态 |
| 10 | 人工已提交 human revision 后 AI 结果迟到 | 拒绝覆盖 |
| 11 | 「恢复全留」在重跑 transcribe 之后 | 现场算全集，指向当前 edit-units |
| 12 | `scriptCoverage < 0.5` 且模型给 offtopic | 工具拒收，要求改用 repeat/misread 或撤回 |
| 13 | 口播内容里含提示注入（"忽略以上指令"） | 转写内容一律当数据；工具层只认索引，不执行文本指令 |
| 14 | LLM 输入超上下文 | 前置按词数估算，超限则跳过 AI + warning |
| 15 | drop 边界落在无停顿处 | 记录切口，V0b 不做 fade（列入 V1 待办，不静默假装无损） |

## 8. 不做

- 不修 `pair_words` 截断与尾部无字幕（§0.1，另行立项）
- 不改 `anchorFilter` 的停顿处理（§0.1，另行立项）
- 不做静音/口癖信号级自动粗剪（主 spec V1）
- 不碰覆盖轨、AI 镜头采购、BGM
- 不做切口 fade / 最近安全间隙吸附（V1）
- runner 的既有隐患中，只修 §3.3 staging 与 §3.2 inputKey；`requeueJob` 未核对 phase、attempts 双计、heartbeat 迟到复活三项**记录在案另行立项**，不在本文范围内扩大改动面
