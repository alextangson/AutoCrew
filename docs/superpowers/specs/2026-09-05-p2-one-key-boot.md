# P2：一把钥匙开机——模型配置收口、线路报病、可选接入分开放

> 日期：2026-09-05
> 状态：终稿（codex 评审 13 条已逐条吸收，映射见 §10；§9 三项创始人 2026-09-05 全部同意）。P2 之后的方向已定：AutoCrew 做成宿主无关的 MCP 工具与案卷层，Claude 当写手宿主、Codex 当封面与剪辑宿主，见 `2026-09-02-dsh-employees-and-case-files.md`
> 触发：创始人真机 2026-09-05——写稿专线中转 code.newcli.com 再次整站不通，产品甩出 `出错了：502 {"error":{"message":"fetch failed"}}`；创始人评语「产品的整体设置我觉得很复杂」。
> 关系：接在 P1（`2026-09-04-p1-angle-stage-production.md`）与 dsh 写作线之后；三画像设置页往后排，因为它只会再加一块设置。

## 0. 一句话

一个人的 AI 创作工具，跑通「调研 → 立意 → 写稿」只该要一把模型钥匙；线路坏了产品自己说是哪条线坏、这次怎么顶的；其余全是可选接入，各自说明解锁什么，不和必填项并排。

## 1. 现状诊断（全部有代码出处）

### 1.1 一个端点能填四个地方，互相不知道

| 层 | 是什么 | 出处 |
|---|---|---|
| 主端点 | `apiKey/baseUrl/strongModel/fastModel` | `src/engine/config.ts:41-72` |
| 任务专线 `routes` | writer / reviewer / analytics / scout / codex，各带自己的 baseUrl+model(+apiKey) | `config.ts:75-88` |
| 备用 `fallback` | 独立一整块 baseUrl+apiKey+强/快模型 | `config.ts:16-22` |
| 自定义端点 `providers` | **只给聊天切换器用**，对写稿/调研零影响 | `config.ts:26-28` |

后果：
- 创始人的配置里写稿、审稿、备用三处都指向同一家中转，主线挂了备用一起挂，`fallback` 形同虚设。README「配置模型」一节推荐的四条专线也全在这一家（`README.md:55-76`）。
- `codex` 专线**没有任何运行时消费者**（只剩预设、设置卡片、探针目标）。
- `reviewer` 专线设置页**没有卡片**，探针白名单也没有它（`src/desktop/settings.ts:74-79, 359-364`，`settings-probe.ts:20`）。
- `fallback` 设置页**读不到也写不了**（`settings.ts:324-418` 白名单里没有）。
- 硬编码预设指向 `code.newcli.com`（`config.ts:98-125`）。

### 1.2 线路坏了，产品不说人话

同一个上游连接失败，四条链路四种说法，只有一条是给人看的：

| 入口 | 用户看到什么 | 出处 |
|---|---|---|
| 聊天 | `出错了：502 {"error":{"message":"fetch failed"}}` 原样 | `chat-router.ts:1649-1650` → `ChatDock.tsx:331` |
| 深调研 | `调研失败 · too_few_perspectives`（视角逐个因引擎失败，聚合只看数量） | `deep-research.ts:451-456`，`ResearchPanel.tsx:189` |
| 写稿 | `［生成中断］` + 原始错误前 120 字 | `generate-script.ts:933-951`，`Editor.tsx:353-357` |
| 设置页「测试」 | 「连不上这个端点：域名解析不了或网络不通」——**全产品唯一会翻译的地方** | `settings-probe.ts:29-48` |

自动兜底存在（`loop.ts:207-226`），但 `LoopEvent.fallback` 只带模型名、`LoopResult` 不带任何兜底信息（`loop.ts:27, 74`），所以只能在聊天进度条闪一个 chip（`chat-router.ts:134-147`）；写稿/调研用了备用，稿子和任务上没有任何痕迹。`doctor` 从不发网络请求（`workflow.ts:422-437`），「配了但打不通」它看不见。没有任何一个引擎健康状态通道（`channel-contracts.ts` 全表无）。

