# 三平台视频数据自动回流 Spec

> 状态：v2（已吸收 codex 评审 33 条，处置见附录）· 2026-08-23
> 目标：抖音 / 视频号 / 小红书 三平台创作者后台的视频数据，定期自动抓取、绑定内容 id、落盘时序，喂给复盘做「提假设 → 验证」的迭代闭环。

## 0. 背景与问题

创始人正式开始更新视频。当前两个阻塞：

1. **管线推不到「已发布」**。路径存在但断了三处（见 §1 诊断），导致 `status: "published"` 的稿件几乎不存在——而回流绑定 `matchDraft` 的候选池硬过滤 `status === "published"`（`outcome-store.ts:172-174`），没有已发布稿，抓回来的数据全部沦为无主历史行。
2. **回流靠人工**。现有链路是 CSV 手动导出/粘贴 + 公众号一条自动通道（`wechat-pull.ts`），三大视频平台零自动化。

平台调研结论（2026-08，来源见调研记录）：三平台对个人创作者**均无官方数据 API**。社区通行做法统一是**带登录态直调创作者后台内部 JSON 接口**。差异：

| 平台 | 登录态 | 接口形态 | 风控 |
|---|---|---|---|
| 抖音 | 扫码，社区经验数周 | `creator.douyin.com/janus/...` JSON | 社区经验：过频易触发验证码 |
| 视频号 | 扫码，社区经验约 24h | `channels.weixin.qq.com/cgi-bin/mmfinderassistant-bin/...` JSON | 低-中，但登录态最短 |
| 小红书 | 扫码，社区经验数周+ | `creator.xiaohongshu.com/api/galaxy/...` JSON，**大概率需页面内 x-s 签名** | 高：过频 461/471 验证码、封 IP |

> 上表的时效与频率数字全部是**社区经验值，未经本仓验证**，只用作保守默认配置的依据，不写进产品承诺（codex #24）。接口细节（URL/参数/响应 schema/签名）在 P1b 各平台 spike 中以真实抓包定案（codex #1/#2）。

## 1. 现状诊断（发布闭环断点）

| # | 断点 | 位置 |
|---|---|---|
| D1 | 「我已发布，确认」按钮锁在 `{clip && ...}` 分支——只有点过「排版发布文案」才可见；推公众号草稿箱、或任何不走 clipboard 的路径，按钮不在屏幕上 | `frontend/src/views/EditorTools.tsx:177,194-200` |
| D2 | GUI 确认发布不传 `publish_url`，后端恒写 null；前端 `Content` 类型无 `publishUrl` 字段，不能填也不能显示 | `EditorTools.tsx:196`、`frontend/src/lib.ts:78-95`、`src/tools/publish.ts:101` |
| D3 | 视频线终点不接发布线：审片确认只盖 `videoReadyAt`，不动 `content.status`，成片就绪的卡停在原列，无入口引导进入发布流程 | `src/desktop/video-handlers.ts:260-292` |
| D4 | 双账：编辑器「记录回流」与 CSV 导入都写 `outcomes.jsonl`（GUI 写入路径存在：`EditorTools.tsx:205` → `flywheel:record`），但工作台「回填待办」判据读的是另一个字段 `performanceData`——两边永不相遇，待办永远不消失 | `src/desktop/dashboard-summary.ts:115-127` |

## 2. 总体架构

```
发布闭环(P0)                自动抓取(P1)                       消费(P2)
─────────────              ────────────────────────           ─────────────
人工发布(clipboard)         metrics-pull-cycle (30min tick)
  → GUI 确认已发布            → 每平台 TTL 门 + 退避状态机
    +贴平台链接               → chrome-cdp 常驻实例
  → status=published           origin 内带登录态 fetch          聚合层(增量/龄期/cohort)
    +publishUrl                后台内部 JSON 接口                 → retro 周/月复盘
                             → TypedRow[]（含平台作品id）          → 代码算裁决,LLM 解释
                             → 批量写 outcomes.jsonl              → hypotheses.jsonl
                               (matchDraft 绑 contentId)          → Report 页假设区
                             → 结构化状态码,登录态过期=显式待办
```

