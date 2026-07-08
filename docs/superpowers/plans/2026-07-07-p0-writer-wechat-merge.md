# P0 实施计划 — 合体：qingmoagent 文案质量 + 公众号链收编

> 日期：2026-07-07 · 依据：[PRD-v4.md](../../PRD-v4.md) §8/§9（裁决 A–F 已生效）
> 目标一句话：把创始人已认可的 qingmoagent 文案流程和已验证的公众号发布路径移植进 AutoCrew 本体，跑出第一条「白盒可视、能闭合、值得改」的链。

## 验收（PRD-v4 §8 P0，不含糊）

1. 连续 10 篇公众号稿采纳率 ≥50%（口径：主观「没有推倒重写」为主，编辑距离留档旁证——裁决 B）
2. 其中 ≥5 篇经审核推入公众号草稿箱（A 级发布）
3. **白盒资格线（裁决 E）**：选题 → 稿 → 审核 → 配图/封面 → 推草稿，每步产物在 UI 卡片流可见；待审稿应用内可编辑。验收演练 = 创始人全程只看 AutoCrew 界面完成一篇从选题到草稿箱，无需看终端/日志。

## 现状盘点（2026-07-07 已核实）

**源资产（qingmoagent / openclaw 侧）**

- 主仓：`~/projects/qingmoagent`
- 已验证工作区：`~/.openclaw/workspace-muse-social`——⚠️ 同名目录另有一份在 `~/.openclaw/workspace/workspace-muse-social`，阶段 0 必须先确认哪份是 musegzh 在用的活版本
- 发布脚本：`~/.openclaw/workspace-muse-social/scripts/wechat_publish.py`（blueprint 认证的全路径版本）
- [openclaw-integration-blueprint.md](../../openclaw-integration-blueprint.md)（2026-03-31）的 5 组资产清单仍是盘点底稿，但已过去 3 个月，逐项核实版本漂移

**AutoCrew 本体已有（不是从零建）**

- `src/modules/publish/wechat-mp.ts`（322 行）：已存在但是**薄桥**——spawn 外部 python（seedream 生图脚本 + `~/.openclaw/xiaohu-wechat-format/scripts/publish.py`），默认路径硬编码指向 openclaw 工作区。⚠️ 它桥接的 publish.py 与 blueprint 认证的 wechat_publish.py 不是同一脚本，阶段 0 分辨两者关系（同源/分叉/谁新）
- `src/modules/packs/`：pack-schema + koubo（口播包）——声明式包抽象已有第一个实例；公众号包 = 第二个包，顺带检验 schema 的平台维度扩展（PRD-v4 §4.3）
- `src/modules/writing/`：generate-script、platform-rewrite、script-prompt、selection-rewrite——骨架在，**质量差距住在 prompt 与流程里**，不在结构里
- humanizer / sensitive-words / title-hashtag / 风格档案：v3 §10 复用清单依然成立

## 阶段任务

### 阶段 0 · 源资产盘点与 diff（半天–1 天）

1. 确认两份 workspace-muse-social 哪份是活版本（以 musegzh 运行配置为准）
2. 理清 `xiaohu-wechat-format/publish.py` 与 `wechat_publish.py` 的关系，选定收编对象
3. diff qingmoagent 的 social-writing / article-derivation / refinement 与本体 generate-script / script-prompt——**质量差距点名到具体 prompt 段与流程步骤**，不许笼统说"人家写得好"
4. 确认公众号 appid/secret 现存位置、认证类型与接口配额；确认 seedream 生图 provider/key 状况
5. 产出：资产处置清单（直接移植 / 重写 / 弃用），追加为本文件附录

### 阶段 1 · 文案组引擎 + 公众号平台包

1. pack-schema 扩展平台维度字段（结构骨架 / 长度 / 格式规范 / 钩子集，PRD-v4 §4.3-1）
2. 公众号包：以 qingmoagent 移植内容为本体（第二个声明式包）
3. 生成管线执行 §4.3-2 隔离红线：每次生成 = 全新短时 loop，只注入「声音内核 + 单个平台包 + brief」；禁止同一上下文连写两个平台
4. 声音内核 v0：从创始人历史公众号文案种子化（Day-1 热启动思路复用）
5. 采纳率记录：待审卡三键（采纳 / 轻改采纳 / 重写）+ 落库——北极星的读数来源，不许后补

### 阶段 2 · 公众号发布链收编（A 级）

1. wechat-mp.ts 去桥化：路径/key 入本地配置（设置页开发者区，替代硬编码 `~/.openclaw` 路径）；是否将 python 移植为 TS 按阶段 0 diff 结论定——**P0 目标是链通不是纯度**，能配置化就不急移植
2. 审核员进链：sensitive-words + AIGC 合规口径过一遍才允许推草稿（发布门中间件，同步阻断）
3. 发布回执卡：推送结果（成功 / 失败 / 草稿箱指引）回卡片流