### 1.3 必填和可选并排摆

设置页九个分区按顺序：引擎、搜索、发布·公众号与生图、封面生成、情报源、灵感收件箱、工作区、知识库（`Settings.tsx`）。约 25 个字段、12 个数据文件。

- 首次开机只问一个 Key（`Onboarding.tsx:29-58`），**不测连通、不定模型**，保存即进。
- 情报源里 X/Reddit 的 Key 缺失，每轮扫描抛错只进 console（`radar-cycle.ts:64`），设置页无任何显示。
- 搜索没配：深调研拒投递（`search-provider.ts:65-66`），写稿**静默降级**成「未补证」（`generate-script.ts:413-416` 只 warn）。

## 2. 目标与不做

**目标**
- G1 新用户：一个端点 + 一把 Key，探针通过，即可跑「调研 → 立意 → 写稿」。第二把钥匙（搜索）在同屏被明确告知它解锁什么、不配会怎样。
- G2 老用户：现有 `engine.json` 自动迁移，行为不变；创始人今天这份配置迁移后产品会**主动指出**「备用和主线是同一家」。
- G3 任何模型线路失败，用户在出事的那个位置看到：哪条线、哪个端点、什么类型的故障、这次产品做了什么（顶了 / 没顶）。
- G4 可选接入独立成页，每项写明解锁什么，状态可见（未配置 / 已配置 / 上次失败原因）。

**不做（明确排除，可否决）**
- 不做按岗位各配备用（一个备用端点顶全部岗位，宁强勿弱规则不变）。
- 不做端点模型自动发现（不调 `/models`），模型名仍由用户填，且每个端点至少一个（沿用 `settings-providers.ts:98`）。
- 不做后台定时探针轮询：只在启动、保存、点测试、真实调用后更新状态。
- 不做云端账号或配置同步。
- 不改 dsh 的文件式配置（仍手写 `engine.json`），只让 dsh 的 doctor 也会报病。
- 不识别同一中转的不同域名 / CNAME：同家检测只比主机名。
- 删除引擎的 `codex` **专线**（`EngineRouteName` 的 `"codex"`，零消费者）。生图链里 `kind: "codex"` 的本地 Codex CLI 通道（`image-gen.ts:168`，`settings.ts:183`）是另一回事，**不动**。**创始人确认项。**

## 3. 配置模型 v2：一张端点表，岗位指过去

### 3.1 形状

```json
{
  "version": 2,
  "providers": [
    { "id": "deepseek", "name": "DeepSeek 官方", "baseUrl": "https://api.deepseek.com",
      "apiKey": "…", "protocol": "openai", "models": ["deepseek-v4-pro", "deepseek-v4-flash"] },
    { "id": "newcli", "name": "newcli 中转", "baseUrl": "https://code.newcli.com/claude/ultra",
      "apiKey": "…", "protocol": "anthropic", "models": ["claude-opus-4-8", "claude-sonnet-5"] }
  ],
  "main":     { "provider": "deepseek", "strong": "deepseek-v4-pro", "fast": "deepseek-v4-flash" },
  "fallback": { "provider": "newcli",   "strong": "claude-opus-4-8",  "fast": "claude-sonnet-5" },
  "assignments": {
    "writer":   { "provider": "newcli", "model": "claude-opus-4-8" },
    "reviewer": { "provider": "newcli", "model": "claude-opus-4-8" }
  }
}
```

- `providers` 是**唯一**的端点表。主端点、备用、岗位、聊天切换器全部按 `id` 引用它。密钥只存一份。
- `main` 必填；`fallback` 可缺省；`assignments` 四个岗位 `writer / reviewer / scout / analytics` 全部可缺省，缺省 = `main.strong`（与今天 `resolveEngineRoute` 的 miss 语义一致，`config.ts:333`）。
- 校验（读取时）：`main.provider` 必须存在于表里且有 key，否则整份配置视为**未配置**；`fallback`/`assignments` 引用不存在的 id → 该项丢弃 + **进健康视图的 warnings**（不再只 console.warn）；`model` 不在该 provider 的 `models` 里 → 仍可用，warning 提示「模型名不在端点清单里」。
- `providers` 既有规则不变：id 小写字母数字连字符、重复 id 全部失效、baseUrl 仅 http/https 无账密、`models` 至少一个（`2026-08-19` spec §设置面，`settings-providers.ts:90-110`）。