**抓取通道决策**：复用公众号已验证的 chrome-cdp 模式（`src/adapters/browser/wechat-mp-stats.ts`）——launchd 托管的常驻 Chrome 实例（`AUTOCREW_CHROME_CDP`，默认 `127.0.0.1:18792`），后台开标签到平台 origin，页面内 `fetch(..., {credentials:'include'})` 调内部接口。理由：

- 登录态永远留在浏览器 profile，AutoCrew 不提取/不存储 cookie（仓库既有红线）；
- 小红书若需页面内签名（`window._webmsxyw`），in-page 执行是唯一不搬运登录态的路径——**此假设在 XHS spike 中验证，验证失败则小红书降级为人工 CSV，不硬啃**（codex #2）;
- 请求指纹与真人浏览一致，风控面最小；
- 不引入 Playwright（Chrome 149+ `connect_over_cdp` 崩溃，`wechat-mp-stats.ts:10-12`）。

**不采用**：① Chrome 扩展加 `chrome.alarms` 后台抓取——违反扩展红线（零后台轮询，`extension/background.js:5-9`）；② Playwright 独立 profile——重复造登录态管理。扩展通道保留为抖音人工兜底。

**数据通路决策**（codex #9）：抓取器产出 **TypedRow**（结构化行，含平台作品 id），不再绕 `rows → CSV 文本 → 再 parse` 的有损弯路。新增 `importPerformanceRows(platform, rows: TypedRow[], opts)` 作为唯一入库漏斗；CSV 导入改写为「解析 CSV → TypedRow」的 adapter，扩展桥沿用 CSV adapter。

```ts
interface TypedRow {
  title: string;
  publishedAt: string | null;
  platformItemId?: string;      // 抖音 item_id / 视频号 objectId / xhs note_id
  metrics: Partial<OutcomeMetrics>;
}
```

## 3. P0 — 发布闭环修复（回流的前提）

### 3.1 确认已发布，任何发布路径都可达（修 D1）

`EditorTools.tsx` 把「我已发布，确认」区块从 `{clip && ...}` 拆出：`status ∈ {approved, publish_ready, publishing}` 即渲染。clipboard、推草稿箱、视频发布件三条路径殊途同归。

`confirm_published` 保持现状的**特权直写**（可从任意状态直达 published，绕过状态转移表，`publish.ts:86`）——这是有意决策：人工发布是外部世界的既成事实，系统状态必须服从事实，不做状态机路径校验（codex #26 的问题以「明示决策」关闭，不改代码语义）。`publishedAt` 只盖一次的语义不变。

### 3.2 确认时可贴平台链接（修 D2）

- 确认区块加选填输入框「平台链接」，随 `publish:confirm` 传 `publish_url`；
- `channel-contracts.ts` 的 `publish:confirm` 契约加可选 `publish_url`，desktop 通道透传（后端已支持）；
- **省略/空串时保留旧值，不清空**——重复确认不得抹掉已有链接；显式传新值才覆盖（codex #27，需改 `publish.ts:101` 的恒写逻辑）；
- 输入校验：仅接受 http(s)，其余拒收并提示；域名与 `content.platform` 不符时警告但不阻断（发错平台是用户要知道的事，不是系统要拦的事）（codex #12）；
- 前端 `Content` 类型补 `publishUrl`；已发布稿显示该链接（渲染前再过一次 http(s) 白名单）。

### 3.3 视频线终点接发布线（修 D3）

两件事，缺一不闭环（codex #28）：

1. `dashboard-summary.ts` 新增「成片就绪待发布」待办：`videoReadyAt 非空 && status ∉ {approved, publish_ready, publishing, published, archived}`，点击进入稿件；
2. `EditorTools` 在同判据下显示明确 CTA「进入发布检查」——调用现有 pre-publish 流程，检查通过自动流转 `publish_ready`（复用 `pre-publish.ts:246-254` 既有机制），不新造状态路径。

