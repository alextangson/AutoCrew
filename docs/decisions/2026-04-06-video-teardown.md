# 功能决策：Video Teardown（视频拆解）

## 结论
**做。** 新建 video-teardown skill，通过可插拔采集器获取视频 → MiMo-V2-Omni API 全模态分析 → 结构化拆解报告 → intel ingest 写入 pipeline → 自动触发 knowledge-sync。填补 Level 3 质量层模态缺口。

## 提案原始描述
用户希望增加 Omni 视频拆解模型：用户发送对标账号的视频链接或文件，Omni 自动分析视频的优缺点、可借鉴的地方，形成索引，后续持续关注，也能找到 reference 供创作引用。用户补充：输入可以是视频链接、视频文件、账号链接（含多个视频）。

## 分析过程

### 🔍 苏格拉底提问 — 本质问题
- 根本问题：创作者学习对标账号的过程是手工的、碎片的、只能触及文案层的。缺少一个自动化的、多维度的（文案+画面+剪辑+节奏）视频拆解能力，拆解结果能持久化、索引化、跨 session 复用，最终喂入创作流程。
- 关键追问与回答：
  - Q: 你现在怎么分析对标视频？A: 轻抖提取文案 → 粘贴给 LLM → 分析 → 改写，session 结束就丢了
  - Q: 最大痛点？A: (1) 流程碎片化 (2) 知识不复利 (3) 只能分析文案看不到画面 (4) 人工筛选效率低

### 🧱 第一性原理 — 需求拆解
| 能力单元 | 判定 | 理由 |
|----------|------|------|
| 视频内容获取（链接/文件/账号） | ✅ 真实缺口 | AutoCrew 无视频输入能力。需可插拔采集层（MediaCrawl/Playwright/手动） |
| 多模态分析（文案+画面+剪辑+节奏） | ✅ 真实缺口 | 现有 teardown 框架只处理文本。MiMo-V2-Omni 可直接分析完整视频 |
| 结构化拆解模板 | ⚠️ 部分覆盖 | Clock Theory/HKRR 可参考但不够，需新建"分析别人视频"的专用模板 |
| 拆解结果持久化+索引 | ⚠️ 部分覆盖 | knowledge-wiki 管道已建好，视频拆解结果写入 intel + 触发 wiki sync 即可 |
| 对标账号持续关注 | ✅ 真实缺口 | competitor collector 只做文本级监控。视频级持续关注需扩展。可 defer |
| 拆解结果喂入创作 | ❌ 已覆盖 | write-script Step 5.5 查 wiki + intel，零改动 |

- 借鉴偏差检测：无。痛点来自用户自己的真实工作流（轻抖 → 手动粘贴 → 单次分析 → 丢失）

### 🪒 奥卡姆剃刀 — 最简形式
- 推荐形式：1 个新 skill（video-teardown），零新 tool
- 砍掉的部分：
  - 账号链接批量抓取 → P1，先做单视频
  - 音频单独分析 → 画面+文案覆盖 80% 价值
  - 持续关注/定期抓取 → 先手动拆解验证价值
  - ffmpeg 抽帧 → 被 Omni 全模态直接替代
- 最小可行范围：
  1. 新 skill `video-teardown`：输入视频链接或文件 → 采集器获取 → MiMo-V2-Omni 分析 → 结构化报告
  2. 新的视频拆解分析模板（独立于创作框架）
  3. 报告通过 intel ingest 写入 pipeline → 自动触发 knowledge-sync
  4. `creator-profile.json` 加 `videoCrawler` 配置（media_crawler / playwright / manual）
  5. 零新 tool — Omni API 是 OpenAI 兼容的，skill 层直接调用

### 📊 马斯洛需求分析 — 价值定位
- 需求层级：Level 3 — 质量层
- 当前缺口匹配度：填补当前缺口。质量层正在密集补齐（references → wiki → 视频拆解），视频拆解是 Level 3 的模态补全 — 从"只能从文字学"升级为"能从视频学"
- 优先级建议：立即做。三者形成闭环：拆解结果自动进 wiki，wiki 自动喂创作，复利越早开始越好

### 🔴 红队自检
| # | 不做的理由 | 反驳 | 强度 |
|---|-----------|------|------|
| 1 | 视频 base64 传 API token 消耗大，成本不可控 | MiMo Omni 输入 $0.4/M tokens 很便宜；skill 可限制视频时长；用户主动触发非批量 | 有效反驳 |
| 2 | 视频采集依赖 MediaCrawl/Playwright，其他用户配置门槛高 | P0 有 manual 兜底；采集器可插拔非必须；AutoCrew 面向有技术能力的创作者 | 有效反驳 |
| 3 | Omni 视频分析质量不确定，可能看不出剪辑节奏等专业维度 | benchmark 不等于实际效果，需实测。但即使分析不到剪辑细节，文案+画面+整体节奏已远超"轻抖提文案"。先上线再迭代模板 | 勉强有效，接受风险 |

红队结论：维持"做"。

## 实现建议
- 形式：1 个新 skill + creator-profile 配置扩展
- 依赖的现有组件：
  - `autocrew_intel` ingest action（刚建好，写入拆解报告）
  - knowledge-sync skill（自动触发 wiki 合成）
  - write-script Step 5.5（自动引用 wiki 中的拆解知识）
  - `intel/_teardowns/` 目录（已存在）
  - MiMo-V2-Omni API（OpenAI 兼容，base_url: https://api.xiaomimimo.com/v1）
- 主要风险：
  - Omni 分析质量需实测验证 → 通过拆解模板迭代缓解
  - 视频文件大小/时长限制 → skill 里设上限
  - 平台反爬（抖音/小红书）→ 可插拔采集器 + manual 兜底
- 建议下一步：
  1. 设计视频拆解分析模板（区别于创作框架）
  2. brainstorming → writing-plans → 实现 video-teardown skill
  3. 实测 MiMo-V2-Omni 对短视频的分析效果，据此调整模板

## 技术参考
- MiMo-V2-Omni API：OpenAI 兼容，base_url `https://api.xiaomimimo.com/v1`，model `mimo-v2-omni`
- 视频输入：base64 编码，通过 `image_url` content type 传 `data:video/mp4;base64,...`
- 定价：输入 $0.4/M tokens，输出 $2/M tokens
- 上下文窗口：262K tokens，最大输出 32K tokens

## 元数据
- 日期：2026-04-06
- 提案人：user
- 复杂度评估：重度
