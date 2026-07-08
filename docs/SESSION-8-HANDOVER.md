# SESSION-8 交接：IA v4.2 落地 + 工程健壮性 + relay 天花板定论

> 日期：2026-07-08 · 起点 commit `98fbf49` · 终点 commit `721dae0`（17 个提交）
> 工作树干净，799 单测全过，`npm run smoke` PASS。
> 一句话：**IA v4.2 契约全部可做项 + CTO 级工程健壮性全部落地；唯一未通的是公众号长文生成，卡在 relay（不在我们代码里），需创始人裁决走哪条路。**

---

## 0. 给下一个 session 的三句话

1. **产品已经"能用、不丢东西、看得见"** —— 整条链（定位→灵感→派活→成稿→审改→发布→回填→归因）每一环都有 UI 落点和失败兜底。除长文生成受 relay 制约外，都跑通了。
2. **改前端务必先 `npm run smoke`** —— 它起真浏览器跑 13 项动线 + 1280/1680 双视口布局碰撞 + 零 console 错误。上次布局 bug 就是漏了视觉碰撞检测逃逸的。**写完自己开浏览器 dogfood、修完再交付**是本项目的铁律（创始人明确要求）。
3. **第一优先决策**（创始人的，不是你的）：relay 长文可靠性怎么解（见 §4）。不要在这上面反复烧 token 实测——已定论。

---

## 1. 本 session 做了什么（17 commits，按主题）

### A. IA v4.2 契约实施（Dashboard 经营层 + 个性化闭环）
契约文档：`docs/superpowers/specs/2026-07-08-ia-v4.2-dashboard-first.md`（含两轮 codex 外审记录 §10 + 实施记录 §11）。

- `4623eac` **B2/B3 harness**：声音内核 scope 路由（`voice_core`|`platform:*`，≥2 平台重复纠正→升格）；onboarding gate 活 bug 拆除（PRD-v3:302 点名的存量违规）；`creator-profile.json` 定为唯一风格事实源，STYLE.md 降级为渲染视图。
- `47614db` **A1/A2 灵感入水管**：雷达定位过滤自动入库（含回收站查重）；`save_topic` chat 工具 + `topic:create` 通道 + 「＋新想法」直落灵感卡；派活 brief 携带 Topic 全量上下文（防增值蒸发）。
- `ba0b5c8` **C1/C3 总编辑**：上下文感知（chat:turn 带 view/selected_content）；定位摘要注入 system prompt；push_wechat_draft 确认门（工具零执行）；发布失败原地续跑卡。
- `0a5bff1` **Dashboard 首页 + B5/B6**：待审队列（排序+连续审稿）/回填待办（T+1/T+3）/校准状态/top-3灵感/管线；首跑公众号默认 + 首稿陪跑；rulesApplied 标注 + rewritten 原因 chip。
- `135bee9` **任务动态带 + 会话历史 + A3 对标拆解 + 素材缺口卡 + 菜单收敛**。
- `f5463fc` **回填录入+归因 + 发布窗口标注 + A5 挖角度 + 校准中心定位/席位编辑**。
- `484e49e` **布局 bug 修复**（dashboard 网格与常驻对话栏碰撞，`width:100%` 锁容器）。
- `f447b4b` **失败边界防呆**：生成即占位稿、失败留痕、超时/心跳、中断可见。

