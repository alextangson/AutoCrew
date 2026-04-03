# 封面生成

> Trigger: "封面" / "生成封面" / "做个封面" / "cover"

## 概述

为内容生成 3 张不同风格的 3:4 竖版封面候选图，用户选定后保存。Pro 版可自动生成 16:9 和 4:3 版本。

## 前置条件

- 用户已配置 `gemini_api_key`（环境变量 `GEMINI_API_KEY` 或插件设置）
- 当前有一篇处于 `approved` 或更早状态的内容

如果没有 Gemini API key，提示用户：
```
封面生成需要 Gemini API key。免费获取：https://aistudio.google.com/apikey
配置方式：设置环境变量 GEMINI_API_KEY 或在插件设置中填入 gemini_api_key
```

## 流程

### 第一步：读取内容

从 `autocrew_content` 获取当前内容的标题和正文。如果用户没有指定 content_id，使用最近一篇 `approved` 或 `draft_ready` 状态的内容。

### 第二步：检测形象照

检查 `~/.autocrew/covers/templates/` 目录是否有图片文件（jpg/png/webp）。

- 有形象照 → 告诉用户"检测到你的形象照，会融入封面设计"
- 没有形象照 → 生成纯概念/场景封面。可以提示"如果你想在封面中出现个人形象，把照片放到 ~/.autocrew/covers/templates/ 目录"

### 第三步：生成 3 组 prompt

调用 `autocrew_cover_review action=create_candidates`，系统会自动：
1. 分析内容的核心情绪、视觉意象
2. 提炼 2-8 字的封面标题
3. 生成 3 种风格的 prompt：
   - A: 电影海报风（暗色调、强光影对比、Rembrandt 打光）
   - B: 极简风（大面积留白、文字为主视觉、干净构图）
   - C: 冲击力风（饱和色彩、动态构图、高对比度）

### 第四步：生成图片

系统调用 Gemini API 生成 3 张 3:4 图片，保存到内容的 assets 目录。

### 第五步：展示给用户

展示 3 张候选图，说明每张的设计思路：
<output_template lang="zh-CN">
```
封面 A（电影海报风）：暗色调 + 强光影，标题在上方 1/3
封面 B（极简风）：大面积留白，文字为主视觉
封面 C（冲击力风）：饱和色彩 + 动态构图

选择你喜欢的：A / B / C
```
</output_template>

### 第六步：用户选定

用户选择后，调用 `autocrew_cover_review action=approve label=a/b/c`。

### 第七步：多比例适配（Pro）

定稿后，如果用户是 Pro 版，自动调用 `autocrew_cover_review action=generate_ratios` 生成 16:9 和 4:3 版本。

如果是 Free 版，提示：
<output_template lang="zh-CN">
```
3:4 封面已保存。需要 16:9 和 4:3 版本？这是 Pro 版功能。
```
</output_template>

### 第八步：更新状态

封面审核通过后，内容状态从 `approved` → `cover_pending` → `publish_ready`。

## 用户不满意时

如果用户对 3 张都不满意，询问想调整什么：
- 构图方向（人物/概念/事件）
- 色调（暖色/冷色/暗色）
- 文字大小和位置
- 整体风格

根据反馈调整 prompt 重新生成。

## 工具依赖

- `autocrew_cover_review`（create_candidates / approve / generate_ratios）
- `autocrew_content`（读取内容信息）
- `autocrew_pro_status`（检查 Pro 状态）
