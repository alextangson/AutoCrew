# 文案→成片：AI 视频生产线 · 调研报告

日期：2026-07-26 ｜ 状态：调研完成，待创始人裁决后出设计 spec（spec 定稿前送 codex 评审）｜ 关联：PRD-v4 §10-C（拟推翻）、video-kit、deep-research spec、inspiration-inbox spec

调研方式：五路并行（仓库现状 / AI 视频生成模型 / 剪辑组装框架 / 音色克隆 TTS / 抖音内容形式与政策），全部以 2026-07 联网信息为准，关键来源见 §10。

## 0. 结论速览

1. **上一版失败有结构性原因，不是执行问题**：无人物、无叙事、模板感强的图文拼接正是抖音 2025-04《恶意营销号治理规范》"低质同质化"打击画像的中心，也是完播率模型天然歧视的形态。放弃是对的，不要复活。
2. **新形态定为「AI 知识可视化叙事」**：强文案 → 统一美术风格的 AI 生成画面 → 克隆音色配音 → 固定虚拟 IP。这是唯一同时吃到我们文案优势、平台扶持方向（知识人文 AI 作品一年增长 20 倍、官方话题超 10 亿播放）、单人全自动可行（标杆 @孩子的一棠课：月算力六七百元、3 个月 0→170 万粉）的形态。
3. **管线五层，每层可独立替换，`timeline JSON` 是稳定接口**：
   `文案 → 分镜（LLM）→ 素材层（国产视频模型 API）→ 音频层（豆包声音复刻，自带词级时间戳）→ 合成层（Remotion 确定性渲染）→ 成片 + AI 标注`
4. **素材层主力放国内可 RMB 直连的四家**：火山 Seedance（¥0.95/秒@720p）、可灵 3.0（画面内中文文字唯一靠谱）、阿里百炼万相 Flash 档、Vidu（错峰半价）。全球质量第一梯队恰好就是这几家，合规不牺牲画质。Sora 产品线在关停（API 2026-09-24 停服），不接。
5. **音频层首选火山豆包声音复刻 2.0**：5 秒克隆创始人音色，音色 150 元/年，一条 60s 配音约 ¥0.2，**一次请求同时返回音频 + 词级时间戳**——动态字幕对齐零额外组件。开源备选 Qwen3-TTS / dots.tts（均 Apache-2.0，Mac MLX 可跑）。
6. **合成层选 Remotion，但 LLM 不写渲染代码**：LLM 产出语义 timeline JSON（动效字段是受控枚举），zod 校验后由人写好的组件库确定性渲染。"coding agent + 确定性渲染引擎"是 2026 年行业主流路线（Remotion 官方 2026-01 发布 Agent Skills）。剪映降级为逃生口（草稿生成仍兼容，自动导出 macOS 不可行）。
7. **成本**：每条 60-90s 成片素材 ¥40-100（合规档）+ 配音 ¥0.2 + 本地渲染 ≈0。月更 30 条 ≈ ¥1500-3000，与标杆账号成本量级一致。
8. **合规红线只有一条真死线**：2025-09-01 起 AI 内容强制标注。主动标注不影响流量（2026 年 1-4 月抖音 105 条百万赞 AI 爆款全部主动标注），漏标被补标才降权。克隆自己音色 + 标注 = 合规。

## 1. 上一版为什么失败（死因确诊）

旧方案（v0.3.x tag，当前分支已切掉）：HTML 知识卡片模板 → Puppeteer 截图 → 与 B-roll/TTS 进 ffmpeg 合成 + 剪映工程导出。三重死因：

| 死因 | 证据 |
|---|---|
| 形态撞上治理靶心 | 抖音 2025-04-28《恶意营销号治理规范》点名"预设模板、批量炮制画面高度相似的同质化视频"，配健康分阶梯处罚；模板化图文拼接正中画像 |
| 完播率模型歧视 | 无人物、无叙事的静态卡片翻页，完播天然低；近亲形态（息屏文学/白底大字）2025 后查无持续爆款 |
| 工程半成品 | 旧 `FFmpegCompositor` 核心逻辑带 TODO 未完成（所有输入都从 t=0 开始）；自动化链路从未真正闭合 |

结论：**方向性放弃 HTML 截图拼接路线**。旧资产中仍有价值的部分见 §4.4。

## 2. 内容形态：做什么样的视频

### 2.1 六形式盘点（2025-2026 抖音真实表现）

