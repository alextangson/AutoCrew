# 视频时间轴生成

> Trigger: "生成视频" / "视频素材" / "时间轴" / "video timeline" / "做视频" / "视频制作"

## 概述

将已完成的文案自动生成视频时间轴，包括AI配音段落规划、B-roll素材标注、知识卡片配置。

## 前置条件

- 内容状态为 `approved` 或 `draft_ready`
- 文案（draft.md）已完成

## 流程

### 第一步：确认内容

使用 `autocrew_content` 工具的 `get` 动作读取内容，确认文案已就绪。

### 第二步：选择预设和比例

询问用户：

**预设风格：**
- `knowledge-explainer`：知识讲解（卡片为主 + B-roll 过渡）
- `tutorial`：教程类（步骤卡片 + 屏幕录制占位）

**画面比例：**
- `9:16` 竖屏（抖音/快手/Reels）
- `16:9` 横屏（B站/YouTube）
- `3:4` 小红书
- `1:1` 正方形（朋友圈）
- `4:3` 视频号

### 第三步：AI 自动标记

分析文案内容，在合适位置插入 `[card:...]` 和 `[broll:...]` 标记。

**knowledge-explainer 规则：**
- 约 60% 画面用知识卡片，40% 用 B-roll
- 提到对比、列举、要点时用 card
- 切换话题或需要过渡时用 broll
- B-roll prompt 要具体（画面内容+风格+氛围）
- card 数据从文案中提取，不编造

**tutorial 规则：**
- 每个步骤用带编号的 card 展示
- 步骤之间用 broll 做过渡
- 软件操作标注 `[broll:屏幕录制占位 — 操作描述]`

**可用卡片模板：**
- `comparison-table`：对比表。attrs: `title="标题" rows="名称:优点:缺点,名称:优点:缺点"`
- `key-points`：要点列表。attrs: `items="要点1,要点2,要点3"`
- `flow-chart`：流程图。attrs: `steps="步骤1,步骤2,步骤3"`
- `data-chart`：数据图。attrs: `title="标题" items="标签:数值,标签:数值"`

**标记语法示例：**
```
今天我们聊聊三个效率工具
[card:comparison-table title="三款工具对比" rows="Notion:全能:学习曲线,Obsidian:本地:无协作"]

第一个是 Notion，很多人用它来管理生活
[broll:Notion 应用界面操作画面，暗色主题，流畅页面切换]

它最强的地方在于三点
[card:key-points items="数据库驱动,模板生态,多端同步"]
```

**跨段B-roll：** 一个 B-roll 跨越多段旁白时，用 `span=N`：
```
第一段话
第二段话
[broll:城市航拍夜景 span=2]
```

### 第四步：用户确认标记

将带标记的文案展示给用户。用户可以：
- 修改标记位置
- 更换卡片模板
- 调整 B-roll prompt
- 添加或删除标记

### 第五步：生成时间轴

用户确认后，使用 `autocrew_timeline` 工具的 `generate` 动作：

```
action: generate
content_id: {内容ID}
preset: {用户选择的预设}
aspect_ratio: {用户选择的比例}
```

将带标记文案保存为 draft.md，然后生成 timeline.json。

### 第六步：引导后续操作

告知用户时间轴已生成，后续可以：

1. **Web UI 素材面板** — 在浏览器中打开 `/contents/{id}/assets` 查看和调整素材
2. **自动生成素材** — 安装 `@autocrew/studio` 后，运行 `autocrew render` 自动生成 TTS 配音、B-roll 素材、知识卡片截图
3. **导出剪映** — 运行 `autocrew render --jianying` 导出为剪映项目文件

## 用户修改素材时

在 Web UI 素材面板中，用户可以对每个素材：
- 🔄 重新生成：重新调用 AI 生成
- 📝 编辑：修改 prompt 或卡片内容
- 📤 上传替换：用本地文件替换

所有素材确认后（状态为 confirmed），即可触发最终合成。

## 工具依赖

- `autocrew_content` — 读取文案
- `autocrew_timeline` — 生成和管理时间轴