### 阶段 3 · 白盒可视（E 资格线）

1. 每步产物落卡片流（复用 S2.8 卡片持久化，重启可回放）
2. 待审稿应用内编辑（复用 S2.7 稿件工作台 / PendingEdit；编辑信号顺手喂 §7.2a 风格学习——纠正即训练的第一个真实输入源）
3. 按验收第 3 条做演练

### 并行轨 · B 级预填风控评审（裁决 D）

- 与 P0 并行启动评审文档：抖音 / 小红书 / 视频号逐平台（暴露面、ToS 条款、风控信号、回滚策略、逐次提交确认交互）
- 只出评审，不写实现；评审通过是 P2 实施前提

## 明确不做（P0 纪律）

- 不动指挥台视觉改版与事件流架构（P1）
- 不做封面设计师（用现有生图/封面兜底路径）
- 不做总监定时循环（硬约束：P0 验收前禁止，PRD-v4 §8）
- 不做 B 级预填实现（只做评审）
- 不迁移 qingmoagent 前端 / org / 订阅模型（blueprint 红线不变）

## 风险与待验证

1. **版本漂移**：blueprint 是 3 月的，openclaw 工作区 7 月的现实可能已分叉（两份同名目录即证据）——阶段 0 的存在理由
2. **公众号 API**：草稿箱/素材接口需认证公众号，配额与 key 管理待阶段 0 确认
3. **数据回填通道**：公众号后台导出 vs datacube API（认证号可用）——验证后并入数据分析师，不阻塞 P0 验收
4. **生图依赖**：seedream 脚本的 provider/key 状况；生图失败时的封面兜底路径是否仍然有效

---

## 附录 · 阶段 0 盘点结果（2026-07-07 当日完成）

### 0-1 活版本裁定

- **活版本 = `~/.openclaw/workspace-muse-social`**（mtime 2026-07-07 凌晨，带 AGENTS/MEMORY/HEARTBEAT/.learnings 全套运行态）；`~/.openclaw/workspace/workspace-muse-social` 是 2026-04-05 的旧拷贝，**忽略**。
- 两个发布脚本是**调用关系不是分叉**：`wechat_publish.py`（147 行）是编排层（扫 `[IMAGE:]` 标签 → seedream 生图 → 封面 → 调推送），真正的 MP API 推送在 `~/.openclaw/xiaohu-wechat-format/scripts/publish.py`（474 行，key 读 skill 目录 config.json）。AutoCrew 的 `wechat-mp.ts` 桥的正是同样两个依赖——**它已经是 wechat_publish.py 的 TS 等价物**，P0 不需要移植编排层，只需去桥化配置。

### 0-2 质量差距点名（qingmoagent/muse-social vs 本体 script-prompt.ts）

1. **Quality Gate 硬门禁（最大差距）**：article-derivation 有 5 项 PASS/FAIL 强制自检循环——字数 ≥5000、数据/案例密度（≥3 案例 + ≥5 数据引用）、配图标记 ≥4、**Hook 反模式黑名单**（禁"随着…""近年来…""众所周知…"等 5 种开头）、humanizer 处理数确认；任一 FAIL → 修复重检，全 PASS 才进排版。本体 generate-script 是**一次生成即提交，无自检循环**。
2. **衍生深度硬指标**：结构模式强制轮换表（thesis-driven / phenomenon autopsy / tension-based）+ 独家内容 >40% + 信息增量 ≥3 处。本体 pack 只有结构规则，无量化深度要求。
3. **学习环路已是 LLM 版**：social-writing 第一步 = 读 learnings.md Distilled Rules 并「作为硬约束逐条应用」；style-calibration → edit-feedback → memory-distill 三技能环（基线捕获 → 结构化纠正记录「改了什么/意味着什么/下次怎么用」→ 重复反馈蒸馏为持久规则）。**这就是 PRD §7.2a 要用 LLM 替换 8 正则的现成实现蓝本，也是 §4.3 纠正路由的种子。**
4. **流程顺序**：social-writing 是「定一个核心角度 → 先写最强钩子 → 围绕钩子成稿」，且**选题弱时主动顶回并提更强角度**；本体是一把出全稿。
5. **发布前第二道门**：`draft_quality_check.py` exit 1 → 禁止推送——与 PRD「禁止静默失败」同精神，本体发布链没有这道门。
6. **封面 prompt 模板**（2.35:1 Notion 插画风、8 字标题区、高对比配色）成品可直接进公众号包。

### 0-3 资产处置清单