### 3.4 回填待办改判 outcomes（修 D4）

`dashboard-summary.ts` 待办判据改为查 `outcomes.jsonl`：

- 清除条件：存在该 contentId 的 outcome，且 `metricDate > publishedAt 当日`，且至少一个核心指标非空（发布当天的零值快照不算「已回填」，codex #13）；
- 该平台自动抓取已启用时，不再产生人工回填待办（由抓取状态待办接管）；
- **outcomes 读取失败 ≠ 无数据**：读取抛错时 dashboard 显示「回流数据不可用」状态，不得降级为空数组制造假待办（codex #14，现有 `dashboard-summary.ts:51` 的静默降级模式不适用于此判据）。

`performanceData` 字段停用为待办判据，不迁移不删除（另立 chore）。

## 4. P1 — 三平台自动抓取

### 4.1 P1a 基座：CDP 会话加固 + 入库漏斗 + 身份字段

**CDP 会话工具**（从 `wechat-mp-stats.ts` 抽取为 `src/adapters/browser/cdp-session.ts`，先加固再抽取，codex #15）：

- command 超时定时器在成功路径清理（现泄漏，`wechat-mp-stats.ts:73`）；
- WebSocket 关闭时 reject 所有 pending command；
- `Runtime.evaluate` 检查 `exceptionDetails`；
- in-page fetch 封装返回 `{httpStatus, finalUrl, contentType, bodyText}`，调用方按 schema 判定，**JSON 解析失败是 `schema_changed` 不是空数组**；
- 标签页关闭放 `finally`；
- 公众号通道迁移到新基座，行为保持（`in/out/timeout` 三态映射到新状态码）。

**结构化状态码**（codex #16/#17，取代 `error + string`）：

```ts
type PullResult = {
  status: "ok" | "needs_login" | "risk_control" | "browser_unreachable"
        | "schema_changed" | "timeout" | "error";
  rows: TypedRow[];             // 仅 ok 时非空
  errorCode?: string;           // 脱敏：HTTP 状态/schema 缺失字段名，无原始响应
  hasMore?: boolean;            // 达到分页上限时 true（"至少还有更多"，不谎报精确丢弃数, codex #23）
};
```

- 登录判定用**正向证据**：调各平台一个已认证才返回合法 schema 的轻量接口，schema 命中 = 已登录；URL 跳转/HTML 响应/schema 不符分别归 `needs_login` / `schema_changed`，不靠 URL 猜（codex #17）；
- 小红书 461/471 归 `risk_control`，展示与退避策略区别于普通失败；
- **lastError 只存脱敏错误码 + HTTP 状态 + schema 缺失字段名，永不落原始响应片段**（后台响应含账号标识/内部 token，codex #22）。

**入库漏斗**（codex #5/#6/#9/#10）：

- `importPerformanceRows(platform, rows, {source, dataDir})`：一次读全量建幂等索引 → 逐行校验（标题非空且至少一个数值指标，不合格行进 rejected 名单，合格行照常入库——部分失败不拖累整批）→ 单次 append 写入；
- **幂等键不分叉**：`outcomeKey` 维持现状（`平台:(contentId|标题@发布日):metricDate`）。`platformItemId` 是**属性**，用于绑定与对账，**不进幂等键**——三通道（自动/CSV/扩展）重复导入依旧同键去重，不会因新老键并存重复计数（codex #5 的解法）；
- 批内语义明确定义：批内同键后行覆盖前行（last-wins）；`replaced` 计数含批内覆盖；暴涨检测只对照批前存量（行为与现逐条路径的首行一致，写进测试）；
- **写并发**：进程内所有 outcomes 写走同一 promise 队列（仿 `serializeContentWrite`，`local-store.ts:292`）；跨进程（扩展 native-host）依赖 O_APPEND 行级追加 + 读侧坏行跳过（既有行为）。**不承诺崩溃原子性**：崩溃可能留半行，读侧容错并计数上报，这是明示的语义而非事故（codex #6，修正 v1 的错误承诺）；
- `OutcomeMetrics` 增 `impressions`（曝光）；小红书映射把「曝光量」从 `views` 别名里摘出来归 `impressions`——曝光和播放不是一个指标（codex #4）；
- `PerformanceOutcome` 增可选 `platformItemId`；`source` 支持 `"auto"`（schema 已预留），`wechat-pull` 同步改传。