| 优先级 | 形式 | 判断 |
|---|---|---|
| **P0** | AI 知识可视化叙事（文案→AI 画面→克隆配音→固定虚拟 IP） | 官方顺风口：抖音"知识创作砥砺计划"+"AI 新星计划"扶持；小红书 2026-04《AI 治理主张》明确鼓励"将复杂知识可视化的 AI 知识科普"。天花板已被 170 万粉账号验证 |
| P1 | 数字人口播（克隆形象/音色 + 混剪包装） | 不禁止但公域起号难：绿幕念稿完播极低；适合做转化承接与"量产分身"，不适合冲流量主力。做就必须"数字人+图表+素材混剪"多景别 |
| P2 | 真人出镜 + AI 全自动后期 | 流量上限最高（新榜：百万赞爆款里"真人+AI"是绝对主流），但真人录制是自动化瓶颈；可作"每周集中录一批素材"的 AB 对照线 |
| P3 | AI 配音 + 素材混剪（无人物） | 只作降级兜底：易滑入低质批量画像，查无靠此起号的头部知识 IP |
| P4 | 纯 AI 短剧叙事 | 平台砸钱扶持（抖快约 8 亿流量补贴）但与知识/观点文案错配，抽卡成本高，不做 |
| 弃 | 图文动效快剪、AI 玄学 | 前者已验证失败（§1）；后者被清朗行动点名，结构性死路 |

### 2.2 P0 形态拆解（对标 @孩子的一棠课）

- 文案是灵魂，画面"重表达不重特效"：统一白描/水墨/胶片类美术风格，AI 图生视频产镜头，不追写实。
- **固定虚拟讲述者 = 账号资产**：固定人设 + 固定美术风格 prompt 库 + 固定克隆音色。角色一致性靠多参考图能力（Seedance 2.5 支持 50 个多模态参考、万相参考生视频）。
- 单条结构：3 秒钩子（koubo 包已有 completion5s 权重与 `[画面]+[口播]+[字幕条]` 纪律）→ 叙事主体（5-15 秒镜头 × 6-10 个）→ 收尾引导。
- 首发抖音，同步小红书（其 AI 知识科普是官方明文鼓励方向；但小红书对"全 AI 托管账号"直接封禁——发布环节必须保留人工确认，正好与 PRD-v4 发布分级一致）。

### 2.3 政策硬约束（做进产品，不是贴在墙上）

- **必须**：发布时勾选 AI 声明（显式标识）；平台自动写隐式元数据标识。发布 runbook 加一条硬检查项。合成语音、数字人都在必标范围。
- **禁止**：裁角标/清洗元数据（= "引导规避标注"，2025-05-19 专项公告点名）；同一文案/画面/音色多账号批量同发（指纹碰撞连坐）；克隆未授权他人声音/形象；提示词引用真人名人/影视 IP（Seedance 好莱坞侵权函是前车之鉴）。
- **变现设计**：抖音对 AI 内容播放分成极低（有 800 万播放 50 元的实例），从一开始就按商单/私域/知识付费设计，不追平台分成。

## 3. 生产管线五层选型

### 3.1 素材生成层（AI 视频模型）

2026-07 格局：Sora 关停中（API 9 月停服）；竞技场第一梯队 = Google（Veo 3.1 / Gemini Omni Flash）+ 中国系（Seedance 2.0/2.5、可灵 3.0、阿里 HappyHorse）。Runway/Luma 边缘化。开源最强（LTX-2.3）与闭源差 120-200 Elo，肉眼可感——**追求高级感不走开源自建主路**。

**默认组合（国内直连、RMB、已备案）**：

| 模型 | 用途 | 价格 | 备注 |
|---|---|---|---|
| 火山 Seedance 2.0/2.5 | 叙事主力：图生视频、多模态参考、30 秒长镜头 | ¥0.95/秒@720p，带参考 ¥0.57/秒 | 中文提示词理解第一；画面内长中文会乱码 |
| 可灵 3.0 开放平台 | 带字镜头与 4K 门面 | ¥0.6-1.2/秒 | **画面内中文文字唯一实测过关**的一家 |
| 阿里百炼 万相 2.6/2.7 Flash | 批量便宜镜头、参考生视频角色一致 | 约 ¥0.2-0.4/秒 | 2.5 之后 API-only，开源版停在 2.2 |
| Vidu 开放平台 | 错峰批量、对口型 | 错峰半价，≈¥0.03-0.05/秒级 | 动漫/角色一致强项 |

