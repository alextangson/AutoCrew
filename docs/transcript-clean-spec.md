# 转写纠错三件套 spec v2（2026-08-25，已吸收 codex 评审）

背景：真机验收（14.2 分钟 A-roll / 307 句）暴露：① VAD 断句切在词中间；② 专有名词
识别错（"deepsick" = DeepSeek）且会烧进成片字幕；③ 选段 UI 看到错字无处下手。
三件套：**热词（防）→ LLM 清洗（治）→ 手工改字（兜底）**，另补「重跑转写」入口死角。

v1 → v2 的改动全部来自 codex 评审（session 01a0379b，4 个 P0）：原子发布、对齐算法
换 LCS、版本追溯链、多重防过拟合闸、补齐漏掉的消费方。评审逐条吸收记录见 §9。

## 0. 总原则（不变）

- `transcript.vN` 是 FunASR 原样事实，永不改写。清洗与手改落派生产物
  `transcript-clean.v<C>.json`，own revision（`revisions.clean`）。
- 不加新 VideoPhase；清洗并进 transcribe job（有先例），但产物发布必须原子（§2）。
- 词的硬不变量：合并词不跨「大停顿」边界（§4）；改词同步重拼 seg.text
  （wordCoverage ≥ 0.9 是 AI 粗剪的开关）；词时间永不新造、保持单调不重叠
  （允许零宽）。
- 标点口径：**标点只进 seg.text，不进 words**。字幕消费 words，今天烧的字幕就没有
  标点；清洗加标点只改善阅读文本，不改变字幕行为——这是显式决定不是疏漏。

## 1. 数据形状与追溯链

```ts
/** transcript-clean.v<C>.json */
interface TranscriptClean {
  schemaVersion: 1;
  transcriptRevision: number;        // 基于哪版 FunASR 事实
  baseCleanRevision: number | null;  // 手改基于哪版 clean（llm 首版为 null）
  origin: "llm" | "human";
  segments: TranscriptSegment[];     // id 前缀 "cseg-"，与 seg-XXXX 区分
  warning?: string;                  // 清洗降级细节，UI 选段卡展示（不塞进 units.warning）
}
```

- `VideoRevisions` 加 `clean?: number`；前端手抄件同步。
- **追溯链**：`VideoCut`、`VideoEditUnits` 各加 `cleanRevision?: number`；
  manifest provenance 加 `cleanRevision`。任何一版字幕都能回答「用的哪版文字」。
- **并发裁决**：clean 的写入走既有「版本化产物不可覆盖」（link+EEXIST）。抢同一个
  revision 号的双写，输者拿 EEXIST → 翻成 `VideoConflictError` → conflict 一等结果。
  不引入新锁。
- cleanup 白名单（KEEP_JSON_BASES 一族）加 `transcript-clean`。

## 2. transcribe 的原子发布 + ASR 缓存（地基，先行）

现状 bug（codex 抓出，先修）：transcribePhase 直写 `transcript.vN` + `cut.vN` +
`edit-units.vN`，写完才由 runner 做状态 CAS。中间崩溃 → 恢复重算同号 → EEXIST 永久
卡死。修法：

- transcribe 的全部产物（transcript / clean / cut / edit-units）改走既有
  `writeStaging`（按 jobId，可自我覆盖）→ runner CAS → `promoteStaging`，与
  cut/assemble 同一纪律。
- **ASR 结果缓存**：ASR 裸输出落 `asr-out.json` + 侧车 meta（A-roll quickHash +
  热词表 hash + asr 参数版本）。transcribe 重跑时 meta 对得上 → 跳过 ASR 只重跑
  清洗。这就是「清洗单独重试」的入口——不加新 phase/job，重试粒度靠缓存解决。
- transcribe inputKey 从 `aroll:<hash>` 扩为
  `aroll:<hash>+body:<sha8>+hot:<热词算法版>+clean:<clean prompt 版>+route:<sha8>`
  （route 口径抄 roughCutInputKey——清洗换模型/端点不该复用旧结果）。

## 3. 热词（sidecar）

- `asr.py` 加可选 `--hotword "<空格分隔>"`，透传 `model.generate(hotword=...)`
  （SeACo-Paraformer 原生支持）。缺省行为不变。docstring 契约同步。
- `sidecars/asr/pyproject.toml` 锁 funasr 版本上界（`funasr>=1.2,<2`）——契约依赖
  具体版本行为，无上界等于赌。
- 提取（TS 纯函数 `extractHotwords`）：从 body 抽拉丁/数字 token
  （`/[A-Za-z][A-Za-z0-9'+-]*/`，长度 ≥2），去重、频次排序、上限 30。body 空 → 不传。
  中文热词 v1 不做（清洗兜底）。
- asr.ts `AsrRequest` 加 `hotwords?: string[]`，拼进 sidecar argv。

## 4. LLM 清洗（transcribe job 内，ASR 之后）