### 4.2 P1b 三平台抓取器：spike 先行，fixture 定约

**每平台先做只读 spike，再写抓取器**（codex #1/#33）。spike 交付物：

1. 端点规格：URL、method、参数、分页、登录正向证据接口——记入 `docs/metrics-autopull-spec.md` 附录或平台各自的 `src/adapters/browser/<platform>-stats.md`；
2. **脱敏 fixture**（真实响应去除账号信息）入 `src/adapters/browser/__fixtures__/`，版本化；
3. 响应 schema 校验器（轻量手写 guard，不引 zod）：**schema 不符 → `schema_changed` + 零写入**，这是接口漂移的 canary（codex #33）。

实现顺序：抖音（生态最熟）→ 视频号 → 小红书。小红书 spike 需额外验证 in-page 签名假设（§2），失败即降级人工 CSV 并在 Report 页明示。

**分平台传输策略**（依据端点调研 `docs/metrics-autopull-endpoints.md`，2026-08）：视频号 in-page fetch 纯 cookie 直连；小红书 in-page fetch + 页面内签名；**抖音例外——接口带 `msToken`/`a_bogus` 签名，in-page 裸 fetch 也可能被风控打回，改走 CDP 网络拦截**：打开作品管理页，旁听页面自己发出的列表接口 JSON 响应，解析后关页。三家统一从 `PullResult` 契约出去，传输差异封在各自适配器内。

单平台抓取流程：登录正向证据 → 作品列表（分页，上限 200，超出 `hasMore: true`）→ 组装 TypedRow（含 platformItemId）→ 返回。列表接口自带累计指标则不逐作品打详情接口（少打请求 = 少碰风控）。

### 4.3 P1c 调度（managed-host 范式 + 显式退避状态机）

`src/desktop/metrics-pull-cycle.ts`，照 `managed-host.ts:194-222`：`stopped`/`ticking` 双闸、懒解析 dataDir、`timer.unref()`、`server.ts` listen 注册 + close 清理。

- tick 30min；每 tick 按平台判定是否该抓：`enabled && now ≥ nextEligibleAt && now - lastSuccessAt > TTL`（默认 12h，可配）；命中的平台**串行**抓（间隔 ≥10s），不并发打三家；
- **退避状态机落盘字段齐备**（codex #18）：失败 → `failureCount+1`，`nextEligibleAt = now + 1h`；当日（本地时区自然日）`failureCount ≥ 3` → `nextEligibleAt = 次日 09:00`；成功清零。`needs_login` 不算失败：`nextEligibleAt = 次日 09:00`，等人扫码（手动触发不受 `nextEligibleAt` 限制）；`risk_control` → `nextEligibleAt = 次日 09:00` 且当日不再自动碰该平台；
- **single-flight 在后端按平台统一管理**（cycle 模块持每平台 in-flight 标志）：手动 IPC 触发与定时 tick 走同一入口，同平台并发请求直接返回 in-flight，前端按钮置灰只是 UX 不是正确性来源（codex #19）；
- 自动抓取频率红线（保守默认，配置项而非事实断言）：单平台 ≤2 次/天。

**状态文件** `<dataDir>/metrics-pull.json`（codex #20/#21）：

