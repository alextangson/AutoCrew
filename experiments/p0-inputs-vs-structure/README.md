# P0：多少调研到达写手

对应 `docs/superpowers/specs/2026-09-02-dsh-employees-and-case-files.md` §6 P0。要回答的只有一个问题：**同一个写手模型，AutoCrew 的短视频文案不达标，是因为到达写手的调研太少（输入假设），还是流程本身在拖后腿（结构假设）？** 创作者不提供任何输入——产品预期就是全自动调研出稿。

## 设计：3 × 2 因子

| 流程档 | 是什么 |
|---|---|
| `direct` | 同一条 writer 路由、极简 system prompt、单轮、无工具、无质量门、无人味化。「聊天里直写」的替身 |
| `writer` | AutoCrew 写手轮 + 质量门 + 人味化，审稿轮短路（消融） |
| `pipeline` | AutoCrew 现状全流程：写手 → AI 审稿 → 修订 |

| 调研档 | 是什么 |
|---|---|
| `brief` | 生产现状：`buildBriefBlock` 的 2800 字摘要 |
| `full` | 简报全文（含四视角洞察/证据/缺口，不裁剪）+ **内部语料**：创作者自己的口播转写与人审过的稿子，按选题 bigram 覆盖率挑，转写优先于审定稿，同选题的 AI 旧稿排除（防泄漏）；同选题的**转写**保留并在 meta 里标 `sameTopic`——那是他亲口说的 |

平台固定 `douyin`（口播赛道包）。3 选题 × 6 格 × 2 重复 = 36 稿。

判读：
- 调研档主效应显著、流程档不显著 → 输入假设成立，spec P1 案卷制直上。
- 流程档主效应为负（`pipeline` 系统性低于 `direct`）→ 先修审修环。
- `writer` 高于 `pipeline` → 审稿在伤稿子。
- 内部语料命中的选题（有转写的）比没命中的分差大 → 内部调研这条腿值得单独做。

## 注入口：不改生产代码

`brief` 档什么都不传，让生产代码按 `jobs.jsonl` 指针自己追加 2800 字块，与现状逐字一致。`full` 档把全文经现成的 `ScriptRequest.research` 字段 RAW 注入（`script-prompt.ts` 的「调研材料：」段，无上限），且隔离目录**不带 jobs.jsonl**，生产代码找不到指针就不会再追加摘要块——两档不叠加。`direct` 档把同一份调研文本放进 system prompt。

## 红线：生产 `~/.autocrew` 只读

管线要读的白名单（engine.json、画像、该选题、该选题的简报、patterns、knowledge、sensitive-words、learnings；`brief` 档另拷 jobs.jsonl）拷进 `runs/<topicId>/_data-<research>/`，再用显式 `dataDir` 参数 + `AUTOCREW_DATA_DIR` 两把锁钉住进程（`lib/isolate.ts`）。内部语料从生产目录只读取。管线格写出的占位稿落在隔离目录。

## 跑

```bash
# 先 --mock 冒烟：一次 API 都不发，验证隔离、注入、消融开关、盲评卷
npx tsx experiments/p0-inputs-vs-structure/run-cell.ts --topic <topicId> --cell pipeline --research full --rep 1 --mock
```

真跑（一个选题一条链，幂等、失败重试、开跑前等端点连通）：

```bash
experiments/p0-inputs-vs-structure/run-all.sh <topicId>   # 三个选题各起一条，可并行
```

`--research` 必须显式写。改过生产画像/简报后加 `--refresh-data` 重拷隔离目录。`brief` 档若检测到裸写（指针没生效）直接作废报错。

## 每格留下什么

`runs/<topicId>/<cell>-<research>-rep<n>/`：
- `draft.md` 正文
- `meta.json`：resolved writer 路由、调研文本字符数与 sha256、简报版本、内部语料命中清单（来源/标题/字符数/相关度）与扫描统计、隔离目录缺料清单、token、时长；**每一轮模型调用的完整 system + user**（写手/审稿/修订各一条，含是否被消融短路）；管线格另有 review 结果、gate 失败、是否裸写。盲评分数不一样时，能回答「到底喂了什么」的只有这份。

## 盲评

```bash
npx tsx experiments/p0-inputs-vs-structure/make-blind-sheet.ts [--topic <topicId>] [--seed <n>]
```

所有 `draft.md` 洗牌成 `blind/<topicId>/A.md B.md …`，答案单独在 `blind/key.json`，评分表在 `blind/score-sheet.md`。四维各 1–5：事实性、观点、声音、结构。**先把一个选题下所有稿读完再打分**，打完再开 key。种子固定，字母分配可复现。

`runs/` 与 `blind/` 都在 `.gitignore` 里。

## 第一次真跑记录（2026-09-02 20:44–21:42）

- **模型不是 Claude**：写手/审稿配的中转 `code.newcli.com` 从 17:56 起持续不通（主备端点同一家），创始人裁决切 DeepSeek V4 Pro 跑。只改了隔离目录里六份 `engine.json` 副本（删 `routes.writer/reviewer` 与 `fallback`，落回 `strongModel`），生产配置未动。36 格全部 `deepseek-v4-pro @ api.deepseek.com`，meta.json 里的 `resolvedWriterRoute` 可核。代价：丢掉「与聊天里同一模型」的前提；「多少调研到达写手」这个变量仍然干净。
- 36 格全成。中间三处超时降级（审稿 300s ×2、修订超时 ×1，都在 pipeline 格，稿子用的是最后一版过 gate 的写手稿，meta 有 warning）。
- 客观信号（不是质量分）：`full` 档正文均长 992 vs `brief` 817 中文字符；`pipeline` 与 `writer` 长度几乎相同（1068 vs 1065），`direct` 只有 581。12 格 pipeline 里 9 格审稿 `passed/0 轮修订`（意见全是 advisory）、3 格超时——在这个模型上审稿几乎没改稿，却让 token 翻倍（33k vs 18k）、时长翻倍（486s vs 240s）。
- 内部语料命中：三个选题都拿到两段口播转写（8k 字符）；「DeepSeek Harness」选题的 `full` 直写稿里出现了转写里的原话（「我上次不是给它写了个插件，用手机远程审批家里的电脑吗」），bigram 重合 0.25 vs `brief` 0.22。
- 盲评卷：`blind/score-sheet.md`，每选题 12 稿 A–L，seed 20260902。

## 冒烟记录（2026-09-02）

`--mock` 六格全通：`brief` 档写手 user prompt 里恰有一个 2800 字块、无全文；`full` 档恰有全文 + 内部语料、无 2800 字块（指针刻意不拷；`wroteWithoutBrief` 仍为 false，因为 research 字段算已带材料）；`writer` 档审稿轮 `shortCircuited`；盲评卷生成六个字母；生产 `contents/` 数量前后一致。
