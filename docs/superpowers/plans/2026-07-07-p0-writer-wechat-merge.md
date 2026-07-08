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
