# 内容本体：阶段由产物推出（2026-09-29）

状态：定稿（2026-09-29）。创始人已确认方向与边界（盘问 + Fable 顾问）；已吸收 Codex 会审 12 条 P1 / 4 条 P2（会话 `01a0ebfd-c1d8-7dc3-bb35-48846d5ea72b`）；§13 已拍板。

## 1 为什么

多个 agent（Claude Code、Codex、WorkBuddy、网页总编辑）改同一批稿件，状态只靠「盖章」推动（handoff → report → 工作台 gate3/gate4 → register），agent 一绕开流程看板就漂。2026-09-25..29 的证据：

- 资料库 13 条里 6 条盘上产物跑在状态前面。
- Codex 用 `autocrew_asset add` 回填封面 → 只进 `meta.assets`，生命周期没人读。「一张封面」5 种存法各被不同代码读。
- 「这条在哪一步」算了 4 遍：`my-content-plan.ts columnOf`、`status.ts`、`desk.ts`、`frontend/src/lib.ts` 残留旧列。
- 补登记一条场外剪好的片子约 30 次调用、10 次拒绝；4 次 claim_held 全是自己挡自己；拖动做不了真动作。
- 看板 GET 会写状态；MCP 状态变化不进事件流。
- 发布器取「最新视频素材」而非登记的成片（`ego-lite.ts:51`）；NAS 归档靠活认领排除在做的稿、核对后整目录删（`nas-archive.ts:46,111`）。

## 2 核心模型

一条内容 = **事实**（盘上有什么）+ **决定**（创始人点过什么）+ **登记记录**（某一组决定提交成功的不可变凭据）。制作段阶段是它们的纯函数。

### 2.1 阶段边界与认稿

- **写稿段**（topic_saved … revision）照旧是状态机。
- **认稿是创始人决定**，绑正文哈希，只能经浏览器会话写入。所有入口（`content save/update/transition`、`force`、看板）都不能由模型把稿推到 approved 或更后（Codex P1-2：现在 `content-save.ts:298` 接受模型 `transition+force`）。制作段资格只来自有效认稿决定，不来自 `status`。
- 待录制期间改正文：创始人自己改（我的内容回写、网页）→ 认稿自动重绑新正文；agent 改 → 认稿失效，回「写稿中·等你认稿」（§13 默认项 C）。
- **制作段**（有效认稿之后）视频稿阶段由 `deriveStage` 推出；`status` 是投影缓存，只由服务内 `refreshProductionProjection` 在同一写锁里生成，外部不能传目标阶段（不再有 `viaDerive` 参数、不再为制作段维护第二套转移图）。读方一律用推导结果。
- 写稿段稿件若已有制作事实 → 仍在「写稿中」，badge「已有 A-roll / 剪辑产物，等你认稿」。
- 发布执行状态（publishing）与制作阶段分开存，不互相覆盖。
- 图文平台不变（approved → publish_ready 直通）。`cover_pending` 不再产生，旧值迁移时按推导重算。

### 2.2 存储

每条内容一个 `00-project/autocrew/production.json`：`{schema, revision, round, facts[], decisions[], registrations[]}`。`revision` 每次写 +1，所有写入按 revision 做乐观并发。`round` = 制作轮次（§2.5）。

- 时间线 `timeline.jsonl` 是审计投影，可重放，**不是第二份真相**；带单调序号 `seq`。
- 字节索引 `sha256 → [(content_id, fact_id, kind)]` 放工作区服务目录，可重建：启动顺序 = 恢复未完成事务 → 重建索引 → 开放写入；重建发现冲突要报出，不后写覆盖。

### 2.3 事实（Fact）

分类型 schema，**业务状态与文件可用性分开**（Codex P1-9）：

