# P5：宿主在场就不要第二个模型——engine.json 降级为无人值守后备

> 状态：设计稿 v2（已吸收 codex 评审 13 条，见 §11）。未落地，待创始人定稿。
> 关系：直接承接 `2026-09-05-p3-multi-host-mcp.md`。P3 把**写稿**搬到了宿主模型手里，并在非目标里明写「内部杂活仍走 engine.json」。本篇处置那条非目标。

## 0. 一句话

调研的**核验**从来不需要模型——需要的是抓取和逐字比对，那是产品的活。模型只负责决定「打开哪一页」。所以宿主在场时，把那个决策交给宿主，产品继续抓取、继续校验、继续发同一张 `verified_quote` 证书；`engine.json` 退成无人值守时的后备。

## 1. 现状（全部有代码出处）

### 1.1 P3 把写稿交出去了，杂活留在了原地

> 不在产品里按宿主路由模型；内部杂活（视角调研、补证、审稿）仍走 engine.json。
> — `2026-09-05-p3-multi-host-mcp.md:54`（非目标）

代价在 2026-09-22 被真实使用打出来：两个中转端点同时不可用（`code.newcli.com` 解析到代理 fake-ip 段 198.18.0.42、连接重置；`api.deepseek.com` Key 401）。宿主照常领包写稿，但 `autocrew_workflow research` 与 `find_evidence` 双双不可用，稿件卡在 `repair`、25 处数字无据。

### 1.2 三个吃引擎的「宿主发起」环节

| 环节 | 代码 | 引擎岗位 |
|---|---|---|
| 四视角深调研 + 综合 + 立意卡 | `modules/research/deep-research.ts`、`research-perspectives.ts`、`angle-stage.ts` | scout |
| 定向补证 | `modules/research/targeted-research.ts:266-268` | scout |
| 审稿 | `modules/writing/script-review.ts:284`（reviewer 路由）、`reviewOnce` 在 `:335` | reviewer |

### 1.3 数字门不是核验机制（本节 v1 写错了，已改）

```ts
// modules/writing/number-gate.ts:407
const SOURCE_RANK: Record<LedgerSource, number> = { verified_quote: 0, own_claim: 1, user_claim: 2 };
```

v1 由此推出「宿主查的料够进门，所以宿主化不放松门禁」。**这个推论是错的。** 数字门比的是归一化的 `{value, unit family}`（文件头自述），不比主体、不比主张、不比来源真伪。codex 评审直接跑了 `verifyNumbers`：「乙公司投诉率上涨 30%」可以拿「甲公司收入上涨 30%」的引文过门，三种来源等效。

数字门的真实职责是**「这个数字你至少引了点什么」**，不是「这个数字是真的」。真的核验在别处（§1.4）。

`evidence-ledger.ts:8-11` 把三档说得很清楚：只有 `verified_quote` 算外部已核验，`user_claim` 一律按未核验对待。**把调研降成 `user_claim` 是实质降级，不是换标签。** v1 的说法是自欺。

### 1.4 真正的引文核验在 broker，而且不用模型

```ts
// modules/research/research-broker.ts:460
validateQuote(sourceId: string, quote: string): QuoteCheck {
  const entry = this.sources.get(sourceId);
  if (!entry) return { ok:false, reason: "未登记的来源 id——只能引用 search / read_page 返回的 sourceId" };
  if (entry.source.kind !== "page") return { ok:false, reason: "证据必须来自已读页面" };
  if (entry.normalized.includes(quoteCorpus(quote))) return { ok: true };
  return { ok:false, reason: "引文在正文里找不到——逐字复制，不能转述" };
}
```

**这段代码里没有模型。** 产品抓页、登记正文、把引文往正文里做子串比对。模型在整个调研循环里只干一件事：决定下一步 `search` 什么、`read_page` 打开哪一条。

这是本篇成立的支点：**把「决定打开哪一页」交给宿主，抓取与校验仍在产品手里，产出的就还是货真价实的 `verified_quote`。**

（v1 引 `angle-stage.ts:418` 说校验现成——**错了**。那是提示词字符串。真正的锚点校验在 `angle-stage.ts:213` 的 `readAnchorArg`，只核对锚点是否存在于已有简报引文或内部语料，验不了任意 `{url, quote}`。）

### 1.5 无人值守的活（v1 三条引用错了两条，已核对）

