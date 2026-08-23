# 视频线可持续复用 · 素材沉淀 / 增量修改 / 成片收尾（终稿）

> 前序：`2026-08-23-editor-workflow-v2.md`（实现中）。**本文实现必须等 v2 落地并闭合 `EditorPlanSource → OverlaySlot fingerprint → assemble verify` 链**（codex 查实 v2 中间态未闭合时开工必撞）。
> 终稿 = 吸收 codex 评审（2026-08-23）。被推翻的初稿决定：保留字标签、确认写 overlays-by-cut、保留全部 WAV、纯前端打回备注、按文件名反登记。

## 0. 诉求 → 裁决

| # | 诉求 | 裁决 |
|---|---|---|
| 1 | 素材收集一次终身复用 | 库素材加显式 `reusable` 布尔（非标签），常备池进全部视频目录（§1） |
| 2 | 改一处不重头剪 | 决策版本模型重做 + 打回分流 + 槽位删改共用派生 + 定位持久化（§2） |
| 3 | 成片确认后清理测试片 | 带所有权与状态机的幂等清理（§3） |

## 1. 常备素材池

- **`LibraryAsset.reusable?: boolean` 显式字段**，不用保留字标签（tags 是整组替换的自由元数据，易误删误触；且库 UI 现在根本没有标签编辑路径）。历史上恰好带"常备"字样标签的素材**不自动升格**。
- **开启 `reusable` 的前置：显式 `description` 非空**。现挂接逻辑拿素材名兜底导致"无说明不可见"形同虚设（codex 查实）——常备池必须是人写过说明的素材。库 UI 提供 reusable 开关 + 说明编辑（顺手补上缺失的说明编辑能力）。
- **入库时 ffprobe 探测并持久化 media**（duration/宽高/fps）到 LibraryAsset——视频候选必须知道时长，不能构目录时同步探。已有存量素材在被纳入常备池时补探。
- 目录构成 = 本稿挂接 broll + 全库 reusable；**按 `sourceLibraryId` 去重，本稿副本优先**；截断预算时先保本稿挂接，被截常备点名。
- plan 引用形态服从 v2 联合：`{kind:"asset", ref:{kind:"library", id}, name, type, durationMs, fingerprint}`——**指纹在进 plan/填槽时快照**，assemble 对快照复检（不是 assemble 自算自证）。`catalogDigest` 纳入 ref+fingerprint+tags+media。
- 引用不复制：同一 logo 百条视频共用一份文件；文件漂移由快照指纹拦截并点名。

## 2. 增量修改

### 2.1 决策版本模型重做（本刀的地基）

现状：确认写 `overlays.v<cutRevision>.json`——cut 不变的二次确认必撞 EEXIST；删到零还不写空数组，旧 overlay 静默复活。改为：

- 确认产物 = 不可变 `editor-decision.v<N>.json`（按 plan revision 派生；**空计划显式写 `overlays: []`**）
- state 增 `confirmedEditorRevision`；assemble 只读 decision，inputKey 含 confirmed revision
- overlays-by-cut 语义废除；timeline/rendered revision 继续单调递增，永不回退
- assemble 的部分提交隐患（timeline 落盘后音频失败 → 重试撞不可覆盖）与 v2 的 reassemble 一并修：timeline/manifest 走 staging 整体提交

### 2.2 打回分流

- 新增回退边 `review/awaiting_human → edit/awaiting_human`（回门二：plan 与决策链原样在，改槽位再确认 → 新 decision revision → 只重走 assemble+render）
- 新增回退边 `edit/awaiting_human → cut/awaiting_human`（门二再回门一）；各配显式 IPC 动作 + 乐观锁，不是只加状态边
- plan 读取/确认校验 `plan.cutRevision === state.revisions.cut`，keeps 变了旧 plan 自然失效

### 2.3 槽位精修共用派生

`video:editor_slot_remove` 与既有 `editor_slot_fill` **共用一个 `deriveEditorPlan(baseRevision, mutation)`**，mutation 分 fill/remove 两型。删+填+整体重跑覆盖"换/删/重来"；手动加槽不做（时间轴编辑器地界）。

### 2.4 打回定位（持久化，非纯前端）