```ts
type FactKind = "aroll" | "cut" | "srt" | "cover" | "publish" | "chatcut_project";
interface FactBase {
  id: string; kind: FactKind; round: number;
  state: "accepted" | "candidate" | "pending_match" | "rejected";
  availability: "present" | "missing" | "unreadable" | "archived";   // 只影响发布资格和告警
  source: "record" | "reconcile" | "founder" | "legacy"; by?: { host: string; session?: string };
  at: string; request_id?: string; evidence?: string; post_publish?: true;
}
// 文件类：path（项目内相对；候选存绝对）, sha256, size, mtime_ms, duration_ms?
// cover：ratio "3:4"|"4:3", version, text?     srt：for_cut（所属成片 sha）
// chatcut_project：project_id, timeline_id?, uses_aroll: fact_id[]（显式引用，才能执行「被引用不挪」）
// publish：见 §6
```

去重（Codex P2-13）：字节可一对多被引用（同一视频既当原片又当无剪辑成片、平台变体复用封面都合法）；**只有 A-roll 归属独占**——同一原片不能同时是两条稿的 accepted aroll。同条同 (sha, kind) 幂等。

### 2.4 决定（Decision）——只由创始人产生

浏览器会话路由写入；模型调用一律拒（沿用 khayyam `isModelCall`）。每个决定带所针对的指纹，**不带 expectedStatus**；幂等键 = (决定类型, 指纹)。

| 决定 | 绑定 | 作用 |
|---|---|---|
| 认稿 | 正文哈希 | 进入制作段 |
| 确认候选 / 不是这条 | fact id + sha | candidate → accepted / rejected（rejected 按条记住） |
| 成片通过 / 打回（附原话） | cut sha + 正文哈希 | |
| 用这一版封面 | 3:4 sha + 4:3 sha + 封面字 + 正文哈希 | 两比例齐才可点；缺字当场补 |
| 撤销成片/封面批准 | 决定 id | |
| 重开文稿 | 当前 round | 见 §2.5 |
| 我发了 / 纠正发布记录 | 平台 + 作品身份 | 见 §6 |
| 四项决定改值 | 标题 / 平台 / 目标时长 / 封面字默认 | 进剪辑中时从稿件带默认，批准前可改 |

批准只绑正文哈希，不绑标题。制作段平台不能从视频翻成非视频（khayyam 守卫）。

### 2.5 制作轮次与冻结

- 进入剪辑中（本轮第一个 accepted 制作事实）时冻结正文：写冻结副本 `01-script/frozen/<正文哈希>.md`；**冻结检查放在存储写路径**（`local-store` 写正文的唯一入口，`:949` 一带），覆盖 content update、writer submit、我的内容回写、asset 版本回滚（`asset.ts:91`）、review auto_fix（`review.ts:123`）等全部写口（Codex P1-10）。
- **「重开文稿」**是唯一解冻方式（取代「A-roll 不算，重录」）：原子地结束当前 round——本轮事实、批准、登记转入历史（不删文件，本轮原片挪进 `02-aroll/_作废-<round>/`）；round+1；认稿失效，稿子回写稿中；阶段回推导（§13 默认项 D）。
- **已发布也能重开，原地重做**（创始人 2026-09-30，取代 09-29「已发布不能重开 / 另起新版本」）：这种情况少见，不另起新版本。已发布卡片的确认框写明「这条已发布，重开后会移出已发布栏、回到写稿中；这次的发布记录留作历史」。上一轮的发布槽留作历史（面板「以前几轮的发布」），永远不算进新一轮；新一轮从空槽开始。从已发布往回拖仍然是「纠正发布」，不是重开。
- **重开之后上一轮的原片仍归这条稿**（创始人 2026-09-29 默认）：别条稿 record 不能占；只有创始人在卡片上确认「改挂到这条」（卡片写明现在归哪条稿）才放，改挂是持久的归属转移（原稿那条事实记 released_to）。

### 2.6 推导表（spec 核心，写成带夹具的测试）

`deriveStage` 只对「有效认稿 + 视频平台」的稿生效，输出 `{stage, missing[], badges[], candidates[], publishable}`。只看当前 round。第一条命中即返回：