| 活 | 真实调用点 | 吃模型吗 |
|---|---|---|
| 选题雷达打分 / 蒸馏 | `desktop/radar-cycle.ts` 进程内定时器 → `modules/radar/relevance.ts`、`idea-distill.ts` | **是** |
| 每日选题摘要 | `desktop/digest-scheduler.ts:149` | **否**，模板渲染（`listTopics` + `renderEmptyDigest`） |
| 公众号摘要 | `modules/publish/digest.ts` | 是，但由**发布工具**触发，不是定时器 |
| 平台指标回流 | `desktop/metrics-pull-cycle.ts:331` | **否**，拉数据 |
| 周复盘 | `modules/retro/retro.ts`，调用点 `desktop/goal-retro-handlers.ts:63` | 是，**手动触发**，且 `retro.ts:207` 仍加载 engine |

所以真正「无人值守且吃模型」的只有**选题雷达**一条。v1 把三件事混成一类，并据此做了「不配 engine 就三样改手动」的产品取舍——那个取舍建立在错误事实上，作废。

### 1.6 备料对 engine 是硬依赖

```ts
// modules/writing/generate-script.ts:522
const [config, pack, profile, contrastPairs, patterns, picked] = await Promise.all([
  loadEngineConfig(dataDir),   // ← 无条件
```

`gatherInputs` 无条件加载引擎配置。2026-09-22 那次之所以还能 `pack` 成功，是因为**配置存在、只是端点连不上**。「完全没配 engine 也能领包」今天不成立。

### 1.7 宿主身份的实际粒度

`mcp/server.ts:191` 确实覆盖客户端自报的 `_host`（不是随便传字符串就能冒充）。但 token 对应的是**宿主名**，不是模型实例、不是会话。同一个 Codex 的两个会话共用同一身份。`claim_token` 只是租约令牌。

### 1.8 认领绑的是稿件

`storage/claims.ts:140` 的 `claimContent(contentId, employee, host, …)` 要求已有 `content_id`，且每篇稿只有一个 `Content.claim`。调研阶段通常只有 `topic_id`，没有稿。

## 2. 目标与不做

**目标**

- **G1 宿主在场就不再找第二个模型**——「在场」是显式事实（这次调用由宿主发起），不靠配置存在与否去猜。
- **G2 零 engine 配置能跑完写稿线**：选题 → 简报 → 立意卡 → 成稿，全程不调用任何模型 API。**验收方式是数调用次数 = 0**，不是「没报错」。
- **G3 宿主产出的证据与引擎产出的同级**：因为抓取与逐字校验都还在产品手里，宿主交回的引文过 `validateQuote` 才算数，过了就是 `verified_quote`。
- **G4 没人干的活是「在桌上等」，不是静默降级、不是报错**。

**不做**

- 不按宿主能力路由模型（不探测宿主是 Claude 还是 Codex 分派难易）。
- 不做云端排队、多用户、跨机器领包。
- 不把 `sources/` 原始网页整页塞给宿主（注入面约束照 P3 §5.1；宿主只能通过 `read_page` 拿到经 `sanitizeExternal` 处理的正文）。
- **不做「抓不到就降级入账」**（见 §3.2）。

## 3. 核心设计：把 broker 循环翻到宿主外面

### 3.1 三个新工具，不是一个「调研包」

v1 设计的 `findings[]` 一次性提交不成立：宿主给不出 `{url, quote}` 的可信度，产品没抓过那一页就无从校验。改成把 broker 的三个动作直接暴露成工具，宿主在自己的循环里驱动：

| 工具 | 做什么 | 谁在干活 |
|---|---|---|
| `autocrew_scout search{topic_id, query}` | 产品执行搜索，登记结果，返回 `sourceId` 列表 | 产品抓 |
| `autocrew_scout read_page{topic_id, source_id}` | 产品抓页、登记正文快照、返回 `sanitizeExternal` 后的正文 | 产品抓 |
| `autocrew_scout cite{topic_id, source_id, quote, claim}` | 逐字过 `validateQuote`，过了登记成 `ev-N`（`verified_quote`） | 产品校验 |

宿主决定搜什么、开哪页、引哪句。**配额沿用 broker 现有的 `quotas`**（`assetsPerJob` 等），不新发明一套。

### 3.2 抓不到就是拒绝，不是降级

codex 评审 #3 指出的漏洞：自动降级成 `user_claim` 等于给了一个绕过校验的入口——编造引文配可访问页面会被拒，**删掉 URL 反而能入账**。