调用骨架抄 rough-cut：`resolveEngineRoute(config,"scout",strongModel)` + `runLoop` +
工具捕获 + 沿 VAD 边界分窗 300–500 词 + 有界并发 3 + 失败窗对半重试一层 + **永不抛错**
（单窗失败原样透传 + warning 点名时间码；全失败 clean=原样+warning；任何失败模式
clean 版都落盘，手改有基）。

窗口工具契约（代码全量校验，非法打回自纠）：

```ts
submit_clean({ groups: Array<{ fromSeg: string; toSeg: string; text: string }> })
// 区间连续、不重叠、恰好覆盖本窗全部分句；上下文段落只读
```

**代码侧应用（全部确定性，纯函数，重测试）**：

- **tokenizer 与 sidecar 逐字节同口径**：TS 移植 asr.py 的
  `WORD_UNIT_RE = /[A-Za-z0-9']+|[^\s\W_]/u`（一个汉字或一串拉丁数字为一词，标点
  空白不占词）。用同一组样本串做双侧契约测试锁死。
- **对齐 = 词级 LCS diff**（不是前后缀锚定——一句两处纠错时锚定会把中间整段正确词
  重分时间）：对 norm 后 token 序列做 LCS，匹配词原样保留时间；每个 unmatched run
  **局部**重分——新 token 按原 run 的时间跨度比例分配（拉丁按字符数加权、CJK 按字数），
  取整后 clamp 保单调，允许零宽词。时间永不越出 run 的原跨度。
- **合并只许跨小停顿**：group 跨多个原分句时，相邻分句间 gap > 500ms 的合并被代码
  拒绝（拆回两个 cseg，各自应用文本）——outputMap 按段边界取源区间，吞大停顿会把
  静音算进成片、改变片长。500ms 设常量并写注释。
- **防过拟合多重闸**（任何一条超限 → 该 group 弃改原样透传 + warning）：
  - norm 编辑距离：短文本（≤12 词）按绝对数 ≤ ⌈词数/3⌉；长文本按比例 ≤ 30%
    （分母 = max(原, 新) 长度，显式写死）；
  - 长度变化 |Δ| ≤ 30%；
  - group 跨度 ≤ 6 个原分句（防模型扩大 group 稀释比例）。
  - prompt 纪律：只修同音/近音错认与断句，不改语序不改措辞——临场改口不是错字。
- 已知限制（写进代码注释）：恰好落在窗口边界的跨窗断句修不到（窗口沿 VAD 边界切）。
  v1 接受；真机验证后若高频再做窗口重叠。

## 5. 消费口径：一个访问器管到底

新增 `readEffectiveTranscript(dir, revisions)` → `clean.segments ?? transcript.segments`
（形状仍是 VideoTranscript）。**替换全部读点**（codex 点名的漏项全在内）：

- `writeDefaultCut` / cutPhase 喂 `runRoughCut` 的 segments
- `cut-gate.requireCut` 的无 units 回退、`loadKeeps`、assemble 历史回退
- `preview-exec` 的 source/fallback、`review-gate`（review-locate）的 fallback
- `video:transcript_get` 给前端的数据（另附 clean.warning 单独字段）

**预览过期防线**：cut-preview request 记录 cleanRevision；渲染完成落盘前校验
clean/cut revision 未变，变了丢弃产物（迟到的旧预览不许冒充新字幕）。

## 6. 手工改字（选段 UI）

- 交互：行内编辑（AngleCards 模式），**编辑控件拆出 `<label>` 包裹结构**（否则点
  按钮顺带切 checkbox——codex 抓的 DOM 坑）。只改文本；空文本/超 500 字拒。
- 新 channel `video:transcript_text_edit`（五件套注册）：

```
payload: { content_id, unit_id, text,
           base_transcript_revision, base_clean_revision, base_cut_revision }
```

- 后端 gate（形状抄 cut_confirm）：
  1. phase 必须 `cut/awaiting_human`；
  2. 三 base 对不上 → conflict（EEXIST 兜底并发）；
  3. **unit → 词区间 → 所属 cseg 拼接**：unit 是 cseg 的子区间（切分保证不跨界）。
     对该 unit 的词序列跑同一个 LCS 对齐（复用 §4 纯函数），把结果拼回 cseg 的完整
     词序列，重拼 cseg.text。一个 cseg 含多个 unit 时只动目标 unit 的区间；
  4. 写 `clean.v<C+1>`（origin:"human"，baseCleanRevision=C）；bump cut：keeps/
     flags/origin 原样携带，units 同号重出（词文本变、结构与 id 不变）；
  5. emit → SSE → revision 驱动刷新。
- **前端勾选保留 = dirty-delta**：本地记录用户显式 toggle 过的 `{id: bool}` 增量，
  新基线到达后把增量套在新 keeps 上（「求并」会把刚取消的勾选加回来，不用）。
  文本 edit 不改结构，增量全部可应用。

## 7. 重跑转写入口

