# AutoCrew 端到端测试清单

## 环境准备

```bash
# 1. MacBook 上 clone + link 安装
cd ~/projects
git clone https://github.com/alextangson/AutoCrew.git
cd AutoCrew
npm install
openclaw plugins install --link .

# 2. 配置 Gemini API key（封面生成需要）
# 方式 A：环境变量
export GEMINI_API_KEY="你的key"
# 方式 B：OpenClaw 插件配置（推荐）
# 在 OpenClaw 设置里找到 AutoCrew 插件，填入 gemini_api_key

# 3. 验证安装
openclaw crew status
```

预期输出：`AutoCrew v0.1.0`，Data 目录，Topics/Contents 计数。

---

## 主线 1：首次用户完整旅程

这是最重要的测试路径，模拟一个新用户从零开始。

### 1.1 初始化

对话：`初始化`

预期：
- 创建 `~/.autocrew/` 目录结构
- 创建空的 `creator-profile.json`
- 返回 "初始化完成" + 目录列表

验证：`ls ~/.autocrew/` 应该有 topics/ contents/ learnings/ 等子目录

### 1.2 Onboarding（自动触发）

对话：`帮我找选题`（或任何功能请求）

预期：
- Agent 先检测到 profile 不完整
- 自动进入 onboarding 流程
- 询问你的行业、目标平台、受众
- 你回答后写入 creator-profile.json
- 然后继续你的原始请求（找选题）

验证：`cat ~/.autocrew/creator-profile.json` 应该有 industry、platforms 字段

### 1.3 风格校准

对话：`风格校准`

预期：
- 4 阶段流程：品牌调研 → 样本采集 → A/B 对比 → 写作人格生成
- 生成 `~/.autocrew/STYLE.md`
- 更新 creator-profile.json 的 styleCalibrated = true

验证：`cat ~/.autocrew/STYLE.md` 应该有你的写作风格描述

### 1.4 选题调研

对话：`帮我找 3 个 AI 赚钱的选题`

预期：
- 使用 web_search 搜索热榜
- 返回 3-5 个带评分的选题
- 每个选题有标题、描述、tags、爆款评分
- 自动保存到 topics/

验证：`openclaw crew topics` 应该列出新选题

### 1.5 写文案

对话：`写第 1 个`（或 `帮我写 [选题标题]`）

预期：
- 加载 STYLE.md 和 creator-profile.json
- 按 Hook-Body-CTA-Title 结构生成
- 自动保存为 draft
- 返回完整文案 + 标题备选 + hashtag

验证：`openclaw crew contents` 应该有一篇 draft_ready 状态的内容

### 1.6 去 AI 味

对话：`去 AI 味` 或 `润色一下`

预期：
- 扫描并替换 AI 痕迹词（赋能→帮、闭环→跑通 等）
- 返回修改列表和修改后文案
- 显示修改了几类问题

### 1.7 内容审核

对话：`检查一下` 或 `审核`

预期：
- 敏感词扫描（返回命中数或"无敏感词"）
- 质量评分
- 去 AI 味检查
- 返回综合审核结果 + 修复建议

### 1.8 生成封面

对话：`生成封面`

前提：已配置 GEMINI_API_KEY

预期：
- 分析内容主题
- 检测形象照目录（可能为空）
- 生成 3 组 prompt（电影海报/极简/冲击力）
- 调 Gemini API 生成 3 张 3:4 图片
- 展示 A/B/C 三张候选
- 每张附设计思路说明

验证：`ls ~/.autocrew/contents/[content-id]/assets/covers/` 应该有 3 张图片

### 1.9 选定封面

对话：`选 A`（或 B/C）

预期：
- 标记选定的 variant
- 更新 cover review 状态为 approved
- Free 用户提示"需要 16:9 和 4:3？这是 Pro 功能"

### 1.10 发布前检查

对话：`发布前检查`

预期：
- 运行 6 项检查（敏感词、质量、去AI味、封面、标题、hashtag）
- 返回每项的通过/未通过状态
- 如果全部通过，提示可以发布

---

## 主线 2：多平台改写

### 2.1 平台改写

对话：`改写成抖音版本`

预期：
- 从当前内容生成抖音版本
- 自动调整格式（标题风格、hashtag、正文长度）
- 保存为独立 content，设置 siblings 关联

验证：`openclaw crew contents` 应该多一篇 douyin 平台的内容

### 2.2 批量改写

对话：`同时改写成小红书和抖音版本`

预期：
- 生成 2 个平台版本
- 各自独立保存
- siblings 互相关联

---

## 主线 3：学习循环

### 3.1 用户修改触发 diff

对话：`把文案里的"首先"和"其次"都去掉，改成更口语的表达`

预期：
- 修改内容
- 自动记录 diff（before/after）
- 检测到 remove_progression_words 模式

验证：`ls ~/.autocrew/learnings/edits/` 应该有 diff 文件

### 3.2 多次修改后规则提炼

（需要累积 5+ 次同类修改才会触发自动提炼）

对话：多次给出类似反馈（如"太正式了"、"口语一点"）

预期：
- 每次修改都记录 diff
- 累积到阈值后自动提炼规则
- 规则写入 creator-profile.json 的 writingRules

---

## 主线 4：Pipeline 自动化

### 4.1 查看模板

对话：`有什么自动化模板`

预期：返回可用的 pipeline 模板列表

### 4.2 创建 pipeline

对话：`创建一个每周选题的自动化`

预期：创建 pipeline 配置并保存

### 4.3 查看状态

CLI：`openclaw crew pipelines`

预期：列出已创建的 pipeline

---

## 支线 A：素材管理

### A.1 添加素材

对话：`给这篇内容添加一张封面素材`（附带图片路径）

预期：素材被复制到 content 的 assets 目录

### A.2 版本管理

对话：`查看这篇内容的版本历史`

预期：列出所有版本（v1, v2...）

---

## 支线 B：Pro gate

### B.1 触发 Pro 功能

对话：`帮我分析对标账号` 或 `生成 16:9 封面`

预期：
- 返回"这是 Pro 版功能"
- 提供 Free 替代方案
- 显示升级提示

### B.2 升级命令

CLI：`openclaw crew upgrade`

预期：显示 Pro 版功能列表和激活方式

---

## CLI 命令验证

```bash
openclaw crew status          # 流水线概览
openclaw crew profile         # 创作者档案
openclaw crew topics          # 选题列表
openclaw crew contents        # 内容列表
openclaw crew upgrade         # Pro 信息
```

---

## 已知限制

- 发布功能（`autocrew_publish`）目前只有 wechat_mp_draft，小红书/抖音发布适配器尚未实现
- Pipeline 的 cron 调度是配置层面的，实际定时执行需要外部 cron 触发
- 风格校准是交互式的，需要多轮对话，不能一步完成
- 学习循环的规则提炼需要 5+ 次同类修改才触发，单次测试看不到效果
