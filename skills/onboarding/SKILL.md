# Onboarding — 渐进式画像（Progressive Profiling）

> Trigger: 用户首次触发任何 AutoCrew 功能时自动检测（内部调用，非用户直接触发）

## 核心理念

**不再阻断用户。** 旧版 onboarding 要求用户先回答 5+ 轮问题才能开始工作。新版采用渐进式画像：用户来了就能干活，画像从行为中自动推断。

## Profile Level 体系

| Level | 触发时机 | 行为 |
|-------|---------|------|
| 0 | 首次使用 | 零配置直接执行，用通用风格 |
| 1 | 第 1-2 次请求 | 从请求内容自动推断行业/平台，轻松确认 |
| 2 | 第 3-5 次请求 | 主动建议风格校准（用户可拒绝） |
| 3 | 持续使用 | Diff Tracker + Rule Distiller 自动学习 |

## 流程

### Step 1: 静默初始化

当任何 AutoCrew skill 被调用时：
1. 调用 `autocrew_pro_status` 检查 profile 状态
2. 如果 `profileExists: false` → 静默调用 `autocrew_init` 创建数据目录和空 profile
3. **不问任何问题，不阻断任何操作**
4. 直接继续执行用户的原始请求

### Step 2: 机会性读取宿主信息

在后台（不阻断用户请求的前提下）尝试读取已有上下文：

1. 读取当前 workspace 的 `MEMORY.md`（如果存在）
2. 读取 `~/.autocrew/MEMORY.md`（如果存在）
3. 从中提取以下信息：

| 字段 | MEMORY.md 中的匹配模式 |
|------|----------------------|
| industry | `industry:` / `定位:` / `行业:` / `领域:` 后面的文本 |
| platforms | `平台:` / `platforms:` 后面的列表，或包含 `小红书` `抖音` `公众号` `B站` 的行 |
| audience | `受众:` / `audience:` / `目标用户:` 后面的描述 |
| competitors | `Competitor Accounts` section 下的链接列表 |
| style notes | `风格:` / `style:` / `调性:` 后面的描述 |

4. 已有信息静默写入 `creator-profile.json`，不通知用户

### Step 3: 自动推断（Level 1）

当用户触发写作/调研工具时，调用 `progressive-profiling.ts` 的 `inferFromRequest()`：
- 从 keyword/title/body 推断行业
- 从 platform 参数推断目标平台
- 调用 `autoEnrichProfile()` 填充空字段（只填空的，不覆盖已有的）

推断成功后，**顺带**轻松确认（不打断工作流）：
```
看起来你做的是科技领域，对吗？
```
用户不回应也没关系，推断值继续使用。

### Step 4: Nudge 系统（Level 2）

调用 `getNudge(profile, contentCount)` 判断是否需要提示：

- `contentCount >= 1` 且 Level 0 → 顺带问一句行业
- `contentCount >= 3` 且未校准风格 → 建议风格校准

Nudge 规则：
- 每次最多 1 个 nudge，附在任务结果之后
- 用户拒绝或忽略 → 不再重复提
- 永远不阻断当前任务

### Step 5: 风格校准入口

当用户主动说「风格校准」或接受 nudge 建议时：
- 转交给 `style-calibration` skill 处理
- 这是唯一需要用户主动参与的环节
- 仍然是可选的，不是必须的

## 关键原则

1. **零阻断**：永远不阻断用户的原始请求
2. **行为推断**：画像信息从行为中推断，不从问卷中收集
3. **最少打扰**：每次最多顺带问 1 个问题
4. **不覆盖**：自动推断只填空字段，不覆盖用户已有数据
5. **不覆盖宿主**：不修改宿主的 MEMORY.md 或 AGENTS.md，只写 AutoCrew 自己的数据目录
6. **幂等**：多次运行不会丢失已有数据
7. **渐进式**：从 Level 0 到 Level 3，用户自然过渡，无感知

## 工具依赖

- `autocrew_init`（初始化数据目录）
- `autocrew_pro_status`（检测 profile 完整度）
- `autocrew_memory`（记录事件）
- `progressive-profiling.ts`（推断引擎：`inferFromRequest`, `autoEnrichProfile`, `getNudge`, `getProfileLevel`）
- 文件系统读取（宿主 MEMORY.md、creator-profile.json）
- 文件系统写入（creator-profile.json）

## Changelog

- 2026-03-31: v1 — Initial onboarding skill.
- 2026-04-01: v2 — 增强 MEMORY.md 读取逻辑（支持多种字段匹配模式）、明确 Step 6 自动继续原始请求、增加 autocrew_init 初始化步骤、增加幂等原则。
- 2026-04-01: v3 — 重构为渐进式画像（Progressive Profiling）。移除强制阻断式 onboarding，改为 Level 0-3 渐进体系。新增自动推断引擎（inferFromRequest）、Nudge 系统、机会性 MEMORY.md 读取。用户首次使用即可直接工作，画像从行为中自动积累。
