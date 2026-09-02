# P0：输入贫瘠还是流程缺陷

对应 `docs/superpowers/specs/2026-09-02-dsh-employees-and-case-files.md` §6 P0。要回答的只有一个问题：**同一个写手模型，AutoCrew 写得比聊天里直写差，是因为没给料（输入假设），还是流程本身在拖后腿（结构假设）？**

## 设计：2×2 + 一格消融

| 格 | 是什么 |
|---|---|
| `direct` | 同一条 writer 路由、极简 system prompt、单轮、无工具、无质量门、无去 AI 味 |
| `pipeline` | AutoCrew 现状全流程：写手 → AI 审稿 → 修订，含质量门与人味化 |
| `pipeline-noreview` | 消融：只跑写手，审稿轮短路（不发请求，`review.status = skipped`） |

每格 × {`nofacts`, `facts`}。事实包是你为该选题**口述的第一手材料**（`facts/_template.md` 有六节提纲），两侧走同一个注入口：`direct` 拼进 system prompt，`pipeline` 走现成的 `ScriptRequest.research` 字段——**不改生产代码**。

判读：
- 事实包主效应显著、流程主效应不显著 → 输入假设成立，spec P1 案卷制直上。
- 流程主效应为负（`pipeline` 系统性低于 `direct`）→ 先修审修环，再谈案卷。
- `pipeline-noreview` 高于 `pipeline` → 审稿在伤稿子。

## 红线：生产 `~/.autocrew` 只读

跑格前把管线要读的白名单（engine.json、画像、该选题、该选题的简报、jobs.jsonl、patterns、knowledge、sensitive-words、learnings）拷进 `runs/<topicId>/_data/`，再用显式 `dataDir` 参数 + `AUTOCREW_DATA_DIR` 两把锁把进程钉在那儿（`lib/isolate.ts`）。管线格写出的占位稿落在隔离目录，生产库一个字节不动。

## 跑

```bash
# 先 --mock 冒烟：一次 API 都不发，验证隔离、注入、消融开关、盲评卷
npx tsx experiments/p0-inputs-vs-structure/run-cell.ts --topic <topicId> --cell pipeline --facts none --rep 1 --mock
```

真跑（3 选题 × 5 格 × 2 重复 = 30 次）：

```bash
T=<topicId>; F=experiments/p0-inputs-vs-structure/facts/$T.md
for rep in 1 2; do
  for cell in direct pipeline pipeline-noreview; do
    npx tsx experiments/p0-inputs-vs-structure/run-cell.ts --topic $T --cell $cell --facts none --rep $rep
    npx tsx experiments/p0-inputs-vs-structure/run-cell.ts --topic $T --cell $cell --facts $F   --rep $rep
  done
done
```

`--facts` 必须显式写 `none` 或路径，不许靠省略；空事实包直接报错（空文件跑出来的 facts 格是假对照）。改过生产画像/简报后加 `--refresh-data` 重拷隔离目录。

## 每格留下什么

`runs/<topicId>/<cell>-<facts|nofacts>-rep<n>/`：
- `draft.md` 正文
- `meta.json`：resolved writer 路由（baseUrl/model/protocol）、事实包 sha256、隔离目录缺料清单、token、时长；**每一轮模型调用的完整 system + user**（写手/审稿/修订各一条，含是否被消融短路）；管线格另有 review 结果、gate 失败、是否无简报/无角度裸写。盲评分数不一样时，能回答「到底喂了什么」的只有这份。

## 盲评

```bash
npx tsx experiments/p0-inputs-vs-structure/make-blind-sheet.ts [--topic <topicId>] [--seed <n>]
```

把所有 `draft.md` 洗牌成 `blind/<topicId>/A.md B.md …`，答案单独在 `blind/key.json`，评分表在 `blind/score-sheet.md`。四维各 1–5：事实性（只有当事人才知道的具体事实）、观点（能被反驳的主张）、声音（像不像本人）、结构（钩子—论证—收尾）。**先把一个选题下所有稿读完再打分**，打完再开 key。种子固定，字母分配可复现。

`runs/` 与 `blind/` 都在 `.gitignore` 里：含模型输出与答案，不进仓库。

## 冒烟记录（2026-09-02）

`--mock` 走通 4 格：事实包文本出现在写手 user prompt；`pipeline-noreview` 的审稿轮标 `shortCircuited`、`review.status = skipped`；盲评卷生成 A–D；生产 `contents/` 数量前后一致。真跑等创始人选定三个选题并写事实包。
