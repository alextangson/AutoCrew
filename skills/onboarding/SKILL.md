# Onboarding — 首次引导

> Trigger: 用户首次触发任何 AutoCrew 功能时自动检测（内部调用，非用户直接触发）

## 触发条件

当任何 AutoCrew skill 被调用时，检测 `~/.autocrew/creator-profile.json` 是否存在：
- 如果存在且 `industry` 非空 → 跳过 onboarding，直接执行原始任务
- 如果不存在或关键字段为空 → 进入 onboarding 流程

## 流程

### Step 1: 初始化数据目录

调用 `autocrew_init` 确保 `~/.autocrew/` 目录和 `creator-profile.json` 存在。

### Step 2: 从宿主读取已有信息

在开始提问之前，先尝试读取宿主 AgentOS 的已有上下文：

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

4. 已有信息直接写入 `creator-profile.json`（通过文件系统），不再重复问

### Step 3: 检测缺失信息

调用 `autocrew_pro_status` 或直接读取 profile，使用 `detectMissingInfo()` 逻辑判断缺失字段。

### Step 4: 补问缺失信息

根据缺失字段，仅问必要的问题。每个问题独立，用户可以跳过。

**如果缺 industry：**
```
你主要做哪个领域的内容？（比如：美妆、科技、职场、育儿、美食...）
```
→ 写入 `creator-profile.json.industry`

**如果缺 platforms：**
```
你主要在哪些平台发内容？
1. 小红书
2. 抖音
3. 小红书 + 抖音
4. 公众号
5. B站
6. 其他（请说明）
```
→ 写入 `creator-profile.json.platforms`

**如果缺 audience（可选，用户可跳过）：**
```
你的目标读者/观众是谁？简单描述就行，比如"25-35岁职场女性"或"大学生"。
输入"跳过"可以之后再补。
```
→ 写入 `creator-profile.json.audiencePersona`

**如果缺 style（不在 onboarding 中深度校准，只做标记）：**
```
发我 1-2 条你觉得写得好的内容（链接或文字都行），我来分析你的风格。
输入"跳过"可以之后用"风格校准"命令深度设置。
```
→ 如果用户提供了内容，做简单风格提取写入 `~/.autocrew/STYLE.md`
→ 如果跳过，标记 `styleCalibrated: false`，后续 agent 会主动建议

### Step 5: 保存 profile

将收集到的信息通过文件系统写入 `~/.autocrew/creator-profile.json`。
同时用 `autocrew_memory` 的 `capture_feedback` action 记录 onboarding 完成事件。

### Step 6: 继续原始任务

onboarding 完成后，**不要停在引导页面**，直接继续用户最初的请求。

例如用户说"帮我找选题"触发了 onboarding：
- 完成 onboarding 后，自动执行 research skill
- 用户感知是"回答了几个问题后就开始找选题了"，而不是"被拦截做了一堆设置"

**实现方式**：onboarding skill 结束时，输出一行提示：
```
✅ 初始化完成！现在继续你的请求...
```
然后立即执行用户原始请求对应的 skill/tool。

## 关键原则

1. **最少打扰**：只问缺失的信息，已有的直接复用
2. **可跳过**：每个问题都可以跳过，不强制
3. **不阻断**：onboarding 完成后立即继续原始任务
4. **渐进式**：首次只收集最基础的信息，深度校准留给 style-calibration skill
5. **不覆盖**：不修改宿主的 MEMORY.md 或 AGENTS.md，只写 AutoCrew 自己的数据目录
6. **幂等**：多次运行不会丢失已有数据

## 工具依赖

- `autocrew_init`（初始化数据目录）
- `autocrew_pro_status`（检测 profile 完整度）
- `autocrew_memory`（记录 onboarding 事件）
- 文件系统读取（宿主 MEMORY.md、creator-profile.json）
- 文件系统写入（creator-profile.json、STYLE.md）

## Changelog

- 2026-03-31: v1 — Initial onboarding skill.
- 2026-04-01: v2 — 增强 MEMORY.md 读取逻辑（支持多种字段匹配模式）、明确 Step 6 自动继续原始请求、增加 autocrew_init 初始化步骤、增加幂等原则。