```ts
{ schemaVersion: 1,
  platforms: { [platform]: {
    enabled: boolean,
    lastSuccessAt, lastAttemptAt, nextEligibleAt,
    failureCount, failureDate,          // 当日计数的日期锚（本地时区）
    autoAttemptDate, autoAttemptCount,  // 实现补充：自动尝试的当日计数——TTL 只约束成功路径，
                                        // 没有它，1h 退避会让失败日内自动重试冲破 ≤2 次/天红线；手动触发不计数
    lastStatus: PullResult["status"] | "never",
    lastErrorCode?, lastRowCount?, lastBatchId?
  } } }
```

- 全部读改写走 `writeJsonAtomic` + 进程内单写队列；文件损坏 → 重建默认值 + warn（状态文件是缓存不是账本，重建的代价只是多抓一次）；
- 写序：先 append outcomes（幂等），后写状态（带 batchId 与行数）。两写之间崩溃 → 状态偏旧 → 下轮按 TTL 重抓 → 幂等去重吸收。**一致性靠幂等重放，不靠事务**（明示语义）。

### 4.4 P1d 控制面与可见性

新增清单（codex #32，一个不落）：

- IPC channels：`flywheel:pull_status`（读状态）、`flywheel:pull_now`（手动触发，带 platform）、`flywheel:pull_toggle`（开关）；`channel-contracts.ts` 同步加契约；`ipc.ts` 接线；
- 引擎事件：`metrics_pull` 事件（携 platform + status），SSE 驱动前端刷新；
- **Report 页（数据回流）** 三平台状态区：每平台一行——开关、状态徽标（已连接 / 需扫码 / 风控暂停 / 接口变更 / 抓取失败 / 浏览器未连接 / 未启用）、最近成功时间、上次入库行数、「立即抓取」按钮；
- `browser_unreachable`（chrome-cdp 连不上）三平台统一显示一条「浏览器未连接」+ 启动指引，不逐平台重复报错；
- 需扫码 → 工作台待办「XX 平台登录态过期，扫码后数据继续回流」+ 平台后台 URL 指引（对齐 `wechat-pull.ts:39-42` 模式）。**视频号约 24h 登录态是社区经验，界面文案说「视频号可能需要每天扫码」，不承诺也不隐瞒**；
- 抖音扩展通道保留人工兜底，Report 页标注两通道同源幂等。

## 5. P2 — 绑定强化 + 假设闭环

### 5.1 平台作品 id 绑定与自愈

- **绑定映射表** `<dataDir>/platform-items.json`：`platform:itemId → contentId`，flywheel 模块私有（content meta 保持单向数据流不被回写）。写入时机：① 稿件有 `publishUrl` 且解析出的 id 与行内 id 相等；② `matchDraft` 标题+时间窗高置信命中（精确标题命中，非 dice 模糊）时登记——首次认对以后永远精确，绑定逐步自愈（codex #11 采纳）；
- `matchDraft` 优先查映射表，命中即精确返回；未命中走原模糊逻辑；
- **URL 解析** `src/modules/flywheel/publish-url.ts`：抖音 `/video/<id>`、`v.douyin.com` 短链（服务端跟随重定向解析，失败不阻塞确认）、xhs `/explore|/discovery/item/<id>`、`xhslink.com` 短链、视频号 `channels.weixin.qq.com` 分享链形态（spike 时确认可解析性，解析不出就依赖高置信标题命中登记映射——明示这条腿可能缺）；仅 http(s)；
- 对账（实现定案，2026-08-23）：映射表指向的 contentId 与 matchDraft 结果冲突时，以映射表为准且该行 `needsReview` 注明两个 id。原「同 `platform+itemId` 出现两个不同标题键必报 needsReview」一条**砍掉**——绑定表本就能吸收改名作品，该规则会对同一作品每批报一次且无处消除，是纯噪音。

### 5.2 复盘时间口径（先定口径，才有不失真的复盘）

outcome 是**累计快照**。retro 现按 `metricDate` 切窗（`retro.ts:101`），自动抓取上线后「本周重抓的 200 条老作品」会全部被算成本周表现——必须改（codex #3，阻断级）。