- `video:transcribe_rerun`（形状抄 rough_cut_rerun）：仅 `cut/awaiting_human` 可用，
  置 `transcribe/queued`。状态机 `PHASE_REGRESSION_EDGES` 加唯一一条 `cut → transcribe`。
- ASR 缓存（§2）让「稿子没变、只改了清洗口径/热词」的重跑跳过 ASR。
- **失效清单**（codex 点名，逐项处理）：重跑成功 promotion 时——门内预览请求作废
  （新 revision 校验天然拦截迟到产物）；旧 review-locate 指针容忍 id 失配（定位不到
  → 不高亮，不崩，测试锁住）；手改 clean 不迁移（事实换了，UI 按钮提示写明）。
- unit id 会跨代复用（unit-0001）——所有按 id 的消费必须同时校验 revision，已有
  editor_decision_stale 先例，review-locate 补同款校验。

## 8. 边界五问（product-sense）

1. **状态**：清洗成功｜部分窗失败（透传+warning）｜全失败（clean=原样+warning）｜
   body 空（跳过清洗与热词）｜历史稿件无 clean（访问器回落）｜手改 busy｜conflict｜
   ASR 缓存命中/未命中。
2. **最坏输入**：空转写；转写与稿子无关（多重闸+prompt 纪律）；手改空/超长（拒）；
   纯标点 emoji（token 数 0 → 拒）；LLM 非法区间（打回自纠，3 轮丢窗）；token 数
   多于可用毫秒（零宽词，保单调）。
3. **防呆**：双击保存（busy）；双 tab（三 base+EEXIST）；改字撞上后台重跑（conflict）；
   重跑转写按钮明示作废选段与手改。
4. **失败可见**：清洗降级 warning 冒到选段卡（独立字段，不覆盖 units.warning）；
   sidecar 参数错 → 退出码 2 → failed 可重试；迟到预览被丢弃时记日志；绝无静默 catch。
5. **明确不做**：跨大停顿合并（>500ms）；跨窗边界断句修复；时间码编辑；行级拆分
   手改；中文热词；重跑后迁移手改；已过审片子追改（走打回）。
   **具名边界（跨进程限定）**：手改的三写不在状态事务内。同进程由 service 串行化
   闭环；跨进程错峰下「clean 写成、cut 号被抢」已由孤儿回删收敛为普通 conflict
   （有测试锁住），「三写全成、后台 settle 以 rename 覆盖 units/cut」仍存在——
   桌面应用今天单进程跑 runner，此边不可达；未来若引入多进程 runner，需把手改
   产物并入 staging+CAS 事务。

## 9. codex 评审吸收记录（P0 → 决策）

| 评审点 | 决策 |
|---|---|
| 产物发布不原子/EEXIST 卡死 | 接受：四产物走 staging+CAS+promotion（§2） |
| 清洗失败重试重跑 ASR | 接受：ASR 缓存按 (指纹+热词) 键控（§2），不加新 phase |
| inputKey 缺 route/热词版本 | 接受（§2） |
| 前后缀锚定不成立 | 接受：LCS + 逐 run 局部重分（§4） |
| tokenizer 口径 | 接受：移植 WORD_UNIT_RE + 双侧契约测试（§4） |
| 标点不进字幕 | 接受为显式决定：标点只进 text（§0） |
| 吞 VAD 静音改片长 | 接受：gap>500ms 拒绝合并（§4） |
| 40% 单闸 | 接受：绝对数/比例/长度/跨度多重闸（§4） |
| clean 无 parent/追溯 | 接受：baseCleanRevision + cut/units/manifest 记 cleanRevision（§1） |
| 勾选求并错误 | 接受：dirty-delta（§6） |
| label 包裹 DOM 坑 | 接受（§6） |
| 漏掉的回退读点 | 接受:统一访问器替换（§5） |
| 迟到预览冒充 | 接受：落盘前 revision 校验（§5） |
| unit id 跨代复用 | 接受：按 id 消费必须校验 revision（§7） |
| cleanup 白名单 | 接受（§1） |
| funasr 无上界 | 接受：锁 <2（§3） |
| 独立 phase 建议 | 部分接受：不加 phase，用 ASR 缓存达成同等重试粒度（§2） |

## 10. 实施顺序（依赖驱动，codex 修正后）

1. **地基**：§1 数据形状/追溯链 + §2 原子发布/ASR 缓存/inputKey + §5 访问器与全部
   读点替换 + cleanup 白名单 + 预览校验。
2. **热词**（与 1 并行，不碰 phases.ts 装配）：§3 sidecar + asr.ts + 提取函数。
3. **清洗**（依赖 1）：§4 全套 + transcribePhase 装配（含热词接线）+ §7 重跑入口。
4. **手改 UI**（依赖 1、3）：§6 channel/gate/前端。

验收 = §8 每条有证据（测试/输出/操作记录）+ 全量 vitest + tsc + 历史稿件回归。
