# 判断要对账 — 规格 v2（对标 cheat-on-content）

2026-10-03。创始人裁定：五项都做，**尽量对标 cheat-on-content（MIT）的方法论，它已被验证过**。本版取代 v1 的简化方案（v1 的「三档预测」作废，改用它的 5 档 bucket + 概率分布）。

**对标原则**：机制、门槛、常数、文件分工照搬 cheat-on；只在两处改：
- 落地形态：它是 markdown 文件 + hook，我们是 AutoCrew 的数据目录 + 代码校验（不可改由代码保证，比 hook 更硬）；
- 宿主约束：AutoCrew 自带、不依赖创始人机器上的脚本；跨模型审计走 AutoCrew 已配置的另一条模型线路。

**源文件**（实现时逐条对照读，路径在 `~/.cache/autocrew-yt/ext/cheat-on-content/`）：
- `shared-references/blind-prediction-protocol.md`、`prediction-anatomy.md`、`bump-validation-protocol.md`、`observation-lifecycle.md`、`state-management.md`（confidence 派生表、bucket 派生）
- `skills/cheat-predict`、`cheat-score-blind`、`cheat-retro`、`cheat-bump`、`cheat-learn-from`
- `starter-rubrics/opinion-video.md`（v2 已校准）、`opinion-video-zero.md`

能复用的 AutoCrew 现有件：数据回流 `outcomes.jsonl` + 待复核过滤 `reviewedRow`（`src/modules/insights/metric-review.ts`）；同龄期基线 `src/modules/flywheel/metrics-window.ts`；写作规则状态与证据（`src/modules/profile/creator-profile.ts`）；本机转写 `src/modules/video/asr.ts`；模型调用 `src/engine/`。

---

## 一、评分表（rubric）——三份文件分工照搬

| cheat-on | AutoCrew 数据目录 | 谁能读 |
|---|---|---|
| `rubric_notes.md` | `calibration/rubric.json`：当前版本号、完整公式、维度定义与 0/3/5 锚点、观察区（只放抽象规则） | **盲评通道白名单**：不得含任何样本名、实绩、评论、链接、播放数 |
| `rubric-memo.md` | `calibration/rubric-memo.jsonl`：每次升级的 memo（触发观察、证据数据、新公式、已知局限）、被拒升级 log | 主通道、审计通道；盲评通道不可读 |
| `.cheat-state.json` | `calibration/state.json`：rubric_version、calibration_samples、baseline（按平台）、last_bump、in_progress、last_prediction_self_scored | 代码 |

**起步 rubric**：用 cheat-on 的观点视频 v2 公式（7 维：ER×1.5、SR×1.5、HP×1.5、QL、NA、AB、SAT，/8.5×2.0，0–10 分），维度定义用我们的话重写、例子换成自家场景；v2.1 候选维度 MS（模因可挪用）、TS（议题分享冲动）照它的规矩只「试评分」、不进综合分，攒证据等升级。`rubric_form_mismatch` 按内容形态标记（口播 = 观点视频，匹配；长文 = 借用，标 mismatch）。

## 二、盲预测（cheat-predict + cheat-score-blind）

**三通道照搬**：
- A 主通道 = 宿主模型（看得到全部上下文）；
- B 盲评通道 = AutoCrew 后台起一次独立模型调用，**代码层面只喂稿子全文 + rubric.json**，拿不到 state、预测、复盘、回流数据；输出严格 JSON：每维 {分数 0–5, 置信度, 一句理由}；
- C 跨模型审计 = 只在升级（第四节）终局调一次，走与 B 不同的模型线路。

**预测记录 7 组件**（`calibration/predictions.jsonl`，append-only，按 `prediction-anatomy.md`）：
1. 头：稿件 id、标题、平台、rubric 版本、预测时间、稿件指纹、calibration_samples、Confidence、Prediction Basis（发布前 / 拍后改稿重判）、Scored By、BlindScored By、**BlindScore Disagreement（每维都记，delta=0 也记）**、User Override、预测时数据状态 = blind；
2. 输入快照；
3. **预测主体（不可改）**：bucket（5 档之一）、内心概率分布（合计 100%）、中枢点估计、一句话理由；
4. 推理因素表（因素 / 方向 / 置信度高中低 / 说明）；
5. 锚点对比（composite ±0.5 的 2–4 个旧样本及实绩；不够就写 N/A 段并说明）；
6. 反事实场景（每个 bucket 落在这里意味着什么）；
7. 关键校准假设（这次赌什么、什么结果证明什么）。

**bucket 派生**照 `state-management.md`：有本平台基线播放（中位数）→ 按倍数切 5 档；没有 → 平台通用默认；样本 ≥10 → 重算基线。冷启动期概率分布要更平。

**Confidence 派生表**照搬（calibration_samples 0 = 🔴 极低，1–2 🟠，3–5 🟡，6–10 🟢 中，11–20 🟢 较高，21+ 🔵 高），只由样本数决定。

**分歧裁定**：A 与 B 某维差 ≥ 阈值（照 cheat-predict 的 DISAGREEMENT_THRESHOLD）→ 摆给创始人选：信盲评 / 信主通道 / 自己给分，记进 `user_decision`。

**盲度检查**（BLIND_CHECK=strict）：
- 已发布超过 RETRO_WINDOW_DAYS（3 天）或对话里已出现这条的任何数据 → 拒绝预测，改记「Reconstructed retrospective」，不进校准池；
- 已发布但 <3 天且没看过数据 → 允许，标 `published_before_prediction`。

**不可改**：预测主体写入后代码拒绝任何修改；要重做只能新开 `_redo` 记录（原记录保留）；笔误只能在复盘段追加「修正」。

**触发点**：交发布包（`video_kit`）时提示先预测；没走盲评通道（`--skip-blind`）的记 `last_prediction_self_scored`，晨报持续提醒。