### 3.2 迁移 v1 → v2

**读取**（`loadEngineConfig`）：无 `version` 字段即 v1，内存里迁移：
1. 顶层 `baseUrl/apiKey` → provider `main`（`name` 取主机名）。
2. 每条 route 按 `(baseUrl, apiKey)` 去重生成 provider，`id` 取主机名 slug（重复加 `-2`）；`codex` 专线丢弃并记 warning「codex 专线已停用（无任何功能使用）」。
3. `fallback` 块 → provider `fallback`（同 `(baseUrl, apiKey)` 已存在则复用），`fallback` 指针指向它。
4. 原 `providers` 数组原样并入（同 `(baseUrl, apiKey)` 已存在则复用，聊天切换器行为不变）。
5. 环境变量 `DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL` 的回退路径不变（`config.ts:384-390`）：无文件但有 env → 合成一个 provider `env`。

**写入**（`setEngineSettings`，`settings.ts:324` 重写）：今天它直接读原始 JSON、按 v1 字段增量 merge、`writeFile`（`settings.ts:352, 407`），不经过 `loadEngineConfig`。v2 改为固定四步：读原文件 → 迁移成 v2（同上函数）→ 套用提交 → **整图校验**（§3.1 全部规则 + 引用完整性）→ 写临时文件再 `rename`（0600）。第一次把 v1 文件写成 v2 之前复制一份 `engine.json.v1.bak`（存在即不覆盖）。不做 v2 → v1 反向。

**提交协议**（前端 → `settings:set`）：`providers` 整数组替换（既有）；`main`、`fallback`、`assignments` 三个对象各自**整体替换**，未提交的键保持文件现值；`fallback: null` 表示清空。密钥沿用既有规则：提交空串 = 保留该 id 已存的 key（`settings-providers.ts:110`）。校验失败整次拒绝，逐项报错，文件不动。

**`settings:get` 的 `configured`**：今天只看顶层 `apiKey`（`settings.ts:61-68`），v2 文件会被判成未配置、把老用户打回首次开机（`App.tsx:80-87`）。改为：迁移后 `main.provider` 存在且有 key（或 env 合成）即 `configured: true`。返回体加 `version`。

### 3.3 解析函数

- `resolveEngineRoute(config, role, fallbackModel)` **保留名字与返回形状** `{config, model}`（调用点把 `.config` 直接喂 `runLoop`，`generate-script.ts:718` 等 25 处不动），只在返回的 `config` 上多带 `activeProvider: {id, role}`。runLoop 从这个字段归因健康与兜底（§4.1、§4.3），调用点零改动。
- `resolveFallbackModel` 语义不变（快档→`fallback.fast`，其余→`fallback.strong`）。

### 3.4 同家检测

`fallback.provider` 的主机名与 `main.provider` 或任一 `assignments[*].provider` 相同 → warning「备用端点和写稿专线是同一家（code.newcli.com），它挂了备用一起挂」。**只比主机名，故意忽略路径**：同一中转的 `/claude/ultra` 与 `/codex/v1` 是不同服务，但整站不通时一起死，这正是要抓的情形。不同域名指向同一家（CNAME）抓不到，列入不做。

## 4. 线路报病：一个通道，一种说法

### 4.1 `engine:health` 通道

新增只读 IPC `engine:health` → `src/desktop/engine-health.ts`（新文件，< 300 行）。按既有三处登记：`channels.ts:9` 的 `IPC_CHANNELS`、`channel-contracts.ts:16` 的 `REQUIRED_FIELDS`、`ipc.ts:1187` 的 `buildIpcHandlers`。