| # | 条件 | 阶段 | 说明 |
|---|---|---|---|
| D1 | 有已核实的发布回执（§6，状态 ≥ 已投出且未被纠正），或有效「我发了」 | 已发布 | badge 显示审核中 / 定时 / 已公开；被驳回 → 不命中 D1 |
| D2 | 存在一条**登记记录**，其绑定组合与当前有效的成片批准、封面批准、正文哈希、字幕**完全一致** | 待发布 | 所绑文件 availability≠present → `publishable=false` + badge「文件不见了」，**阶段不倒退** |
| D3 | 成片批准与封面批准都有效，但无匹配的登记记录 | 剪辑中 | missing = 登记提交失败原因（如「缺这版成片的字幕」）；有更早的登记记录也不借用 |
| D4 | 本轮有 accepted 制作事实（aroll/cut/srt/cover/chatcut_project，availability 不论） | 剪辑中 | missing ⊂ {成片, 字幕, 封面(3:4/4:3), 成片待你审, 封面待你选}；有未审的新成片 → badge |
| D5 | 其余 | 待录制 | missing = A-roll；有候选 → badge「发现疑似 A-roll」 |

批准有效 = 未撤销 + 正文哈希未变 + 所绑文件的**记录 sha 未被替换**（文件被覆盖 → 重算 sha 不符 → 失效，E13）。文件缺失只影响 availability，不让批准失效，也不让阶段倒退（Codex P1-9）。

`status` 投影：待录制=approved、剪辑中=editing、待发布=publish_ready、已发布=published。同一个 `explain()` 供看板、我的内容、晨报、desk、MCP 摘要、首跑清单；删掉 `frontend/src/lib.ts` 旧列。

## 3 `record`：agent 只报事实

`autocrew_content action=record`，所有宿主可调（Codex allowlist 加入），不要认领、不要交接，不带任何批准语义（`cover_text` 只是默认值）。

参数：`content_id, kind, request_id, path?, ratio?, version?, cover_text?, for_cut?, uses_aroll?, platform?, account?, url?, item_id?, chatcut_project_id?, timeline_id?, note?`。参数正规化（数组/对象当字符串传来要解析修复）。

顺序（**全部检查先于任何副作用**，Codex P1-8）：

1. `request_id` 已处理过 → 直接重放上次结果（搬走之后重试不会因源路径不存在而报错，Codex P2-13）。
2. 路径：展开 `~`，逐段 lstat 拒符号链接，必须是可读普通文件（raman `resolveLocalFile`）；iCloud 占位拒（raman `checkCover`）。
3. 完整性：大小与修改时间 10 秒内不变 + ffprobe 读出时长 > 0（aroll/cut）；不满足 → 报「还在导出/拷贝」，什么都不写。
4. 归属与冲突：A-roll 独占冲突 → 拒，说出是哪条；被 `chatcut_project.uses_aroll` 引用的原片不挪。
5. 搬入授权（Codex P1-7：「可扫描」与「可搬入」分开）：
   - 已在本条项目内 → 原地 accepted。
   - **可搬入根**：原片收件箱（自家，默认可搬）；ChatCut 导出目录、剪映导出目录（仅 cut/srt/cover）；创始人在设置里对某个监视文件夹勾了「允许 agent 直接搬入」（§13 问题 2）。
   - 其他路径（含只开了扫描、没开搬入的监视文件夹）→ 只记 candidate，等创始人在卡片上确认。
6. aroll 来自可搬入根：文件名规范化后与标题前缀命中（现有 L1 规则）→ 直接 accepted；否则 → `pending_match`，后台转写比对（不持任何锁、不阻塞 get，Codex §15-4），完成后复核文件身份未变：没有别条稿分数更高 → accepted 并搬；有 → 转 candidate 让创始人定。回执里告诉 agent「约 2 分钟后核对完自动挪进项目，之后从摘要里取新路径导入 ChatCut」。
7. 落位（在文件归属事务里，§7）：
   - aroll：**挪**进 `02-aroll/`，改名 `<标题>-原片.<ext>`（多条 `-2`、`-3`），此后不再改名。同卷 rename；跨卷复制→核哈希→删原件，源身份变化即中止、原件不动（E28）。
   - cut / srt / cover：**APFS 克隆**（`clonefile`，不占额外空间、与源互不影响）进 `04-edit/`、`05-cover/vNNN/`；跨卷普通复制。**不用硬链接**——外部原地覆盖会改掉已批准的文件（Codex P1-8）。