新增聚合层 `src/modules/flywheel/metrics-window.ts`（纯函数）：

- **增量视图**：同作品相邻快照差分 → 该作品本窗口内新增播放/点赞/评论（快照缺口按无数据处理，不插值）；
- **cohort 视图**：本窗口发布的作品 → 各自截至最新快照的累计值 + 发布龄期；
- **定龄视图**：作品在 D+N（默认 D+7）的首个 ≥N 龄期快照值，用于跨作品公平比较；
- retro 的 `gatherFacts` 改喂聚合结果（每视图取 top/全量摘要），**废除「任意前 20 条原始 outcome」进 prompt 的做法**（`retro.ts:119`，codex #31）——证据由代码选择与聚合，模型只读摘要。

**跨平台比较纪律**（codex #4）：绝对量（播放/曝光）只做同平台纵比；跨平台只比率类（完播率、互动率=互动/播放）且注明口径；曝光（impressions）与播放（views）在所有展示与聚合中分列。

### 5.3 假设台账：代码裁决，模型解释

`<dataDir>/hypotheses.jsonl`（append-only，latest-wins）：

```ts
{ id, statement,               // "开头 5s 抛问题的视频完播率高于账号基线"
  metricFocus,                 // OutcomeMetrics 键之一
  direction: "up" | "down",
  scope: { platform?, tag? },  // 假设适用范围
  contentIds: string[],        // 假设绑定的试验稿（提出时为空，发布后由人/复盘挂上）
  proposedAt, retroRunId,
  status: "open" | "supported" | "refuted" | "inconclusive",
  verdictAt?, evidence? }      // evidence = 代码算出的样本数/对照值/差值
```

**裁决是确定性代码，不是 prompt**（codex #7/#8）：

- `judgeHypothesis(h, aggregates)`：取假设绑定稿件的定龄（D+7）指标 vs 同平台账号基线（同龄期中位数）；样本 <5 或龄期不足 → `inconclusive`；相对差 ≥20% 且方向一致 → `supported`；≥20% 反向 → `refuted`；其间 → `inconclusive`。阈值是配置常量；
- 裁决语义如实命名为**观察性结论**：报告文案固定注明「非对照实验，混杂因素未隔离（题材/时长/发布时段/投流）」——不冒充因果（codex #7）；
- LLM 在 retro 中只做两件事：解释已裁决的假设（为什么可能成立/不成立），和**提出**新假设（≤3 条，须绑定 metricFocus + 下一步动作）。新假设经 schema 校验落盘；校验失败重试一次，仍失败 → 本期只出文字复盘，台账不写入并在结果中明示。

### 5.4 retro run 身份与写序（codex #30）

- retro 报告文件名加 runId（时间戳），同日重跑不覆盖；
- 假设的 `retroRunId` 指向该次运行；
- 写序：报告落盘成功 → 才写假设/裁决；假设写失败 → 报告尾部追加「台账写入失败」明示，不静默。

### 5.5 复盘文案适配

自动通道启用后，缺数据的提示从泛泛「请回填」改为指向具体平台抓取状态（如「视频号 3 天未成功抓取：登录态过期」）。

## 6. 边界与验收清单（product-sense 五问）

**状态**：
- [ ] 0 篇已发布稿：抓取照常，行入库为 historical，Report 页明示「N 行未认领」；
- [ ] chrome-cdp 未启动 → 统一「浏览器未连接」+ 指引；
- [ ] 平台已登出 → `needs_login` + 扫码待办，绝不误报为抓取失败；
- [ ] 小红书 461/471 → `risk_control`，当日停自动抓取，界面明示；
- [ ] 三平台部分成功部分失败 → 各自独立状态；
- [ ] 首次使用（状态文件不存在）→ 三平台 disabled，Report 页引导开启；状态文件损坏 → 重建默认 + warn。