```ts
{
  providers: [{ id, name, host,
    probe: { at, ok, ms, error? } | null,                 // 最近一次探针
    live:  { at, ok, role, jobId?, error? } | null }],    // 最近一次真实调用（只留最后一条，不是日志）
  main, fallback, assignments,                            // 解析后的指针（不含密钥）
  warnings: string[]                                      // §3.1 校验 + §3.4 同家 + 迁移丢弃项
}
```

**更新时机**（不轮询）：服务启动后异步探一遍全部 provider（不阻塞启动）；`settings:set` 保存后探被改动的 provider；设置页点「测试」；`runLoop` 每次真实调用成功/失败按 `activeProvider` 写 `live`，自动兜底时主线失败与备用成功各一条。深调研四视角并发跑（`research-perspectives.ts`），`live` 会被后到的覆盖——它是「最后已知状态」，带 `role/jobId` 足以定位，逐次记录看 run-log。

**推送**：状态变更时服务端发既有 SSE `kind: "engine"` 事件 `{type: "health"}`（`transport.ts:122` 的事件只报「变了」的既有约定），前端在收到该事件、应用加载、SSE `reconnect` 三种时机重拉 `engine:health`。内存态 + `<dataDir>/engine-health.json` 落盘，重启后先显示旧状态并标「上次」。

**doctor**：`autocrew_workflow` 的 `doctor` 加 `probe?: boolean`，schema、`executeWorkflow` 分支、`doDoctor(dataDir, {probe})` 三处打通（`workflow.ts:422, 443, 462`）。默认仍不发网络请求（dsh 契约不变）；`probe: true` 跑探针并返回与 `engine:health` **同一个视图函数**的输出，桌面与 dsh 不分叉。

**探针目标**：`settings:test_route` 的 target 从岗位名改为 `{providerId, model}`——测的是端点不是岗位，审稿专线自然可测（`settings-probe.ts:20` 白名单删除）。

### 4.2 `describeEngineFailure`：全产品唯一的翻译器

先给错误一个稳定的分类，再翻译。

- `classifyEngineError(err): { kind, status? }`，`kind ∈ connect | timeout | auth | rate_limit | upstream | protocol | aborted | unknown`，放 `pi-wire.ts`，`RetryableError` 带上 `kind`（今天 `classifyPiError` 只产 `Error/RetryableError`，`pi-wire.ts:239-257`）。
- 协议不匹配从字符串猜改为结构化：观察器把 200 非 SSE 改写成 400 时（`observer.ts:117-122`），body 写 `{"error":{"type":"protocol_mismatch","message":…}}`，分类器读 `type`。
- `describeEngineFailure({ role, provider, classified, fallbackUsed })` 放 `src/engine/failure-text.ts`，吸收 `settings-probe.ts:29-48` 的 `humanizeProbeError`：

```
「写稿专线 newcli（code.newcli.com）连不上：网络不通或域名解析失败。这次没有备用端点，写稿已中断。」
「主端点 deepseek 限流（429），已改由备用 newcli 顶完本次调用。」
「审稿专线 newcli 拒绝了 Key（401）：Key 错误或已过期，换端点没用。」
```

角色名固定：主端点、写稿专线、审稿专线、调研专线、复盘专线。

四条链路全部改走它：
- 聊天：`chat-router.ts:1649` 的 catch → `error: describeEngineFailure(...)`；前端消费 `needsSetup`（今天 `chat-router.ts:1544` 发了没人接）→ 直接跳首次开机卡。
- 写稿：`markInterrupted`（`generate-script.ts:933`）与 `run_failed` 事件（`:1017`）用它；稿卡的「生成中断」徽章 hover 显示全文。
- 深调研：视角失败原因 `engine_failed` 的，聚合时若失败视角**全部**是引擎错误，`failReason` 改为线路描述，`errorCode` 仍保留 `too_few_perspectives` 供机器判断（`deep-research.ts:451`）。
- 探针：原样。

### 4.3 出事的地方看得见