8. `kind=publish` 见 §6。封面每条最多 30 个版本（防刷）。
9. 写事实 + 时间线 → `refreshProductionProjection` → 回执：事实 id、项目内路径、阶段、missing、候选、`next_action`。

agent 确认 A-roll 的边界（创始人定）：只有创始人在对话里让它去取、且匹配无冲突时，agent 才 record；打开一条内容不会顺手认任何候选；成片通过、选封面、认稿只能创始人点。服务端凭据是「可搬入根」设置，不是对话内容。

## 4 对账

服务内单一入口 `reconcile(contentId?)`，与所有写路径同属一个领域服务 `ProductionService`。

- **触发**：60 秒循环（与「我的内容」同步同一循环，先对账再排文件夹）；record 后本条；`content get` 前本条（只做项目内快扫，不跑转写）。看板读取只调纯函数，**不写**（删 `board-data.ts syncPublished`）。
- **项目内**：`02-aroll`、`04-edit`、`05-cover/**`（含 `exports/`、`final/`、`review-*`）、`07-delivery/**`，以及旧存法（`meta.assets` 封面、`execution.json` 报到产物、`cover-manifest.json`）→ 导入为 accepted（source=legacy/reconcile）。更新每条事实的 availability（含已归档）。
- **外部发现分两种范围**（Codex P2-15）：
  - 首次归属：收件箱、监视文件夹、ChatCut/剪映导出里的新文件，匹配对象 = 有效认稿前后的视频稿（draft_ready / approved）→ candidate（带依据）。
  - 已绑定稿的新版本：按 `chatcut_project` 工程 ID 与标题，发现剪辑中/待发布/已发布稿的新导出 → candidate，已发布的标 `post_publish`。
  - `match.ts:207` 未校准、永远 `ambiguous`：候选只列前三名；「无冲突」只按 §3-6 的规则判，不宣称「明显赢家」。
- **逐条隔离**：每条 try/catch，失败汇总 → 看板顶部 + 晨报 warnings。

### 4.1 启用与首跑（影子模式）

- 每个资料库持久化「本体已启用版本」。未启用时新模型只算**影子结果**，旧读方照常服务；看板顶部「本体对账：要挪 N 张卡，看一下」→ 完整差异清单（每张卡依据哪条事实）→ 创始人确认 → 原子启用（切换前先恢复所有旧事务）。
- 迁移规则：archived 不动；publishing 保留；旧 schema 2 批准不迁移（读成「需重新通过」，目前无待批旧批准）；旧 `cover_pending` 按推导重算；可能被 ChatCut 引用的旧原片在清单里逐条问「挪走后重新关联 / 留原位」。
- 推导表版本升级时同样先影子后启用。

## 5 批准即登记

两次批准都有效时，服务端跑**登记提交**（从 raman 摘 `commitCore`，按事务 ID 改造，Codex P1-6）：