补充：质量补充经 fal.ai 调 HappyHorse 1.1（$0.18/秒@1080p，2026 黑马）；数字人口播用火山即梦 OmniHuman 1.5（2026 横评口型第一）；海外模型（Veo 3.1）仅在有海外结算时做质感补充。深折扣国内中转只用于测试，不进生产线。

**工艺路线**：图生视频为主——先用生图（已有 relay `gpt-image-2` 通道，或即梦 Seedream）按风格 prompt 库出首帧，再 i2v。风格一致性、成本、可控性都优于纯文生视频。

### 3.2 音频层（音色克隆 + 时间戳 + 节奏）

**主路线：火山引擎豆包声音复刻 2.0**
- 5 秒样本克隆（录授权声明留证），音色 150 元/年；合成 6.5 元/万字符 → 一条 60s（约 300 字）≈ ¥0.2。
- **决定性优势：异步长文本接口一次返回音频 + `sentences[].words[]` 词级时间戳**——配音与动态字幕对齐一个请求解决，TypeScript 纯 HTTP 可封装（`openspeech.bytedance.com/api/v3/tts/*`）。
- 指令控语速/情绪；抖音同源技术，中文口播自然度第一梯队。
- 注意：2.0 系时间戳参数是 `audio_params.enable_subtitle`（1.0 系的 `enable_timestamp` 不通用，传错静默忽略）。

**备选**：MiniMax speech-2.8（文本内 `<#x#>` 精确停顿标记最顺手，但只有句级字幕，需 FunASR 补对齐）；ElevenLabs v3（2026-02 GA，字符级时间戳，需外币卡）。

**开源自部署（可控性路线，Mac 可跑）**：Qwen3-TTS-1.7B（2026-01 开源，Apache-2.0，3 秒克隆，mlx-audio 官方支持）；音质天花板 dots.tts-soar（小红书 2026-06 开源，48kHz，Apache-2.0，社区 MLX 移植）；"最像自己"走 GPT-SoVITS v2Pro 用 1 分钟干声微调（MIT，Mac 原生支持）。**避坑**：F5-TTS（CC-BY-NC）、Spark-TTS（改 NC）、MegaTTS3（不能自助克隆）、Fish S2-Pro（商用要买授权）、IndexTTS2（时长控制论文级最强但权重商用需 B 站书面授权，且 duration 接口开源版未启用）。

**时间戳与对齐**：走火山则零额外组件；走开源/MiniMax 则用 FunASR Paraformer（fa-zh 时间戳模型，原生字级 `[start_ms,end_ms]`，中文精度优于 WhisperX，Mac CPU 可跑）做强制对齐 sidecar。工程要点：TTS 前做数字规范化（"2026"→"二零二六"），否则对齐必翻车。

**节奏卡点（业界实际做法，逐级递进）**：
1. 逐句生成 → 拿真实时长 → 在 BGM 节拍网格上摆放，句间静音补齐到下一拍；
2. 拍点用 librosa `beat_track` 起步（有 20-60ms 系统性偏晚，加人工偏移校正），进阶 BeatNet（可出重拍，只卡重拍更自然）；
3. 句子略超槽位用 `ffmpeg atempo` ±5% 无感伸缩，再大就重新生成而不是硬拉；
4. 字幕入场帧绑定词级时间戳，snap 到拍点。

### 3.3 合成渲染层（Remotion + timeline JSON）

**选型：Remotion v4（2026-07 仍日更，46k stars）**。理由：TS 同栈；Apple Silicon 本地渲染（30-90s 竖屏片分钟级）；动效上限 = React/Canvas/WebGL 上不封顶；`@remotion/captions` 原生逐词字幕（`createTikTokStyleCaptions`）；**官方 AI 工具链全行业最成熟**（system prompt / llms.txt / 2026-01 发布 Agent Skills，`npx skills add remotion-dev/skills`）。

**License（要盯的一条）**：个人/≤3 人公司免费含商用。≥4 人后自动化管线按 Automators 计费（$0.01/render，最低 $100/月）。当前阶段免费；**团队到 4 人是触发点**，届时评估付费或切 HyperFrames（HeyGen 2026-04 开源，Apache 2.0 无任何门槛，HTML/CSS 路线真渲染成片、非截图拼帧，生态较浅是唯一短板）。