**数据从哪来**：`LoopEvent.fallback` 扩为 `{from, to, fromProvider, toProvider, role, error}`；`LoopResult` 加 `usedFallback?: {role, from, to, error}`（`loop.ts:27, 74`）。写稿（`generate-script.ts`）与调研（`deep-research.ts`、`angle-stage.ts`）从 `LoopResult` 取出，写进 `Content.usedFallback`（`local-store.ts:211` 附近，与 `usedAngle/usedBriefHash` 同级）与 `ResearchJob.usedFallback`（`research-job-store.ts:42`）。

- **顶栏横幅**（前端派生自 `engine:health`，无新状态）：任一被引用的 provider 最近状态为坏 → 「写稿专线 newcli 连不上（3 分钟前）。下次写稿将由备用 DeepSeek 顶上 / 没有备用端点，写稿会失败」+「去设置」。恢复（探针或真实调用成功）自动消失。
- **稿卡**：`usedFallback` 存在 → 徽章「备用顶上」，hover 显示主线失败原因。
- **调研任务卡**：同上。
- **设置 · 模型**：每个端点一枚状态点（未测 / 通 · 1.5s / 坏 · 原因），来自同一通道。

## 5. 设置面：三层

### 5.1 首次开机（`Onboarding.tsx` 重写）

一张卡：
1. 端点：单选「DeepSeek 官方」（默认，模型预填 v4-pro / v4-flash）/「Claude 中转」（填地址，模型预填 opus-4-8 / sonnet-5）/「其他 OpenAI 兼容」（地址 + 强快模型必填）。
2. Key。
3. 搜索 Key（博查 / Tavily）**同屏、标注可选**，一句话：「不填也能写，但深调研不可用、稿子不会补证据」。
4. 按钮「测试并进入」：探针不通 → 显示 `describeEngineFailure` 文案 + 次级按钮「先进去再说」（不锁门，进去后横幅接手）。

**写盘顺序与失败语义**：先 `settings:set`（`providers[0]` + `main`），成功后才 `settings:search_set`。搜索保存失败**不回滚引擎**，照样进入，卡上留一行「搜索 Key 没保存成功：原因」，「接入更多」的搜索卡状态同步显示；引擎保存失败则停在本卡报错。

### 5.2 设置 · 模型（`SettingsEngine.tsx` 重写）

- **端点表**：名称 / 地址 / Key / 模型清单 / 状态点 / 测试 / 删除。删除被 `main`、`fallback` 或任一岗位引用的端点 → 拒绝并列出引用者。
- **主端点**：选端点 + 强/快模型下拉（来自该端点 `models`，允许手填）。
- **备用端点**：选端点（含「无」）+ 强/快；同家 → 行内 warning。
- **岗位分配**（折叠，默认收起，标题显示「4 个岗位全部跟随主端点」或「写稿、审稿 → newcli」）：四行，每行「跟随主端点」或选端点 + 模型。审稿有行了；codex 没了。
- 「打开配置文件」保留。

### 5.3 接入更多（设置页第二个标签，不加路由）

前端 `Route` 只有 `{view:"settings"}`（`App.tsx:28-40`），不新增路由：`Route` 加 `tab?: "models" | "integrations"`，设置页顶部两个标签「模型」「接入更多」，工作区与知识库留在「模型」标签下方。各接入的状态加载仍归 `Settings.tsx`，只是拆成 `Integrations.tsx` 子组件。

每项一张卡，固定三段：**解锁什么 · 不配会怎样 · 状态**（未配置 / 已配置 / 上次失败：原因 + 时间）。

| 接入 | 解锁 | 不配会怎样（今天的真实行为，改成可见） |
|---|---|---|
| 搜索（博查/Tavily） | 深调研取证、写稿定向补证 | 深调研按钮置灰带说明；稿卡出「未补证」徽章（今天只 console warn，`generate-script.ts:413`） |
| 情报源（X / Reddit / Gemini） | 雷达对应源 | 卡上显示该源上次失败原因（今天只 console，`radar-cycle.ts:64`）；源开关与 Key 同卡 |
| 公众号发布 | 推草稿箱 | 发布面板对应动作置灰带说明 |
| 生图 / 封面 | 正文配图、封面 | 同上（今天已是显式错误，`cover-handlers.ts:41`） |
| Telegram 收件箱 | 手机投灵感 | 中性状态（今天已是，`inbox-doctor.ts:18`） |

