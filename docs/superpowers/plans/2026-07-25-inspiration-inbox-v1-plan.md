# 收件箱 V1.0 实现计划

Spec：`docs/superpowers/specs/2026-07-25-inspiration-inbox-design.md`（v2，已过 codex 30 条评审）
分支：`claude/autocrew-dynamic-workflow-automation-211a38`（worktree）
范围：仅 V1.0——TG 通道 + 通用网页抓取 + 分流 + 拆解卡 + 单点注入 + 收件箱视图 + doctor。X/TikHub 解析器（V1.1）与扩展右键（V1.5）不在本计划。

## 工作流与文件版图

| # | 工作流 | 新增/修改 | 要点（spec 章节） |
|---|---|---|---|
| A1 | inbox 队列与状态机 | `src/modules/inbox/inbox-store.ts`、`url-canonical.ts`、`inbox-worker.ts` | 四态+lease+单 worker 串行+checkpoint；canonicalUrl 幂等（§3.1） |
| A2 | 加固抓取 | `src/modules/inbox/fetch-external.ts` | SSRF 拦私网+每跳复检+流式 2MB+Content-Type 白名单（§3.2） |
| A3 | 拆解卡库 | `src/modules/patterns/pattern-store.ts` | 墓碑/revision/latest-wins；三库查重接口（§3.5） |
| A4 | 配置面 | `src/desktop/settings.ts`（改） | 全局 `~/.autocrew/inbox.json`，token 掩码，botId/targetWorkspaceId/proxyUrl（§2.1） |
| B1 | TG polling worker | `src/modules/inbox/telegram-poller.ts`；`package.json` +undici | offset 先持久化后推进；401/409/429/退避/优雅停机；回执与白名单（§2.1） |
| B2 | LLM 分流 | `src/modules/inbox/triage.ts` | submit_inbox_verdict 条件 schema+修复轮+无副作用工具（§3.3） |
| B3 | 单条 intake 门 | `src/modules/radar/intake-gate.ts`（抽取）；radar-intake 改造 | 无降级、无批量上限；radar 批量路径改用同门（§3.4） |
| B4 | 消化编排 | `inbox-worker.ts` 串起 解析→抓取→分流→双落库 | stage checkpoint、both 原子性、回执触发（§3.1/§3.3） |
| C1 | 写稿注入 | `src/modules/writing/script-prompt.ts`（改）、选卡器 | 平台+主题相关性、上限 3、定界块、usedPatternIds（§3.5） |
| C2 | 工作台 | `src/desktop/channels.ts`、`channel-contracts.ts`、handlers、`frontend/src/views/Inbox.tsx` 等 | §4 全清单：8 个 IPC 通道+SSE `inbox:updated` |
| C3 | doctor | doctor 模块（改） | worker 心跳/最老 pending/401·409；不带外 getUpdates（§4） |

## 依赖序
A1‖A2‖A3‖A4（并行）→ B1‖B2‖B3（并行，依赖 A 的契约）→ B4（集成）→ C1‖C2‖C3（并行）→ 验收。

## 测试策略
- 每个 store/util 配 vitest 单测；worker/poller 用**本地假 TG HTTP server** 做集成（offset 纪律、409/429、崩溃恢复用 lease 过期模拟）。
- SSRF 用可控 DNS/重定向假服务验证拦截矩阵。
- LLM 分流只测 schema 校验与修复轮路径（引擎打桩），**不对非确定性文本做精确断言**。
- 验收映射（spec §5）：用例 3/4/5/8/10/11 全自动化；1/2/6/7/9 半自动化（打桩层面）；**真 TG 冒烟需创始人 bot token，留作交付后一步**。

## 纪律
- 子代理实现、主循环验收；文件 <500 行、函数 <50 行；不提交——集成验证后由主循环统一 commit。
- 外部调用失败一律可见状态，不静默降级（spec §3.1 三态语义是验收项）。