**定案**：`cite` 只有两种结果，`ok` 或 `rejected`。没有自动降级。

宿主确实拿到了产品抓不到的一手材料（纸质、内网、线下访谈）时，走一条**显式**的路：`autocrew_scout claim_offline{quote, provenance}`，登记成 `user_claim`，并且这条材料**在稿件上留可见标记**，审稿与发布前都能看见「这篇有 N 条未核验材料」。显式入账可以，静默降级不行。

### 3.3 未核验材料不许被洗白

`evidence-ledger.ts:176` 的 `seedLedgerFromBrief` 把简报里的证据**无条件**标成 `verified_quote`。所以一条 `user_claim` 只要进过一次简报，下一篇写稿就会被重新包装成已核验。

**定案**：简报条目带上原始 source 档位并在 `seedLedgerFromBrief` 里透传；`user_claim` 永不升级，升级的唯一路径是重新过一次 `cite`。这条是 P5 的前置修复，不做则 §3.2 白设。

### 3.4 简报与立意卡：分阶段交，不是一次 `findings[]`

现有流程是三段（视角 → 综合 → 立意），codex #9 指出 `findings[]` 产不出验收要求的简报结构。对齐现有阶段：

- `autocrew_scout perspective{topic_id, kind, payload}`——一路视角一次提交，字段对齐 `research-perspectives.ts` 现有结构（洞察 / 推断 / 张力 / 缺口 / 误区）。
- `autocrew_scout synthesize{topic_id, payload}`——综合成简报，产出 `revision` 与 `hash`。
- `autocrew_scout angles{topic_id, cards[]}`——交立意候选卡，锚点走 `readAnchorArg` 现有校验。

简报的 `revision`/`hash`/生效指针/选题改动后的失效规则**全部复用现有 brief-store 语义**，不新建。

### 3.5 定向补证

今天的 `find_evidence` 就是 §3.1 三件套的一次内部循环。宿主版直接用 §3.1，不另开接口。配额口径要定死（codex #12）：`targeted-research.ts:521` 今天是**按调用**扣一次、每次最多返回四条。宿主版改成**按 `cite` 成功登记的条数**扣，整稿上限沿用 3 次调用 × 4 条 = 12 条。`rejected` 不扣。`force` 不重置额度。

## 4. 审稿：不叫「禁止自审」

### 4.1 接口

`autocrew_writer submit` 的 `review?: "engine" | "none"` 扩成加 `"host"`。落 reviewer 桌，`submit_status` 返 `awaiting_host_review`。

收件协议要写全（codex #10）：`autocrew_review_desk pack{content_id}` 读审稿包 → `submit{content_id, review_pack_id, attempt, issues[]}`。`issues[]` 的结构与引文定位校验**复用 `script-review.ts:197`**；提示词**已经在 `script-review-prompt.ts`**，直接引用，不用「抽成一份」（codex #13）。稿件版本绑定、重复提交幂等、过期结果拒绝、重启恢复，全部对齐 P3 §5.3 写作包的同款规则。

已有的 `reviewing` 重启恢复逻辑会重新拉起引擎审稿，**必须分叉**：`review:"host"` 的稿重启后回到等待态，不自动转引擎。

### 4.2 命名如实

v1 §4.3 叫「禁止自审」。codex #4 说得对：token 对应宿主名不对应会话（§1.7），`pack.host` 记的是领包者、实际提交者另记在 `pending.host`。同一个 Codex 的两个会话共用身份，这条约束拦不住自审。

**定案**：改名为**「不同凭证主体复核」**，并在稿卡上如实显示复核者的宿主名。它能拦「Claude 写完 Claude 审」，拦不住「Codex 会话 A 写、会话 B 审」。**不把它写成安全保证。**

单宿主用户的正确答案仍是 `review:"none"` + `accepted_unreviewed`（`writer-review.ts:211` 已有此终态），如实记录「没人审过」。

## 5. 桌子：复用租约，不复用写作包

codex #5 说得对，写作包绑死了 platform、占位稿、立意门、稿件目录、数字门、修订轮次、draft 状态——整包搬过来不便宜。