### 5.4 README

「配置模型」一节重写为 v2 形状；示例不再把四条专线指向同一家；「备用模型」一节改为「备用端点」并写明同家检测。

## 6. dsh

- `adapters/dsh/README.md`「配」表：`engine.json` 示例改 v2 形状（v1 仍可读）。
- `autocrew_workflow doctor` 文档补 `probe: true`。
- 总编辑人设（`agent.cordis.yml`）加一句：调用失败时先跑 `doctor {probe:true}` 再回答用户是哪条线坏，不复述原始错误。
- 就绪日志（`adapters/dsh/src/index.ts:47-66`）不变：仍只查存在性。

## 7. 边界（product-sense 五问，即验收清单）

**状态**
- 无 `engine.json` 且无 env → 首次开机卡；v1 文件 → 内存迁移 + 首次保存写 v2 + 备份；`main.provider` 指向不存在的 id 或无 key → 视为未配置进首次开机，横幅说明原因。
- 探针未跑过 → 状态点「未测」，不是「坏」。
- 全部端点都坏 → 错误文案明说「主端点与备用都连不上」，不再重试备用（`loop.ts:225` 语义不变）。
- 健康文件缺失/损坏 → 当作没探过，不报错。

**最坏输入**
- 地址带路径/查询串/账密、Key 前后空白、重复 id、`models` 为空、超长 `models` 列表：沿用 providers 既有校验，整次提交拒绝并逐项报。
- 协议填错（openai 端点填 anthropic）：探针拿到观察器结构化 400 → 文案「协议不匹配，试试切换协议」。
- 主线与备用同家：允许保存，warning 常驻。
- 两个前端标签页同时保存：后到的整图校验仍成立就覆盖（既有语义），不做乐观锁。

**防呆**
- 「测试」同一端点同一时刻只允许一次在飞，按钮置灰。
- 探针进行中保存 → 保存生效，旧探针结果作废重探。
- 删除主端点：禁止；删除被引用端点：禁止并列出引用者。
- 首次开机探针失败仍可进入：故意，横幅接手。
- 表单留空 = 保持现状（设置页既有契约，`settings-kit.tsx`）。

**失败可见**
- §4.2 四条链路无一处返回原始 `fetch failed`；§5.3 五个接入无一处只写 console。
- 兜底发生必在稿卡/任务卡留痕（数据来源 §4.3 第一段）。
- 迁移丢弃的 codex 专线、无效引用：进 warnings，设置页顶部显示一次，可关闭（关闭状态存前端，不存文件）。

**明确不处理**：见 §2「不做」。

## 8. 分片与验收

| 片 | 内容 | 验收证据 |
|---|---|---|
| P2a-1 配置 | §3 配置 v2 + 读取迁移 + 写入四步 + 提交协议 + `configured` 判据 + `activeProvider` + 同家检测；探针目标改 provider | 迁移单测：创始人今天这份 v1（脱敏）→ v2 后 writer/reviewer/fallback 三指针指同一 provider 且 warnings 含同家；v1 文件在 `settings:set` 后变 v2 且 `.v1.bak` 存在；老 v2 用户 `settings:get.configured === true`；全量测试绿 |
| P2a-2 报病 | §4.1 健康通道 + SSE 推送 + doctor probe；§4.2 分类器 + 翻译器接四条链路；§4.3 LoopEvent/LoopResult 扩展与落盘 | 四条链路各一条测试断言错误文案含角色名与主机名、不含 `fetch failed` 原文；模拟主线失败备用成功 → `Content.usedFallback` 存在；dsh 里 `doctor {probe:true}` 对坏端点返回健康视图 |
| P2b 界面 | §5.1 首次开机、§5.2 模型页、§4.3 横幅与徽章、§5.3 接入更多标签 | 隔离 dataDir 真机：空目录开机 → 只填 DeepSeek Key → 测试通过 → 跑一个选题到出稿；把 writer 指向不存在的域名 → 写稿失败处显示「写稿专线 … 连不上」+ 横幅；配备用后同一操作 → 稿卡「备用顶上」 |
| P2c 外围 | §5.4 README、§6 dsh 文档与人设 | README 示例能直接落盘启动；dsh 总编辑遇到坏端点先 doctor 再答 |