**最坏输入**：
- [ ] 接口改版/HTML 伪装 200/JSON 解析失败 → `schema_changed`，**零写入**（canary 语义有测试）；
- [ ] 行内标题空/指标全空 → 行级 rejected，同批其余行照常入库；
- [ ] 作品数超 200 → `hasMore: true`，界面说「仍有更多」，不谎报精确丢弃数；
- [ ] 同日重复抓取/三通道重复导入 → 同键 latest-wins，`flywheel report` 数字不变（幂等键不分叉有测试）；
- [ ] publishUrl 贴了非 http(s) / 跨平台域名 → 前者拒收、后者警告。

**防呆**：
- [ ] 手动+定时+多 tab 并发触发同平台 → 后端 single-flight 单飞（测试锁行为）；
- [ ] 重复点「确认已发布」且不带链接 → 已有 publishUrl 不被清空；
- [ ] 批量写与逐条写混用 → 暴涨检测行为一致（批前存量对照，有测试）。

**失败可见性**：
- [ ] 每次抓取必落状态 + 事件；所有 catch 收敛为结构化状态码，无静默吞错；
- [ ] lastError 永不含原始响应内容（脱敏有测试：构造含 token 的假响应，断言不落盘）；
- [ ] outcomes 读取失败 → dashboard「数据不可用」，不产生假待办；
- [ ] retro 台账写入失败 → 报告内明示。

**明确不做**：
- 不做自动发布；不做 cookie 提取/存储/搬运；
- 不做 bilibili/头条/X/Reddit 抓取；不做粉丝画像、收益、直播数据；不抓评论内容；
- 不做因果推断（假设裁决明示为观察性结论）；
- 不动既有技债：看板列映射三处同步、`VIDEO_PLATFORMS` 重复定义、`createPlatformVariant` O(n) 落盘、`performanceData` 清理（各自另立 chore）。

## 7. 实施切分

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0 | 发布闭环 4 修（§3）：按钮解锁、publishUrl（保留旧值语义）、成片 CTA、待办改判 | 无 |
| P1a | CDP 基座加固+抽取、TypedRow 漏斗 `importPerformanceRows`、批量写语义、幂等属性字段（platformItemId/impressions）、结构化 PullResult、公众号通道迁移 | 无 |
| P1b | 每平台 spike（端点规格+脱敏 fixture+schema guard）→ 抓取器：抖音 → 视频号 → 小红书（含签名假设验证，失败降级 CSV） | P1a；**spike 需创始人已登录的 chrome-cdp 实例** |
| P1c | 调度 cycle + 退避状态机 + 状态文件 + 后端 single-flight | P1a |
| P1d | IPC×3 + 契约 + 事件 + Report 页状态区 + 待办 | P1c |
| P2a | publish-url 解析 + platform-items 映射 + matchDraft 强化 + 对账 | P1a |
| P2b | metrics-window 聚合层 + retro 改喂聚合 + 跨平台比较纪律 | P1 有数据后 |
| P2c | 假设台账 + 代码裁决 + retro runId/写序 + Report 假设区 | P2b |

测试策略：解析/校验/幂等/批量语义/聚合/裁决全走纯函数单测（fixture 用脱敏真实响应，版本化）；CDP 层注入 fetch 打桩 + schema canary 零写入测试；调度用 fake timer 锁 TTL/退避/单飞；LLM 输出只做 schema 校验与「裁决不经模型」的结构断言，不 exact-match 文本。真实协议回归：spike fixture + `schema_changed` canary + dogfood-runbook 增补人工只读 smoke 步骤（codex #33）。

## 附录：codex 评审处置（2026-08-23，33 条）