- 核：视频平台必须有 `for_cut` = 所批成片 sha 的字幕事实；所批文件现算 sha 与批准一致；都在项目内、无符号链接。不过 → 批准照存，阶段 D3，missing 写原因。
- 做：盖 `videoDone`、写 `video.final`、选中封面拷成 `05-cover/封面-3x4.*`/`封面-4x3.*`、口播稿实拍版（`register-spoken`）、实拍版核对清单（raman `retro-checklist`，不挡发布）、写**登记记录**。
- **登记记录不可变**：绑定内容、round、正文哈希、成片批准 id + sha、封面批准 id + 两张 sha + 封面字、字幕 sha 及其所属成片（Codex P1-4）。D2 只认与当前有效批准完全一致的那条。
- 事务：持久事务 ID + 日志；恢复只查提交记录，不查当前阶段或交接；raman `restorePrev` 改成按事务 ID / 版本条件回滚（它现在无条件恢复封面单、按时间大小判断成片戳归属，raman `register-commit.ts:208-222`）。
- 字幕等后到时，record / 对账再触发提交——两个判断已给过，补齐事实后自动完成不算替创始人判断。
- **发布出口**（Codex P1-3）：所有发布路径（`ego-lite.ts`、video_kit、pre_publish、publish-content 技能读的发布包）只取**当前有效登记记录**里的成片与封面，发前核批准有效与实际哈希；删掉「最新视频素材」回退（`ego-lite.ts:51`，并入 raman 7c2d5f2 的按资产身份取片）。新版已批准但提交未完成 → 阻止发布，不静默用旧包；撤批后旧包立即不可发。

## 6 发布回执：每个平台一个发布槽

**创始人决定（2026-09-29）**：每条内容、每一轮、每个平台只有**一个发布槽**。不再跨来源去认「是不是同一件作品」（链接 / 作品 id / 时间）——前四轮评审都栽在这件事上。

- **观察只追加**：每次读到的发布信息是一条 publish 事实（来源、平台、状态、证据时间、原因；链接 / 作品 id 只作显示）。同一（来源, 平台, 轮次）流里和最后一条完全一样就不写，所以对账收敛；变了（审核中 → 驳回 → 申诉恢复）就追加。
- **来源分三类，优先级固定**：可信（AutoCrew 发布计划记录、数据回流按作品 id 绑上）> 创始人（「我发了」、确认 AI 的说法）> 待核（模型 `record kind=publish` / 模型调 confirm_published、数据回流按标题猜）。槽的状态 = 出现过的最高一类里**最后一条**的状态。删了重发 → 最新的算，早的留作槽历史。
- **AI 的说法从不靠身份匹配自动核实**：同平台同轮来了可信观察就被顶掉，或创始人确认；确认只证明「真发了」，保留说法里的提交状态（审核中不会变成已公开）。
- **轮次在写入时盖一次**（创始人 2026-09-30 定为保守规则）：没重开过 → 当前轮。重开之后，发布计划 / 数据回流的观察**只有带着晚于最近一次重开的实际提交时间（`submitted_at`）才进新一轮**；其余一律留在旧轮——包括旧定时帖到点公开、公开时才补上作品 id、以及没写 `submitted_at` 的新作品。AI 的说法是本轮刚说的：有发布时间按时间切，否则同作品沿用、再否则本轮。创始人可以纠正。
  - **已知代价（创始人接受）**：新一轮真发了、但计划里没写 `submitted_at`，不会自动算已发布，要创始人点「我发了」。看得见，且改口补丁 02 要求发布技能按平台写 `submitted_at`。
- **NAS 归档 / 备份用的「本轮发布时间」**只认本轮可信观察（发布计划、数据回流按作品 id）里真实的公开 / 定时时间；「我发了」、AI 说法、只有排序占位时间的旧回执都不算。定不出 → 不归档、不备份，归档报告列「待确认发布时间」。归档与「5 已发布」视图用同一份「最近 5 条」保留名单；逐条读失败只跳过那一条。
- **纠正指向槽**（`slot:<轮次>:<平台>`）：纠正时刻之前槽里的一切作废，之后新来的照算。
- 已投出（定时 / 审核中）即进已发布，badge 标状态；被驳回 → 回待发布并标原因（E35）。无任何观察时创始人点「我发了」。发布动作本身不自动化（X4）。
- **已知代价（创始人认可）**：同一轮在同一平台发了两件不同作品，只算最新的那件。

## 7 并发与事务