顺序 P2a-1 → P2a-2 → P2b → P2c，每片单独可合。每片按创始人惯例：opus 子代理实现，主循环集成验证，codex 停机门审（注意：本机 codex CLI 0.145 不认默认模型 `gpt-6-astra`，需指定 `-m gpt-5.5` 或升级 CLI，否则门是空转的）。

## 9. 创始人确认项（2026-09-05 三项全部同意）

1. 删引擎的 `codex` 专线（零消费者；生图的 Codex 通道不动）。
2. 首次开机探针失败允许进入（不锁门）。
3. 搜索 Key 放首次开机同屏（可选）而不是只在「接入更多」。

## 10. codex 评审处置表（2026-09-05，gpt-5.5，13 条）

| # | 级别 | 发现 | 处置 |
|---|---|---|---|
| 1 | P1 | `resolveEngineRoute` 返回 `{config, model}`，调用点直接喂 runLoop，改形状不是「只改导入」 | 采纳：保留名字与形状，只在 config 上加 `activeProvider`，调用点零改动（§3.3）；P2a 拆成两片（§8） |
| 2 | P1 | 新 IPC 要登记三处；SSE 无 health 事件，禁轮询却没说怎么推 | 采纳：三处登记写明；用既有 `engine` SSE 事件报「变了」，前端三时机重拉（§4.1） |
| 3 | P1 | `settings:get.configured` 只看顶层 apiKey，v2 用户会被打回首次开机 | 采纳：判据改为迁移后 `main` 有效（§3.2） |
| 4 | P1 | `setEngineSettings` 直接 raw merge + writeFile，无迁移/备份/原子写 | 采纳：写入四步 + 临时文件 rename + 提交协议 + 一次性备份（§3.2） |
| 5 | P1 | `LoopEvent.fallback` 只有模型名，`LoopResult` 无兜底信息，留痕字段没有数据来源 | 采纳：扩 `LoopEvent`、加 `LoopResult.usedFallback`，写明落盘路径（§4.3） |
| 6 | P2 | 错误分类不存在，「协议不匹配」靠字符串猜 | 采纳：`classifyEngineError` + `RetryableError.kind` + 观察器结构化 400 body（§4.2） |
| 7 | P2 | 「models 为空允许保存」与既有规则矛盾 | 采纳：删掉该边界，`models` 至少一个（§2、§7） |
| 8 | P2 | reviewer 不在探针白名单、设置页无行 | 采纳：探针改按 provider 测，岗位表加审稿行（§4.1、§5.2） |
| 9 | P2 | `doctor {probe}` 没有参数通路 | 采纳：schema / executeWorkflow / doDoctor 三处打通（§4.1） |
| 10 | P2 | 首次开机写两个文件缺顺序与部分失败语义 | 采纳：先引擎后搜索，搜索失败不回滚、可见（§5.1） |
| 11 | P2 | 删 codex 专线可能误伤生图的 `kind:"codex"` 通道 | 采纳：限定为 `EngineRouteName`，生图通道明确不动（§2、§9） |
| 12 | P3 | 同家按 host 有误报（同 host 不同 path）与漏报（CNAME） | 部分采纳：同 host 视为同家是**故意**（整站一起死正是要抓的）；CNAME 列入不做（§3.4） |
| 13 | P3 | `Integrations.tsx` 缺路由/导航设计 | 采纳：不加路由，设置页两个标签（§5.3） |