### B. 工程质量 / 架构（创始人 CTO 诊断后的清单）
- `9f20f90` **`npm run smoke`**：`scripts/smoke-e2e.mts`，隔离工作区 + 系统 Chrome headless + 原生 CDP（零新依赖）。**提交前必跑**。
- `376f791`+`41b59dd` **统一情报层**：`SourceAdapter` 抽象收编国内 RSS 与海外五源（HN/PH/GitHub/arXiv/HF）进同一注册表，用户可开关；入库过滤从关键词子串升级为 **LLM 语义评分**（`src/modules/radar/relevance.ts`，任意定位成立，引擎不可用回退关键词）；源可配置（设置 UI + 对话 `manage_radar_sources` 工具）。
- `9de838e` **IPC 类型契约**：`src/desktop/channel-contracts.ts` 单一事实源，server 边界统一校验必填字段，守护测试钉死契约表=通道表。
- `40b4929` **生成后台化**：`startGenerateScript` 提交即返回占位稿，写作后台跑，与 HTTP 请求生命周期解耦（契约 P1 工程项完全体）。
- `c2c9a6b` **多工作区**：`src/desktop/workspace-store.ts` 注册表，一人多 IP（Muse + 新号各自独立编辑部）；dataDir 只由 server 端从注册表解析（前端只传 id，防路径注入）；子工作区 engine.json 回退默认区（key 配一次）。`getDataDir` 支持 `AUTOCREW_DATA_DIR` 重定向。
- `a57c25a` **平台席位**：平台全集=能力目录（`PLATFORM_CATALOG` in dom.js 单一事实源），`profile.platforms`=用户席位；首跑多选、写稿矩阵只摊席位+「开通更多」折叠、派活默认第一席位、总编辑注入席位、校准中心席位编辑。
- 6 处散落的 `getDataDir` 私有副本统一收编到 local-store（消灭"改一头忘五头"）。

### C. Dogfood 审查发现并修的真问题
- `17fb7c9` **cover_pending 死角退役**：封面设计师是 P1.5 才转正的员工，`approved` 稿却有通往无工具死状态的「→待封面」按钮，违反 §7.4「不展示未转正员工」。移除唯一入口（保留 enum 给历史数据），封面设计师转正时加回。
- `721dae0` **relay 长文健壮性**（见 §4）。

---

## 2. 当前架构关键事实（下个 session 需要知道）

- **交付形态**：本地 Node server（`desktop/server.ts`，`127.0.0.1:4317` + token）+ 浏览器 dashboard。启动：`npx tsx desktop/server.ts`，打开它打印的带 token 链接。**禁止上云**（护城河=本机浏览器自动化 + 本机发布脚本，PRD-v4 §11）。
- **前端**：vanilla JS（`desktop/renderer/*.js`），无框架，全局函数 + `window.__*` 状态。**这是最大的存量架构债**——frontend v2 契约裁的「Vite+React SPA + 单一 store」尚未执行，排在公众号链 P0 验收后。IPC 类型契约（`channel-contracts.ts`）已为 React 化预铺消费面。
- **引擎**：`src/engine/loop.ts` 薄 loop，双协议（OpenAI `/chat/completions` + Anthropic `/v1/messages`），**现已全流式**（SSE）。57 个 IPC 通道，形状登记在 `channel-contracts.ts`。
- **风格事实源**：`~/.autocrew/creator-profile.json`（`writingRules` 带 scope、`platforms` 席位、`industry` 定位）。STYLE.md 只是人类可读摘要。
- **发布链**：公众号 `wechat_mp_draft` 外壳调 `~/.openclaw/xiaohu-wechat-format/scripts/publish.py`（创始人机器上存在，可用）；发布时自动配封面。其他用户需配置或走原地续跑卡。PRD-v4 §9 列了原生 TS 移植为 P0 复用项（未做）。

---

## 3. 已知问题 / 埋点（不是 bug，是待办）

1. **【中】server 崩溃/被杀 → 占位稿永远卡 `drafting`**：后台生成中途进程死，来不及标失败，稿子停在「生成中」态。**修法**：server 启动时扫 `~/.autocrew/contents/*`，把 `drafting` 且超过 N 分钟无更新的标为中断（`lastError:"server 重启中断"`）。位置：`desktop/server.ts` 的 `server.listen` 回调里加一次性 reconcile。当前无任何启动清理。
2. **【低】前端 vanilla 全局状态**：见 §2，React 化是终局，smoke + IPC 契约在那之前兜底。
3. **【已知】发布链默认脚本路径硬编码创始人 openclaw**：分发时其他用户失败，有续跑卡兜底，PRD-v4 §9 已记原生移植。

---

## 4. ⚠️ 第一优先：relay 长文生成天花板（需创始人裁决）