**核心架构纪律：LLM 不写渲染代码**。
- LLM 产出**语义 timeline JSON**：多轨（视频/字幕/配音/BGM）、clip 带入出点、动效字段是**受控枚举**（`subtitleStyle: "bounce-word"`、`transition: "whip-pan"`、`beatSync: true`）；
- 每个枚举对应一个人写好的 Remotion 组件，zod 校验 → 确定性渲染；LLM 管创意参数，渲染确定性由模板库保证；
- 新动效模板用 Claude Code + Remotion Skills 开发，**进库后才进生产**——动效库随迭代增长，这就是"迭代快"的落点；
- 骨架参考 Shotstack/阿里云 ICE 的 timeline→tracks→clips，动效表达参考 Creatomate 的语义动画名，schema 带版本号（OTIO 式）便于迁移。
- 中文字体：字体文件放 `public/` 走 `@remotion/fonts` 的 `loadFont()`（阻塞渲染防豆腐块），CJK 必须子集化。

**值得抄管线设计的开源项目**（不直接用，它们的渲染层都是 moviepy 档次）：NarratoAI（六阶段中间 JSON + 回填真实时长 + TTS word-boundary 字幕）、MoneyPrinterTurbo（99k stars；素材去重、最终拼接用 ffmpeg concat demuxer 防画质劣化）、FunClip（ASR 全文→LLM 选段范式，处理外部素材时用）、OpusClip Agent Opus（子 agent 分工 + 中间产物逐层校验）。

### 3.4 字幕

正文字幕一律 Remotion 程序化压制（模型内文字不可靠）；画面内装饰性文字（标题卡/招牌）才交给可灵 3.0 或"带字图→图生视频"。字幕时间戳来源见 §3.2——自产文案场景**不需要 ASR**。

### 3.5 剪映：逃生口，不是主干

pyJianYingDraft 生成新草稿在新版剪映仍可用，但读取模板草稿（6+ 加密）与自动批量导出（仅 Windows + 剪映 ≤6）都不行，macOS 无自动导出。定位：**需要人工精修的片子从 timeline JSON 转一份剪映草稿**，人在剪映里改和导出；自动链路不经过剪映。旧仓库的剪映导出器（v0.3.10 `packages/studio/.../jianying/`）可作起点。

## 4. 推荐架构：接进 autocrew

### 4.1 数据流

```
Content(approved) ──手动/chat 触发──▶ 视频构建 job（持久化五态 + lease + SSE，照抄 deep-research spec §2）
  → 分镜升格：videoKit.storyboard → timeline JSON 草案（LLM，受控枚举 + zod）
  → 素材阶段：每镜头 首帧生图 → i2v（并行，asset 状态机 pending→generating→ready→confirmed）
  → 音频阶段：克隆 TTS 逐句合成（词级时间戳随返）→ BGM 选择 + 拍点检测
  → 对轨：TTS 时长为单一时间锚，视频片段截尾/慢放/loop 对齐（容差 0.5s，沿旧设计）
  → 渲染：Remotion 本地渲染 → contents/<id>/assets/final.mp4 + 封面 + 字幕文件
  → 审片：素材面板逐镜头预览/重抽/换 prompt（复用 article-images 交互范式）
  → 发布件：videoKit 既有 caption/标题 + 「勾选 AI 声明」硬提示 → 剪贴板发布流程
```

### 4.2 接入点（照 §5 仓库惯例，六处）

1. **数据**：`Content.videoBuild?: VideoBuild`（与 `videoKit?` 平级）；产物落 `contents/<id>/assets/`（`Asset.type` 已支持 video/audio/subtitle，schema 零改动）；timeline JSON 落 content 目录、版本化。
2. **执行**：持久 job + `claimedAt` lease + 启动回收 + SSE 进度，样板 `src/desktop/inbox-runtime.ts`；所有入口投递即返回，绝不阻塞聊天。
3. **Key**：新建 `<dataDir>/video.json`（火山/可灵/百炼/Vidu 各 key + 音色 ID），走 settings 掩码 + 掩码回传守恒 + 变更热重启三件套（justoneapi 样板）；缺 key = blocked 态 + 人话指引，不静默降级。
4. **IPC**：`video:build` / `video:status` / `video:assets` / `video:settings_get/set` + SSE `video:updated`，三处登记（channels / channel-contracts / ipc）。
5. **chat 工具**：`build_video`，角色标签 `editor`（剪辑师）——呼应 PRD-v4 §4.2 预留编制。
6. **计时**：`Content.videoReadyAt` 新戳，`production-timing.ts` 三段扩四段（纯函数，改动约 10 行）。