门三打回带 `{target: "edit"|"cut", timestamp?, note?}`，落**不可变 `review-decision.v<renderedRevision>.json`**（同时天然记录"哪版通过/被拒"，给 §3 清理当依据）。定位纯函数：时间戳落 overlay 时段 → 建议回门二并高亮该槽；否则定位覆盖分句 → 建议回门一并高亮。note 显示在目标门横幅，刷新不丢。

### 2.5 显式不做

增量渲染/分段缓存（渲染是算力成本不是决策成本）；BGM-only 音轨重封装 V-next。**「保留 WAV 供重开免重算」的说法撤回**——assemble 现实现每次重建 anchor/master，缓存命中需带输入指纹校验，本期不做。

## 3. 成片收尾：done 时清理（带所有权）

### 3.1 资产所有权（前置）

- `Asset` 增 `managedBy: "video-pipeline"` + `renderedRevision`；`registerFinalAsset` 改幂等 upsert（现在是无条件 append）
- 新增 `removeManagedFinalAsset`：content 写锁内只删所有权与 revision 匹配的登记与文件。**绝不按文件名删**（`removeAsset` 会删所有同名记录连带文件，误伤无防护——codex 查实）
- 历史无所有权字段的 final **不自动删**

### 3.2 清理清单

**删**（按已知命名解析 revision + 核对 approved revision + 所有权，未知文件一律不动，不做宽泛 glob）：
- `preview.v*.mp4` 全部；各形态临时/残留：`*.tmp.mp4`、`*.wav.tmp`、`*.staging.json`、原子写残留 `*.json.tmp-*`
- `final.v*.failed.mp4`；非通过版 `final.v<k>.mp4` + 经 `removeManagedFinalAsset` 反登记
- `asr-input.wav`（transcribe 可重抽）
- **anchor/master WAV：只留通过版 manifest 实际引用的那一份，其余全删**（WAV 才是最大可再生重产物）

**留**：通过版 final（两份）、通过版引用音轨、全部 JSON 决策产物（KB 级，重剪依据）、**A-roll 原片与素材库文件永不触碰**。

### 3.3 执行语义

- state 增 `cleanup: "pending" | "done" | "warning"`：done 落盘即置 pending，清理完成置 done/warning；**启动时对 done+pending 的稿件重试**（进程死在中间不会永远漏清）。操作幂等。
- superseded 的预览 settle 时**主动删除自己的输出**（unlink 只防正在读，不防清理后迟到 rename 复活）。
- 面板一行："已清理测试产物，释放 N MB"。

## 4. 边界清单

| # | 边界 | 期望 |
|---|---|---|
| 1 | reusable 开关打开但 description 空 | 拒绝开启，提示先写说明 |
| 2 | 常备素材文件漂移/被删 | 快照指纹/存在性拦截，点名 |
| 3 | 常备池超截断预算 | 本稿优先，被截点名 |
| 4 | 同一库素材既挂本稿又在常备池 | sourceLibraryId 去重，本稿副本优先 |
| 5 | 库素材改说明后已出的 plan | plan 内是快照不追改，重跑吃新说明 |
| 6 | 回门二删槽至零再确认 | decision 显式 `overlays: []`，纯口播出片，旧 overlay 不复活 |
| 7 | 回门二期间另一窗口也在改 | plan/decision 派生乐观锁，后提交冲突重载 |
| 8 | 定位时间戳落间隙 | 就近分句，不崩 |
| 9 | done 落盘后清理前进程死 | cleanup=pending，启动重试 |
| 10 | 重开后再次 done | 再次清理，幂等 |
| 11 | 手动挂接的同名 final-v1.mp4 | 无所有权标记，不删（3.1） |
| 12 | 清理时预览正被播放 | unlink 语义无碍；superseded 主动删自己输出防复活 |
| 13 | 通过版 final 被人手删后重开 | 决策 JSON 俱在可全链重建，不算数据丢失 |
| 14 | 旧稿（无 cleanup 字段/无所有权 final） | 不回溯清理，只对新 done 生效 |

## 5. 不做

素材自动收集 agent、常备池分类体系、时间轴手动加槽、增量渲染、WAV 缓存命中、BGM 重封装、历史稿件回溯清理。