**现状定论**（dogfood 实测五次 + curl 探测，全部证据在 git log `721dae0` commit body）：
- 公众号长文（5000-6000 字）生成**在 `code.newcli.com/claude/aws` 上无法稳定完成**。失败模式随修复演进：524（边缘超时）→ terminated（中途断流）→ idle timeout（relay 中途静默）。
- **根因不在我们代码**：单次 curl 纯文本流式 58s 成功、工具生成 48-58s 成功；但引擎的完整多轮质量门生成需 ~4 分钟，relay 对 4 分钟长流会中途静默/掐断。
- **harness 已做满**：流式（避 524）+ 分层重试（524/520/522/408/504/terminated/idle-timeout/ECONNRESET）+ **空闲超时中止**（45s 无字节判挂起，非绝对超时，健康长流不误杀）+ 失败不蒸发。最后一次验证：失败在 UI 里优雅可见——看板「⚠生成中断」徽章 + 工作台错误横幅 + 「重新生成」按钮 + 人话错误信息。**从 session 开头「写一半就没了、刷新也没了」到现在「可见可重试」，失败边界彻底做实。**

**三条路（创始人拍板，别自己选）**：
| 方案 | 代价 | 谁定 | 落点 |
|---|---|---|---|
| 换更稳的中转/直连 provider | 资源/成本 | 创始人 | `~/.autocrew/engine.json` 的 baseUrl/key |
| 公众号目标字数 5000-6000 → 3500-4000（每篇 ~2 分钟内完成，稳在 relay 阈值内） | 文章变短 | 创始人（内容深度取舍） | `src/modules/packs/wechat-article.ts:15,42` 两处字数描述 + gate `minChars` |
| 生成断点续跑（分段落盘、可恢复） | 更大工程 | 排期 | 引擎 loop + 内容 store，v3 §5「awaiting_*」红线完全体 |

**别做的事**：不要再反复跑整篇生成验证 relay——已定论，只是烧 token 验运气。

---

## 5. 契约里明确排期在后的项（前提未熟，不要偷跑）

（来自 IA v4.2 契约 §11 + PRD-v4 编制表）
- **第二批 Dashboard 组件**（账号现状/粉丝曲线、对标账号动态、情报源健康度完整版）——硬前提：公众号粉丝/阅读数据摄取通道（现无，扩展只抓抖音）。
- **目标卡 + 总监 L2 按目标排产**——硬前提：文案席位转正（采纳率验收，PRD-v4 §8 排序不动）。
- **发布日历完整版**（P2）、**A4 评论区问题反哺灵感**（P2）、**对标持续监控系统**（情报员转正后）。
- **B 级发布（抖音/小红书表单预填）**——需逐平台过 §6 风控评审，实施排 P2。

---

## 6. 下一个 session 的建议起手（按优先级）

1. **等创始人对 §4 relay 三选一的裁决** —— 这是 P0 链能否验收的前提，一切生成相关都卡在这。若选「缩短字数」，改 `wechat-article.ts` 两处 + gate，然后 `npm run smoke` + 一次真实生成验证即可。
2. **修 §3.1 孤儿占位**（半天，独立，随时可做）—— server 启动 reconcile，让崩溃不留「幽灵生成中」。
3. **relay 解决后，走完一次真实"灵感→发布"全链** —— 这是创始人从 session 开头就想要的第一个采纳率数据点（他明说采纳率靠优化 skills 迭代，但链条本身要能跑通）。
4. **前端 React 化**（大工程，排 P0 验收后）—— frontend v2 契约 A 期，`channel-contracts.ts` 已预铺。

---

## 7. 命令速查
- 起 server：`npx tsx desktop/server.ts` → 开打印的 4317 链接
- 单测：`npx vitest run`（799 passed）
- 冒烟：`npm run smoke`（真浏览器 E2E，提交前必跑）
- 类型：`npx tsc --noEmit`
- 新工作区：应用顶栏「工作区 ▾ → ＋新建」（Muse 用这个开独立编辑部）