| 资产 | 处置 | 去向 |
|---|---|---|
| article-derivation 衍生规则 + Quality Gate | **直接移植** | 公众号包（packs/）+ 生成管线自检循环 |
| social-writing 流程（规则硬约束 / hook-first / 弱选题顶回） | **直接移植** | generate-script 流程改造 |
| style-calibration / edit-feedback / memory-distill 三环 | **移植为蓝本** | modules/learnings 替换正则蒸馏（§7.2a） |
| humanizer-zh SKILL | 本体已有 TS 版 | diff 校准即可 |
| wechat_publish.py（编排层） | **弃用**（wechat-mp.ts 已等价），仅保留 `[IMAGE:]` 标签协议 | — |
| xiaohu publish.py（MP API 推送） | **暂留外部依赖**，路径/主题入本地配置 | wechat-mp.ts 去桥化 |
| draft_quality_check.py | **移植** | 发布链推送前硬门禁 |
| generate_article_images.py | 与 wechat-mp.ts 生图循环重复 | 合并取一 |
| 封面 prompt 模板 | **直接移植** | 公众号包字段 |
| qingmoagent refinement.py（760 行被动纠偏 + 「已记住 X」确认交互） | **概念移植**（采纳三键 + 可见确认 UX），代码不搬（FastAPI 依赖） | 阶段 3 白盒可视 |
| 飞书 Bitable 选题状态流 | 不迁移 | local-store 状态机替代 |
| wechat-auto-draft SKILL（261 行） | 待核对（疑与 article-derivation 推送段重叠） | 阶段 1 顺手确认 |

### 0-4 安全项（立即处理）

- `wechat_publish.py` 第 25 行**硬编码了火山方舟 ARK API key**（blueprint 三月就点名过）。该 key 需**轮换**并全部走配置——wechat-mp.ts 已支持 `AUTOCREW_IMAGE_API_KEY`/`ARK_API_KEY` env 读取，通道现成。article-derivation 的读法（`.secrets/business_credentials.json`）是正确姿势。
- 公众号 app_id/app_secret 在 xiaohu skill 目录 config.json——收编时入 AutoCrew 本地配置（设置页开发者区）。

### 0-5 对阶段 1 的修正

pack-schema 扩展字段按 0-2 定：结构模式轮换表、Quality Gate 阈值组、配图规则、封面 prompt 模板。**阶段 1 的核心工程 = 把「一次生成」改成「生成 → Gate 自检 → 修复循环」**（带轮次预算上限，符合 v3 §5 短时 loop 原语）；prompt 内容本身从 muse-social 三个 SKILL 平移，不重新发明。

---

## 进度记录

### 2026-07-08 阶段 1 完成（5/5）

| 任务 | 状态 | 落点 |
|---|---|---|
| 1. pack-schema 平台维度扩展 | ✅ `73cf3eb` | QualityGateSpec / StructureMode / writerRole / coverPromptTemplate，口播包零改动 |
| 2. 公众号平台包 | ✅ `73cf3eb` | packs/wechat-article.ts（article-derivation 平移：5000/5/4 阈值、四结构模式、2.35:1 封面模板）；wechat_mp 自动路由 |
| 3. Gate 自检循环 | ✅ `73cf3eb` | 生成 → 硬门禁 → FAIL 打回修复（默认 2 轮），骑 submit_script 自纠通道；修复轮耗尽残余 FAIL 经 gateFailures 透出不静默。单平台上下文隔离天然满足（每次生成 = 全新短时 loop × 单包） |
| 4. 声音内核 v0 | ✅ 零代码 | **复用既有 absorb 流程**：style:absorb → analyzeStyleSamples → creator-profile writingRules，生成管线本就注入 profile。声音内核=profile（跨平台共享），平台语法=pack——§4.3 两层拆分架构上已满足。**待创始人操作**：从 muse-social 7 篇历史稿中挑 3-5 篇最像自己的，贴进「编剧 · 风格档案」面板点「吸收爆款风格」 |
| 5. 采纳三键 + 落库 | ✅ `f39728e` | 工作台 采纳/轻改采纳/重写 三键；content:adoption 通道（IPC 42）；未裁决不进分母、rate 无裁决时 null 不显假 0%；toast 直出当前采纳率 |

顺手收编：前 session 未提交的两个完整功能已落地——海外选题雷达（`d317ae0`，五免费源）与编辑即学习接线（`5a4fcee`，contentUpdate 自动记 diff + 攒够自动蒸馏）。后者恰是「纠正即训练」的另一半输入源。

验证口径：TSC 干净，vitest 712/712 全过（store/IPC/gate/pack 层全覆盖）；workbench 三键按钮为 renderer 层，未跑 Electron 冒烟，下次启动 app 时人工点验。

下一步 = 阶段 2（公众号发布链收编：wechat-mp.ts 去桥化 + 审核员进链 + 发布回执卡）。

### 2026-07-08 阶段 2 完成（3/3 + 1 顺手修复）