**分包纪律（红线）**：remotion/ffmpeg 等重依赖绝不进主 package.json（当前生产依赖仅 4 个）。渲染器独立 workspace（如 `render/`，参照 frontend/ 先例），主进程经子进程/CLI 调用；未安装渲染包 = 可见的 `not_configured` 状态。

**外部 API 封装**：照 `justoneapi.ts` 范本——baseUrl/timeout/fetchImpl 注入、业务码三态映射表导出供测试、错误消息不回显带 token 的 URL。视频生成是分钟级异步任务，封装层要带轮询 + 任务 ID 持久化（进程重启后可续查，不重复扣费）。

### 4.3 旧方案复用/不复用

**复用**：timeline 数据模型思想（TTS 单一时间锚、visual 挂 `linkedTts[]`、asset 五态机——`git show v0.3.10:src/types/timeline.ts`）；时长对齐策略（截尾/0.7x 慢放/loop、容差 0.5s）；剪映导出器（逃生口）；打标→人工确认的产品形态。
**不复用**：HTML 卡片截图路线（死因见 §1）、半成品 FFmpegCompositor、豆包旧 TTS provider、MiMo 视频拆解线（已被 justoneapi + pattern-store 替代）。

### 4.4 IP 资产层（新概念，账号的护城河）

`<dataDir>/video-identity.json`：美术风格 prompt 库（带负面词）、虚拟讲述者参考图集（多角度）、克隆音色 ID、BGM 曲库偏好、动效模板偏好。所有生成环节从这里取锚——**换一个账号 = 换一份 identity 文件**，天然支持未来矩阵而不触发同质化判定（画面/音色/文案三指纹都不同）。

### 4.5 与数据飞轮闭环

发布后完播率/5s 完播（CSV + 扩展双通道已通）→ retro 归因到 timeline 特征（钩子镜头类型、节奏密度、字幕样式）→ 反馈进分镜 prompt 与动效模板选择。pattern cards（对标拆解）已注入写稿，V2 起同样注入分镜生成。

## 5. 分期路线

**V0 · 走通一条片（walking skeleton）**
文案 → LLM 升格 storyboard 为 timeline JSON → 每镜头首帧生图 + Seedance i2v（3-5 镜头）→ 豆包复刻配音（先用预置音色验证链路，克隆音色随后）→ 1 套 Remotion 模板（含逐词字幕）→ 本地渲染成片 → 人工审片 → 剪贴板发布 + AI 声明提示。
验收：一条真实成片发上抖音；全链路失败可见（每阶段独立可重试）；成本 ≤¥100/条。

**V1 · 质感与节奏**
创始人音色克隆（5 秒样本 + 授权声明）；动效字幕组件库扩到 3-5 种受控枚举；BGM 拍点检测 + 句级卡点；素材面板（逐镜头预览/重抽/换 prompt/上传替换，复用 article-images 范式）；可灵接入（带字镜头）；剪映草稿逃生口。
验收：盲测配音"AI 味"可接受；卡点视觉上成立；单条人工干预 <10 分钟。

**V2 · 学习与规模**
对标学习驱动：pattern cards 注入分镜生成，justoneapi 时长/结构数据参与节奏决策；数据回喂（完播率 → timeline 特征归因）；IP 资产层多账号支持；数字人口播席（OmniHuman）作转化承接；托管定时（挂 campaign workflow-engine）。

每期迭代点都收敛在两个可替换位：**素材层换模型**（timeline JSON 不动）、**合成层加模板**（枚举扩充）——这就是"相对灵活的模块"的具体含义。

## 6. 成本估算（60-90s 单条）

| 项 | 默认合规档 | 批量压缩档 |
|---|---|---|
| 素材（含抽卡 ~2:1） | ¥40-100 | ¥20-70（万相 Flash/Vidu 错峰/海螺为主） |
| 配音 | ¥0.2 + 音色年费 150 | 同左（或开源 Mac 本地 ≈0） |
| 渲染 | 本地 ≈0（Remotion ≤3 人免费） | 同左 |
| 合计月更 30 条 | **≈¥1500-3000** | ≈¥600-2000 |

## 7. 裁决点（待创始人确认）