| # | 要点 | 处置 |
|---|---|---|
| 1 | 接口规格未定，无法验收 | 采纳：P1b spike 先行，fixture+规格为交付物（§4.2） |
| 2 | XHS 签名是未验证假设 | 采纳:spike 验证,失败降级 CSV（§2/§4.2） |
| 3 | 复盘按 metricDate 切窗，重抓老作品全算本期 | 采纳（阻断级）：metrics-window 聚合层，增量/cohort/定龄三视图（§5.2） |
| 4 | 跨平台指标语义混淆（曝光≠播放） | 采纳：impressions 独立指标+比较纪律（§4.1/§5.2） |
| 5 | platformItemId 分叉幂等键 → 重复计数 | 采纳：itemId 仅作属性不进键（§4.1） |
| 6 | 「单次 append 原子」是错误承诺 | 采纳：改为进程内写队列+读侧容错+幂等重放，明示无崩溃原子性（§4.1/§4.3） |
| 7 | 假设裁决无因果基础 | 采纳：明示观察性结论+混杂因素注明（§5.3） |
| 8 | 「样本不足必 inconclusive」不能靠 prompt | 采纳：裁决全部代码化，LLM 只解释/提议（§5.3） |
| 9 | rows→CSV→parse 有损绕路 | 采纳：TypedRow + importPerformanceRows（§2/§4.1） |
| 10 | 批量写语义未定义 | 采纳：批内 last-wins/replaced 口径/暴涨对照批前存量（§4.1） |
| 11 | URL 绑定覆盖不了短链，且不能自愈 | 采纳：短链解析+platform-items 映射表自愈（§5.1） |
| 12 | URL 无安全校验 | 采纳：http(s) 白名单+平台域一致性警告（§3.2） |
| 13 | 「一条 outcome 就消待办」太粗 | 采纳：metricDate>发布日+核心指标非空（§3.4） |
| 14 | outcomes 读失败被判成没回填 | 采纳：「数据不可用」状态（§3.4） |
| 15 | 公众号 CDP 实现有 5 处缺陷，不是可靠基座 | 采纳：先加固再抽取，缺陷清单进 P1a（§4.1） |
| 16 | 状态契约自相矛盾 | 采纳：统一 7 值结构化状态码（§4.1） |
| 17 | 登录检测只看 URL 不够 | 采纳：正向证据接口+schema 判定（§4.1） |
| 18 | 退避语义无字段支撑 | 采纳：nextEligibleAt/failureCount/failureDate+本地时区定义（§4.3） |
| 19 | 手动/自动无共享 single-flight | 采纳：后端按平台统一管理（§4.3） |
| 20 | 状态文件并发覆盖 | 采纳：writeJsonAtomic+写队列+schemaVersion+损坏重建（§4.3） |
| 21 | 状态与 outcome 非一个提交 | 采纳：写序+batchId+幂等重放对账（§4.3） |
| 22 | lastError 落原始响应=敏感数据持久化 | 采纳：只存脱敏错误码，含测试（§4.1/§6） |
| 23 | 精确丢弃数无法知道 | 采纳：hasMore 语义（§4.1） |
| 24 | 风控阈值是伪精确事实 | 采纳：标注社区经验/保守默认/可配置（§0/§4.3） |
| 25 | D4 诊断不准（GUI 有写入路径） | 采纳：诊断改写（§1） |
| 26 | confirm 绕过状态机未决策 | 采纳：明示为有意的特权直写（§3.1） |
| 27 | 重复确认清空 publishUrl | 采纳：省略保留旧值（§3.2） |
| 28 | 成片待办无 CTA 不闭环 | 采纳：待办+「进入发布检查」CTA（§3.3） |
| 29 | item id 是 P1 前置不是 P2 | 采纳：schema/漏斗字段移入 P1a（§4.1/§7） |
| 30 | retro 无 run identity | 采纳：runId+写序（§5.4） |
| 31 | retro 只喂 20 条原始行 | 采纳：代码聚合选证据（§5.2） |
| 32 | 控制面改动没列清单 | 采纳：P1d 清单（§4.4） |
| 33 | 缺真实协议回归门 | 采纳：fixture 版本化+schema canary+人工 smoke（§4.2/§7） |