**定案**：
- **复用**：租约与令牌语义、幂等口径、`serializeContentWrite` 串行、存储辅助函数。
- **不复用**：写作包的状态机。scout 与 reviewer 各自定义自己的状态机。
- **`ClaimEmployee` 扩两枚举不够**（§1.8）。认领要能挂在 `topic_id` 上：抽一层 `claimTarget = {kind:"content", id} | {kind:"topic", id}`，`claims.ts` 按 target 存，而不是按 contentId 存。这是 P5b 的主要工作量，spec 不假装它便宜。

## 6. engine.json 降级

### 6.1 优先级定死（解 codex #8）

v1 里 G1 说「宿主在场就不用 engine」，§5.1 又说「engine 配了就直接跑」——自相矛盾。

**定案：按触发来源判定，不按配置存在判定。**

| 触发来源 | 谁执行 |
|---|---|
| MCP 宿主发起（`_host` 非 `local-user`） | 宿主。engine 配了也不用。 |
| 工作台按钮 / 聊天 / Telegram 回复 | engine；未配置则落桌等宿主 |
| 进程内定时器（只有选题雷达，§1.5） | engine；未配置则不跑，设置页如实说明 |

任务记录里落一个显式的 `executedBy`，不靠推断。

### 6.2 失败分类（解 codex #11）

「引擎挂了转落桌」太粗。分四类：

| 类 | 处置 |
|---|---|
| 认证失败（401） | 立即落桌，不重试。换 key 前重试都是白跑。 |
| 连接/超时 | 退避重试 2 次，仍失败则落桌，保留部分结果 |
| 输出不合格（校验不过） | 引擎自己的修复轮，用尽才落桌 |
| 存储写失败 | 不落桌，直接报错——这是 bug 不是降级 |

落桌时对该任务**收回引擎的执行权**（写一个 `executedBy` 转移记录），引擎迟到的写入按过期拒绝。引擎恢复后**不自动抢回**已落桌的任务。

### 6.3 条款

`ENGINE_UNCONFIGURED`（`engine/config.ts:42`）改写：先说「不配也能用，宿主接入即可」，再说选题雷达自动打分需要它，最后才是怎么配。

## 7. 分片与验收

| 片 | 内容 | 验收 |
|---|---|---|
| **P5-0** ✅ | 已落地（`d7e619a` + `1c98fce` + `7153e29`）：`gatherInputs` 拆掉 `loadEngineConfig` 硬依赖；`resolveResearch` 无简报时带上 topic；`pack` 透传 `research`。**`seedLedgerFromBrief` 的档位透传改为 P5b 前置**——今天 `BriefEvidence` 无档位字段，也没有任何路径能把未核验材料写进简报，所以无条件标 `verified_quote` 当前成立；不变量与「什么时候它会失效」写进了函数注释 | ✅ 删掉 engine.json 后 pack → ready → submit 走到 `accepted_unreviewed`，`runLoop` 调用次数断言为 0；反向用例：`engine.json` 写坏了仍 `failed`，不被当成「没配」 |
| **P5a** | `claimTarget` 抽象（§5）；scout / reviewer 两张桌 | 认领能挂 topic；两个宿主并发认领同一 topic，第二个被拒 |
| **P5b** | `autocrew_scout` search / read_page / cite / claim_offline（§3.1-3.2） | 断 engine，宿主驱动出一份简报；编造引文被 `validateQuote` 拒；删 URL 也进不去 |
| **P5c** | perspective / synthesize / angles（§3.4） | 断 engine，跑到立意候选卡，结构与引擎产物不可区分 |
| **P5d** | `review:"host"` 收件协议（§4） | 断 engine，另一宿主审出 blocker 并走完 `review_required`；重启后回等待态不拉引擎 |
| **P5e** | 触发来源路由 + 失败分类（§6） | 401 立即落桌不重试；落桌后引擎迟到写入被拒 |

## 8. 边界（product-sense 五问）

**最坏输入**：编造引文 → `validateQuote` 拒；伪造 `source_id` → 未登记拒；宿主领包跑路 → 租约过期可接管（已有）；宿主拿真材料但产品抓不到 → 走 `claim_offline`，稿上留可见标记。

**空 / 加载 / 错误态**：桌为空返空数组不是错误；抓取中有明确进行态；engine 失败按 §6.2 分类，禁止静默改道。

**重复触发**：`cite` 同 `{source_id, quote}` 重复 → 幂等返回已有 `ev-N`，不扣额度；其余照 P3 §5.3。

**权限边界**：宿主拿不到整页原文（只拿 `sanitizeExternal` 后的正文）；`review:"host"` 的凭证主体约束如实命名为「不同主体」而非「禁止自审」。