- 保留资料库单写者锁（`library-lock.ts`，防两个服务写同一库）。它只验证进程身份，**不防同进程并发**（Codex P1-5），所以另加服务内**文件归属事务互斥**：record 落位、候选确认、登记提交、重开文稿、NAS 归档、旧交接残留全部经过它。
- 锁顺序固定：文件归属事务 → series 锁 → 内容写锁；事务内只调不再取锁的存储原语（现有内容锁不可重入，`local-store.ts:554`；`handoff/lock.ts:2` 已禁止套锁后调用 update/transition）。
- 所有搬运、克隆、登记、归档写持久事务日志（沿用 `aroll-move.ts` 日志格式，但以事务 ID 判提交，不以 handoff 判——现有恢复器 `aroll-move.ts:172` 会把无 handoff 的新搬运当未提交撤回，Codex P1-6）。启动先恢复再扫描。
- **NAS 归档**（Codex P1-11）：归档经文件归属事务；删除前复核清单，只删已逐文件核对过的文件；新增文件保留；排除条件从「活认领」改为「本轮有未完成事务或 30 分钟内有 record」；归档位置进 availability=archived，对账不误报丢失。

## 8 旧入口怎么办（一期就处理，不留两套真相）

Codex P1-1：旧工作台批准要求交接（`founder-review.ts:131`）、`gate-state.ts` 不认新批准、`register` 要交接、`revoke` 退回 draft_ready——「旧路照常可用」不成立。一期：

- **适配**：工作台的成片/封面批准、打回按钮改写成 §2.4 决定（二期再搬到卡片）。
- **关闭（返回指路错误）**：`autocrew_video handoff / match / confirm / report / register / revoke`、`autocrew_asset add` 的封面分支与「把库外文件挪进项目」行为（`local-store.ts:1183`）。错误里写清改用什么：「改用 autocrew_content record；看 content get 摘要的 next_action」。
- **同步改口**（从三期提前）：Codex 技能包（`~/.codex/skills/personal-ip-video-loop` 等）、项目 AGENTS.md 模板改为一行指向、MCP 工具说明、WorkBuddy 复制指令、SessionStart 晨报文案（桶改为：待写 / 待认稿 / 等 A-roll / 剪辑中 / 等你审 / 待发布 + 候选待确认）。
- 三期只删死代码。

## 9 A-roll 入口与摘要视图

### 9.1 A-roll

1. **收件箱**「我的内容/0 原片放这里/」：默认开、可搬入。对不上任何稿的视频留原处，待录制列头「收件箱里有 N 个视频没对上」，点开手动指定。
2. **监视文件夹**：设置「也在这些文件夹里找原片」，默认空；每个文件夹两个开关：扫描（给建议）/ 允许 agent 直接搬入。限额：14 天内、时长 ≤ 60 分钟、≤ 10 GB（超限只比文件名）；每文件只转写一次（大小+修改时间+头尾哈希缓存）；一次一个；可暂停；界面叫「建议」。读不了 → 提示授权。
3. **卡片挂载**：拖文件 / 选文件 / 贴路径 = 创始人决定，直接 accepted 并按 §3-7 落位；匹配器像别条就先提醒。
4. **告诉 agent**：agent 按 §3 record。

挪进项目后由 agent 从新路径导入 ChatCut，并 `record kind=chatcut_project uses_aroll=[…]`。

### 9.2 时间线与摘要

- 复用 main 上已有的 `autocrew_content summary`（`src/tools/content-summary.ts`，只读、不带正文、≤1.5KB，445de12 起）：制作段稿件的 `stage`/`blockers`/`next` 改由 `explain()` 给出，另加 missing、badges、候选、最近变化（调用方传 `since_seq`；不传给最近 10 条）、关键路径。`content get` 行为不变，不用迁移消费方。
- MCP 回执双发（`mcp/server.ts:196`）不在本 spec 处理。
- 不做活动面板（X2）。

## 10 界面