## 三、复盘（cheat-retro）

- 窗口：RETRO_WINDOW_DAYS = 3（T+3d 主复盘），D+7 追加一次读数；不到 3 天强行复盘标 `early_retro`，升级时降权。
- 数据从回流取（剔除待复核指标）；缺数据如实写，提示去开回流或手填，不编。
- 只追加复盘段：实绩、落在哪个 bucket / 相对中枢偏多少、哪些推理因素被验证 / 推翻、反事实场景里哪条应验、关键校准假设结论、新观察。
- 写复盘前缓存预测主体指纹，写完复核；不一致 → 追加 Integrity warning，该样本降为「参考」，不进校准池。
- 新观察进 rubric-memo 的观察区（按第五节生命周期），**不写进 rubric.json 的盲评白名单**。
- calibration_samples +1（完整复盘、非 reconstructed、无 integrity warning 才算）。
- 系统性偏差：连续 3 次同方向（或 1–2 次 ≥10 倍偏差）→ 提示可以提议升级。

## 四、升级（cheat-bump，规格原 ②）

**5 步，不许跳**：
1. 写出新公式完整方程（所有系数和归一化常数）；
2. 在校准池上全量重算 composite（维度分不变；新增维度要对每个老样本补打分，**补打分走盲评通道**）；
3. 排序一致性：Spearman + 逐对不倒序检查，阈值 4/5 = 80%，不能把旧公式排对的任一对排反；输出对照表；
4. 跨模型审计（C 通道）：把新旧公式、全部样本维度分 / composite / 实绩、对照表交给另一条模型线路，要求 PASS / REJECT + ≥100 字理由；**本地和审计两个都过才放行**，冲突视为 REJECT；
5. 清算：更新版本号与速查；memo 写进 rubric-memo；删除被吸收 / 被推翻的观察，未解决的移到「待验证假设」；每个校准样本追加一行「Re-scored under vN」。

**禁止提议**：有进行中的预测；上次升级后没有新校准样本。**软约束**（可打破但须显式写明理由，且仍走完 5 步）：校准池 <5、距上次升级 <3 条新样本。提议时标明是 default-aligned 还是 judgment-driven。

**被拒处理**照搬：不许放宽阈值；审计理由完整记进被拒 log；清算不了就回滚。

**同一套门用于**：标题方法库的留 / 删 / 改（试用期中期报告只能是 judgment-driven，终版才可能过门）；写作规则因数据而改（第五节）。

## 五、观察生命周期（规格原 ③）

照 `observation-lifecycle.md`：观察记录 → 跨视频观察（≥2 样本）→ 待验证假设（单样本强信号暂存）→ 规律沉淀 / 吸收为维度（走升级）/ 被推翻 → 删除。「工作台不是博物馆」：被吸收、被推翻的都删，留墓碑防重提。

- 复盘产出的观察默认进「观察记录」，不直接变写作规则；
- 写作规则清单只放已沉淀的和创始人明确批准的；
- 每 10 条新校准样本提示一次清算；
- 创始人原话定的规则不被数据自动删，只提示冲突由创始人裁定。

## 六、对标导入（cheat-learn-from，规格原 ④）

照它的 Phase 0–7：
- 常数：MIN_SAMPLES=3、推荐 5–10、MAX_SAMPLES_PER_RUN=15；
- Way a（默认）：创始人粘稿子文本 + 数据；Way b：把视频放进资料库指定文件夹，本机 FunASR 转写；
- 每条样本问创始人「印象判断」：高 / 中 / 低 + 为什么；
- 宿主模型拆套路 + 派生 rubric 信号 → 创始人过目 → 落盘：每个对标账号一份对标笔记、一份句式模式库（`script_patterns`），rubric 信号作为观察进 rubric-memo（不直接改公式）；
- 冷启动时对标是早期锚点；calibration_samples ≥10 后影响自然减弱，笔记不删。
- 边界：少于 3 条拒绝；转写未就绪按现有指引提示；单条失败其余照做并列出；对标原话不进证据台账、不能当事实引用；不抓平台、不用付费接口。

## 七、转发尴尬尺子（规格原 ⑤）

即 v2.1 候选维度 TS（议题分享冲动）：每次预测时试评分、不进综合分；同时写进选题会判据和受众审提示（只提醒不扣分）。攒够证据后走第四节升级决定是否转正。

---

## 实施顺序

1 评分表与状态 → 2 盲预测 → 3 复盘 → 4 升级门（并接到标题试用期）→ 5 观察生命周期 → 6 对标导入 → 7 TS 尺子。每步单独提交。

> 实施备注（2026-10-03）：本分支 `feature/cheat-on-calibration` 只做通用升级门（`src/modules/calibration/rank-gate.ts` 排序门 + `audit.ts` 跨模型审计，只认 {id, 旧分, 新分, 实绩}）。**标题试用期的接线等本分支与 dbskill 分支（标题方法库 / 审稿规则）都并入 main 之后再做**，两条分支保持独立、可各自回滚。

## 创始人裁定（2026-10-03）

- 尽量对标 cheat-on，方法论已被验证；
- 预测由宿主模型填、盲评通道对照、创始人过目；
- 每个对标账号一份笔记；
- 每 10 条新数据提示一次清算；
- 各节边界即验收清单。
- 回流：本机没有开关记录（`metrics-pull.json` 不存在，最后自动数据 2026-09-26），复盘缺数据时如实提示。

## 创始人裁定（v2 补充，2026-10-03）

1. 起步 rubric 用 cheat-on 观点视频 v2（已校准权重）。
2. 盲评通道 B 走主线路快模型（Claude Sonnet）；审计通道 C 走已配置的 DeepSeek 线路。