| 任务 | 状态 | 落点 |
|---|---|---|
| 1. wechat-mp.ts 去桥化 | ✅ | `<dataDir>/publish.json` 的 wechatMp 段（脚本路径/生图 key/author/theme）；优先级：调用参数 > publish.json > env > 内置默认。设置页 UI 字段未做（env/json 已可配，UI 补充排 P1 指挥台改造时一起） |
| 2. 审核员进链（发布门） | ✅ | executePublish 推送前 scanText 同步阻断；force 放行但违规照样透出（warning + violations）——最终决定权在人，系统保持透明 |
| 3. 发布回执卡 | ✅ | 新 `publish:wechat_draft` 通道（IPC 43）；工作台 wechat_mp 稿新增「推送公众号草稿箱」按钮 + 回执区（成功：配图数 + 下一步指引；阻断：违禁词明细） |
| 顺手修复 | ✅ | **draft.md 过期 bug**：updateContent 只改 store 不重写 draft.md，原实现会把工作台编辑前的旧稿推上去。现发布时一律从 store 新鲜落盘 |

验证：TSC 干净，vitest 721/721（发布门/事实源/配置注入/参数优先级全覆盖）；渲染层按钮未跑 Electron 冒烟。

**P0 余量**：阶段 3 验收演练（需创始人配好 publish.json/engine.json 后真跑一篇：选题→生成→审→推草稿箱→三键裁决）；声音内核种子化操作（创始人 10 分钟）；并行轨 B 级风控评审文档未启动。

### 2026-07-08 P1 一期完成 — 引擎事件流 + 编辑部平面（提前于 P0 验收，创始人裁决：dogfood 动力优先）

| 件 | 落点 |
|---|---|
| 事件总线 | `src/desktop/event-hub.ts`：真实事件落盘 events.jsonl（重启可回放）+ 注入式广播；观测层吞错红线 |
| 事件映射 | `src/desktop/event-map.ts`：transition/adoption/风格蒸馏/发布回执与阻断/扫榜 → 人话日志行（纯函数全测试） |
| 推送通道 | `engine:event` push + `events:recent` 回放通道（IPC 44）；chat 工具开工线经 main.ts 桥入日志 |
| 渲染 store | `renderer/store.js`：events + busy 单一 store，widgets 订阅增量更新（§7.3-1 落地起点） |
| 编辑部平面 | 今日新增：墨色工作日志条（真实事件流）、事件驱动 presence 忙态（真忙才亮，无假活性）、待审队列组件（审稿一键直达工作台） |
| E2E 验证 | CDP 全链演练：队列 → 审稿直达 → 轻改采纳 → 回今日，工作日志实时流出「你裁决了《…》：轻改采纳（采纳率 100%）」，落盘与推送双通道均验证 |

二期余量：目的页收编为二级对象管理、点员工头像=过滤（当前仍是切视图，§7.3-3 完全体）、雷达/pipeline 组件并入 store 订阅。三期：总监 L2 循环接入（硬前提：文案转正）。

### 2026-07-08 交付形态迁移 — Electron 窗口 → 本地 server + 浏览器 dashboard（PRD-v4 §11）

创始人裁决:app 形态限制太死(改前端要重建重启、单窗、包重),要 Polsia 式浏览器 dashboard。落地:

| 件 | 落点 |
|---|---|
| 本地 server | `desktop/server.ts`:Node 原生 http(零新依赖),复用 `buildIpcHandlers()`;IPC 通道 → `POST /api/invoke`,event-hub → SSE `/api/events` |
| 安全 | 绑 127.0.0.1 + 启动 token(header/query)+ Host 白名单(防 DNS-rebinding);无 token 403、伪造 Host 403 均已验证 |
| 前端传输层 | `desktop/renderer/transport.js`:fetch + EventSource 复刻 preload 的 `window.autocrew` 表面;`config.js`(server 动态生成)注入 token + 通道表 |
| 脚本 | `npm run serve` = tsx desktop/server.ts |
| 引擎 | 一行未动(本就 electron-free);Electron `main.ts` 保留但降级为「以后可选的壳」 |

**红线**:server 永远本地,绝不上云(上云=护城河消失,PRD-v4 §11 写死)。

E2E 验证(真实 Chrome,非 Electron):`http://127.0.0.1:4317/` 渲染出创始人真实 `~/.autocrew` 数据(待审队列 5 篇真稿、雷达真热点、94 天草稿告警);config/transport/markdown 全 200,SSE ready 帧通且 token 保护;TSC 干净,vitest 730/730。

**注**:本次只迁移「交付形态」(Electron→浏览器),IA 仍是旧五页导航。三栏(内容流|大工作台|总编辑对话)重构是下一步——已出 mockup 并经创始人认可方向。