- **一期最小面板**：点卡或拖卡 → 阶段、还差什么、候选（是这条 / 不是这条）、A-roll 挂载、「重开文稿」、「我发了 / 纠正」；成片/封面批准仍在（适配后的）工作台。拖动：写稿中→待录制（认稿）、待发布→已发布（我发了）是真动作；其余前向拖 = 打开面板；往回拖 = 对应撤销决定（撤销批准 / 重开文稿 / 纠正发布），先确认。
- **二期**：成片通过与封面选版搬进面板；Mac 原生弹窗退出主路；工作台只看详情。
- 服务重启后网页登录不失效（一期 1b）。

## 11 分期（§13 问题 3）

- **1a 正确性内核**：production.json 存储 + 字节索引 + 事务日志与恢复；`deriveStage`/`explain` + 夹具测试；`ProductionService` 单一写入服务与锁顺序；认稿硬门；冻结与重开文稿；record（项目内、收件箱、ChatCut/剪映导出）；项目内与旧存法对账 + 影子模式启用；工作台批准适配；登记记录 + 提交；发布出口校验；发布回执；NAS 归档互斥；旧入口关闭 + 各处改口；最小面板与拖动。
- **1b 入口与体验**：监视文件夹 + 后台转写匹配 + pending_match；卡片挂载的匹配提醒；已绑定稿新版本发现；`content summary` 接 `explain()`；网页登录跨重启。
- **2**：批准搬进卡片面板，原生弹窗下主路。
- **3**：删死代码。

## 12 前置

1. 合 `claude/friendly-khayyam-d6d9fa`，过 `npm run check`。
2. 从 `claude/confident-raman-740d6e` 只摘零件（`commitCore`/`RegisterSource`、`resolveLocalFile`+`checkCover`、`kit-stale`、`retro-checklist`、`candidateBlock` 不变量、7c2d5f2 按资产身份取片），按 §5/§7 改造；不要 retro 流程、`retro_register`、`viaRetro`、`generation:0` 哨兵、RetroConfirmCard。先 khayyam 后摘件。
3. `claude/content-progress-drag-issue-0afb52`、`feature/board-drag` 不合。
4. 「纠正 AI」封面按创始人定改成 A「AI 又忘了？」。

## 13 创始人拍板（2026-09-29）

- 一期就关旧入口并同步改口（§8）。
- 监视文件夹加「允许 agent 直接搬入」开关（§3-5、§9.1）。
- 一期拆 1a / 1b（§11）。
- 默认项全部照准：A 被 ChatCut 引用的原片不挪；B cut/srt/cover 用 APFS 克隆不用硬链接；C agent 改稿作废认稿、创始人自己改稿自动重绑；D「A-roll 不算，重录」改为「重开文稿」；E 模型报的发布回执先「待核」，AutoCrew 发布器/数据回流的直接算；F 转写改后台，agent 报原片后约 2 分钟自动挪进项目。

## 14 边界