- **A. 推翻 PRD-v4 §10-C**（"剪辑师 v4 不入职、装配单 MVP 亦不做"）：本报告的一切以此为前提。连带修订 IA v5 §46（"成片是用户的活"）；platform-risk-reviews 的"B 级预填暂缓至视频链就绪"在成片落地后自动满足前置。
- **B. 形态**：P0 = AI 知识可视化叙事；是否并行 P2（每周真人录一批素材做 AB）——推荐做，数据上限最高，但增加真人时间成本。
- **C. 素材预算档**：默认合规档（¥40-100/条）起步，验证后再压成本。
- **D. 音频路线**：豆包复刻 2.0 起步（省事 + 时间戳白送）；开源自部署留作 V1 后的可控性升级，不在 V0 做两套。
- **E. Remotion license**：当前免费；团队到 4 人是商务触发点（届时 $100/月 或切 HyperFrames）。

## 8. 风险与红线

1. **标注红线**：发布必勾 AI 声明；绝不裁角标/洗元数据。发布 runbook 加硬检查项。
2. **同质化连坐**：多账号绝不同素材同音色同发；IP 资产层按账号隔离。
3. **提示词 IP 风险**：分镜 prompt 过滤真人名人/影视 IP 词（Seedance 侵权函前车之鉴）；素材生成日志留存备查。
4. **模型价格/存续波动**：Sora 关停、即梦 2026-04 涨价都发生在半年内——timeline JSON 与素材层解耦就是对冲；video.json 支持多供应商 key 并存。
5. **剪映草稿脆弱**：字节改版即碎，只做逃生口不做依赖。
6. **平台分成幻觉**：AI 内容播放分成极低，变现按商单/私域/知识付费设计。
7. **渲染依赖膨胀**：重依赖锁在独立 workspace，主仓库 4 依赖纪律不破。

## 9. 明确不做

- 全自动发布（维持 PRD-v4 发布分级：人亲手点发布）
- 剪映自动导出（macOS 不可行）与剪映模板草稿读取（6+ 加密）
- 对标视频下载/ASR 拆解（走回头路；沿 inbox spec 排除项）
- 纯 AI 短剧、图文快剪复活、AI 玄学
- 开源视频模型自建 GPU 集群（质量差 120-200 Elo，不值）
- V0 做双 TTS 路线（一套跑通再谈备份）

## 10. 来源索引（关键）

- 标识办法与执行：cac.gov.cn《人工智能生成合成内容标识办法》2025-03-14（09-01 施行）；抖音升级 AI 标识公告 2025-09-01（stcn.com）；抖音"AI 起号"治理 2025-05-19（sina）；恶意营销号规范 2025-04-28（qq.com）；小红书《AI 治理主张》2026-04-27（ithome）
- 形式与案例：新榜/投资界《扒了上百条 AI 爆款视频》2026-04-30（pedaily）；新榜《超 10 亿次播放，用 AI 打开人文经典》2026-07-24（newrank，@孩子的一棠课）；新榜对话混子哥 2025-08-18
- 模型与价格：火山 Seedance 定价 2026-04（volcengine.com/article/42387）；可灵 3.0（快手 IR 2026-02、klingai.com/dev/pricing）；HappyHorse（Bloomberg/CNBC 2026-04-10、fal.ai）；Sora 停服（laozhang.ai/costgoat 2026-07）；Veo 定价（ai.google.dev）；竞技场排名（artificialanalysis.ai 2026-07 快照）
- 合成层：Remotion license（remotion.pro/license）与 Agent Skills 2026-01（remotion.dev/docs/ai）；HyperFrames（hyperframes.video，2026-04 开源）；pyJianYingDraft 现状（github.com/GuanYixuan/pyJianYingDraft）；NarratoAI / MoneyPrinterTurbo（GitHub，2026-07 仍活跃）
- 音频层：豆包声音复刻（volcengine.com/docs/6561/1359370，词级时间戳社区实测）；Qwen3-TTS 2026-01-22（github.com/QwenLM/Qwen3-TTS）；dots.tts 2026-06（github.com/rednote-hilab/dots.tts）；IndexTTS2 许可与 duration 未启用（github.com/index-tts/index-tts）；FunASR 时间戳（funasr.com）
- 仓库内：旧视频管线 `git show v0.3.10:docs/plans/2026-04-03-video-pipeline-design.md`；分镜 `src/modules/publish/video-kit.ts`；执行样板 `src/desktop/inbox-runtime.ts`；deep-research spec §2（job 模型）
