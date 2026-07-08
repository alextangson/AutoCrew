# SESSION-9 交接：relay 裁决落地（1500-2000 字）+ 孤儿占位稿 reconcile

> 日期：2026-07-08 · 起点 commit `4b1fb7a` · 终点 commit `7983811`（2 个提交 + 本文档）
> 803 单测全过，`npm run smoke` PASS，tsc 干净。
> 一句话：**SESSION-8 的第一优先裁决已出并落地——公众号默认字数 1500-2000，真实生成 82 秒稳定完成，relay 天花板问题关闭；§3.1 孤儿占位稿也修了。生成链不再有已知阻塞。**

---

## 1. 创始人裁决（2026-07-08，本 session 开头）

SESSION-8 §4 三选一（换 provider / 缩字数 / 断点续跑）→ **创始人裁决：字数默认 1500-2000 字**（比交接里建议的 3500-4000 更短）。落点：

- `src/modules/packs/wechat-article.ts`：writerRole、body 规则、platformAdjustments 全部 1500-2000；密度约束等比缩放（案例 3→1、数据引用 5→3、配图标记 4→2、信息增量 3→2），quality gate `5000/5/4 → 1500/3/2`。
- 缘由注释写进 pack 头：改回长文时密度约束要一起调。
- `loop.ts` max_tokens 16000 不动（上限非目标，流式下留余量零成本）。
- 断点续跑（工程根治）没有排期，只是不再是 P0 前提。

**真实生成验证**（隔离 dataDir + 创始人 engine.json，处方来自 SESSION-8 §6.1）：
82 秒完成 / 1734 中文字符 / 2 配图标记 / gate 零失败 / 违禁词零命中 / `draft_ready` / 4243 tokens。旧 5000-6000 字需 ~4 分钟且必被 relay 掐断——**天花板问题就此关闭，别再实测长文**。

## 2. 孤儿占位稿 reconcile（SESSION-8 §3.1，已修）

- `src/desktop/orphan-reconcile.ts` + 4 个测试；`desktop/server.ts` 在 `listen()` **之前** await 执行（先清孤儿再开门，与本进程新生成零竞态）。
- 只认生成占位稿哨兵标题前缀（`content-save` 允许手工稿也存 `drafting`，不能按 status 一刀切）；哨兵已收敛为 `generate-script.ts` 导出常量 `GENERATING_TITLE_PREFIX` / `INTERRUPTED_TITLE_PREFIX`（renderer 的 board/workbench.js 正则同字面量，改动需同步）。
- 标记形状 = 运行时失败路径同形状（中断标题前缀 + `lastError`，status 保持 `drafting`），UI 徽章/横幅/重试按钮零改动生效。
- 不设「N 分钟无更新」门槛：listen 时本进程不可能有活生成；并行 MCP 进程的活稿被误标会在其转正/失败时整体覆盖自愈。全部工作区都扫，事件落各自 events.jsonl。

## 3. 下一步（按优先级）

1. **真实「灵感→发布」全链 dogfood**——生成链已无阻塞，这是创始人从 session-1 就要的第一个采纳率数据点。发布（push_wechat_draft）有确认门且动创始人真实公众号，**应由创始人交互驱动**，不要自主替他发。
2. SESSION-8 §5 的排期项前提未变（第二批 Dashboard 组件、目标卡、发布日历、B 级发布），不要偷跑。
3. **前端 React 化**（frontend v2 契约 A 期）仍排在公众号链 P0 验收后。

## 4. 惯例提醒（继承 SESSION-8，仍然有效）

- 改前端必先 `npm run smoke`；写完自己开浏览器 dogfood 再交付。
- 起 server：`npx tsx desktop/server.ts`；单测 `npx vitest run`（803）；类型 `npx tsc --noEmit`。
- 禁止上云（PRD-v4 §11）。