E1 缺成片或封面 → 剪辑中写缺什么。E2 待录制无 A-roll → 面板挂载入口。E3 图文不动。E4 多候选全列。E5/E24 未完成文件（10 秒不稳或读不出时长）不收。E6 同条同 (sha,kind) 幂等；request_id 重放。E7 坏路径报错不写。E8 挂错条 → 「不是这条」；A-roll 跨条独占冲突在 record 时拒。E9 封面缺字选用时补。E10 两比例齐才可选。E11 参数正规化。E12 决定幂等。E13 所批文件被覆盖 → 批准失效写原因。E14 往回拖 = 撤销具体决定或重开文稿，先确认。E15 打回写时间线。E16 文件不见 → availability=missing，不倒退，拦发布。E17 发布后新导出 → post_publish 候选，不动阶段。E18 进剪辑中冻结，全部写口。E19 两个 agent 同剪 → 两份成片都待审。E20 对账失败可见。E21 record 全有或全无。E22 登记提交失败写原因、不借旧记录。E23 事务可恢复、重点安全。E25 多 take 问创始人。E26 被 ChatCut 引用不挪。E27 重开文稿旧原片进 `_作废-<round>/`。E28 搬运失败原件不动。E29 转写没就绪只比文件名并提示。E30 读不了监视文件夹要提示。E31 转写限额+暂停。E32 低分不认。E33 收件箱对不上的留原处并提示。E34 待录制改稿按改稿人决定认稿去留。E35 发布回执按「每轮每平台一个槽」求值（重开后只有带晚于重开的 submitted_at 的观察进新一轮，其余留旧轮；没写 submitted_at 的新一轮发布要创始人点「我发了」，09-30 接受的代价）：分已投出/已公开/驳回，最高可信类里最新的算，删了重发以最新为准；纠正指向槽；同轮同平台两件作品只算最新（创始人认可的代价）。E36 归档与 record 并发 → 互斥，只删已核文件。E37 新版已批未登记 → 阻止发布旧包。 E38（2026-09-30）已发布的稿也能重开文稿，原地重做：确认框写明移出已发布、发布记录留作历史；上一轮发布槽只作历史、新一轮从空槽开始；从已发布往回拖仍是纠正发布。E39 重开之后上一轮的原片仍独占，改挂要创始人在卡片上确认，改挂后归属持久转移。E40 所批文件覆盖后又改回原字节 → 那条事实恢复可用；对被覆盖的文件做批准 / 选用直接拒，不回「成功」。E41 同一 request_id 换了参数 → request_conflict，不回放。E42 发布回执平台名按闸门同一张别名表归一。

## 15 不做

X1 不用大模型判断状态；外部文件只按文件名 + 本机转写确定性打分。X2 不做活动面板。X3 未授权搬入的外部路径不自动认。X4 发布动作不自动化。X5 WorkBuddy 不加载 AutoCrew（其 strictMcpConfig 忽略用户 mcp.json）另给步骤。X6 不动图文流程；NAS 归档只改互斥与删除核对，不改归档策略。

## 16 验收

- **推导表夹具**：D1–D5 每行正反例；写稿段带制作事实不越过认稿；文件缺失不倒退且 publishable=false；登记记录与批准组合不一致不命中 D2；改标题不失效；新成片不作废旧批准；重开文稿后回写稿中。
- **认稿硬门**：模型经 save/update/transition/force 推到 approved 以上全拒；agent 改稿作废认稿、创始人改稿重绑。
- **record**：检查先于副作用；可搬入根 vs 只扫描 vs 其他路径三种结果；符号链接/iCloud 占位/未完成文件拒；A-roll 跨条冲突拒；被 ChatCut 引用不挪；request_id 重放（搬走后重试）；克隆后外部覆盖不影响项目内文件；publish 模型回执为待核。
- **冻结**：六个写正文入口全拒。
- **事务**：搬运/登记/归档中途杀进程 → 重启恢复正确；无 handoff 的搬运不被旧恢复器撤回；同进程两个并发 record 抢同一原片只成功一个；归档期间 record 新文件不被删。
- **发布出口**：只取当前登记记录；撤批后不可发；新版已批未登记时阻止。
- **发布槽**：AI 说法被同平台可信观察顶掉、确认保留提交状态；驳回→申诉恢复取最新；早于重开的记录不进本轮；纠正槽后新来的照算；重复读取不累积。
- **对账**：逐条隔离；看板读零写入；影子模式不写、启用后原子切换。
- **旧入口**：关闭的动作返回指路错误；工作台批准写新决定。
- **真实数据影子运行**（资料库 APFS 克隆副本，端口 4318）应得：pzey0m、2g2bzh 剪辑中（missing=成片待你审/封面待你选）；5t07zj（Downloads 开扫描时）待录制 + 「发现疑似 A-roll」；z265zp、n0ezov 写稿中 + 「已有 A-roll，等你认稿」；j2v9ag 已发布，ChatCut 导出目录有新版时出 post_publish 候选；其余 draft_ready 不变。
- `npm run check` 全绿；codex review 无 P1/P2。