**破坏性动作**：本篇无删除/覆盖动作。唯一的权力转移是 §6.2 的执行权收回，有记录。

**刻意不做**：不给宿主跳过 `validateQuote` 的开关；不做自动降级入账。

## 9. 待创始人确认

1. **选题雷达的取舍**（§1.5 修正后只剩这一条）：不配 engine，雷达自动打分不跑，改成打开工作台时手动触发。比 v1 说的「三样功能」小得多。认不认？
2. **`claim_offline` 要不要做**：它是唯一合法的「未核验入账」口子，给的是你驻场拿到的纸质/内网材料。不做就是这类材料永远进不了正文数字。
3. **单宿主时审稿怎么办**：`accepted_unreviewed` 如实记，还是允许同宿主复核并打标记。我倾向前者。

## 10. 与 v1 的差异（给读过 v1 的人）

v1 的支点「数字门对来源一视同仁，所以宿主查的料够用」是**错的**——数字门不核验任何东西。v2 换了支点：**核验在 broker，而 broker 的核验不需要模型**。结论没变（宿主能替代引擎做调研），论证换了，而且 v2 的宿主产物是真 `verified_quote`，不是 v1 那种降级货。

## 11. codex 评审处置表（2026-09-22，codex-cli 0.153.4，13 条）

我抽查了 #2 #5 #6 #7 #13 的代码，全部属实。

| # | 级别 | 结论 | 处置 |
|---|---|---|---|
| 1 | P1 | 数字门只比值和单位，不核验主体/主张/来源；codex 实跑验证 | **全采纳**。§1.3 重写承认 v1 推论错误；支点改到 §1.4 broker |
| 2 | P1 | `angle-stage.ts:418` 是提示词，真校验在 `:213`（只验已知锚点）与 `research-broker.ts:460` | **全采纳**。§1.4 更正引用；§3.1 改走 broker |
| 3 | P1 | 自动降 `user_claim` 是绕过校验的入口（删 URL 反而能过） | **全采纳**。§3.2 定案：只有 ok/rejected，无自动降级；离线材料走显式 `claim_offline` + 可见标记 |
| 4 | P1 | token 对应宿主名不对应会话，「禁止自审」是虚假保证 | **全采纳**。§4.2 改名「不同凭证主体复核」，明写拦不住什么 |
| 5 | P1 | writer-pack 绑死稿件语义；`claims.ts:140` 要 contentId，调研只有 topic | **全采纳**。§5 只复用租约/幂等/存储，各自定状态机；新增 `claimTarget` 抽象并承认是主要工作量 |
| 6 | P1 | `gatherInputs:522` 无条件 `loadEngineConfig`，P5a「两处修完即零配置」错，「既成事实」不成立 | **全采纳**。§1.6 补事实；改成 P5-0 并把「模型调用次数=0」写成验收口径 |
| 7 | P1 | §1.4 三条后台引用错两条（digest 是模板渲染、metrics 不是复盘） | **全采纳**。§1.5 重做表格，产品取舍从「三样」缩到「只有雷达」 |
| 8 | P1 | G1 与 §5.1 矛盾；「宿主在场」无代码依据 | **全采纳**。§6.1 改为按触发来源判定 + 落 `executedBy` |
| 9 | P1 | `findings[]` 产不出简报与立意卡的完整结构 | **全采纳**。§3.4 拆成 perspective / synthesize / angles 三阶段，对齐现有结构与 brief-store 语义 |
| 10 | P1 | reviewer 只有入桌没有收件协议 | **全采纳**。§4.1 补全读包/提交/校验/幂等/重启分叉 |
| 11 | P1 | 「引擎挂了转落桌」缺失败分类与执行权交接 | **全采纳**。§6.2 四类处置 + 执行权收回 + 拒绝迟到写入 |
| 12 | P1 | 配额口径与现有 `targeted-research.ts:521` 不一致 | **全采纳**。§3.5 定死：按成功登记条数扣、rejected 不扣、force 不重置 |
| 13 | P2 | `script-review.ts:372` 是写手修稿不是审稿；`reviewOnce` 在 `:335`；提示词已在 `script-review-prompt.ts` | **全采纳**。§1.2 更正行号；§4.1 改为直接引用现有提示词模块 |

**没有驳回项。** v1 有三处引用是我读错代码写出来的（#2 #7 #13），一处核心论证不成立（#1）。
