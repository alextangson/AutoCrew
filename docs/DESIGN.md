# DESIGN.md — AutoCrew 视觉设计系统 v1

> 裁决记录：2026-06-11 创始人在三方向小样中选定「**C 团队工牌为主，融 A 晨间编辑部的暖调**」。
> 核心隐喻 =「你的数字员工团队」（PRD §4 crew 呈现层裁决）。本文件是 renderer 视觉的唯一事实源——改样式先改这里。

## 1. 基调

**暖纸工作室 + 角色色块。** 整体安静（低饱和暖中性，A 的纸感），色彩只给两样东西：**角色身份**和**关键数据**。结构靠边框与底色层次表达，不用阴影堆质感。别人是工具皮肤，我们是团队叙事——每一张卡片都该回答「这是团队里谁干的」。

## 2. 色彩 Token（落 style.css `:root`）

### 基底（A 暖调）

```css
--bg: #F4F2EC;            /* 工作区底（右栏） */
--surface: #FAF9F5;       /* 面板/对话区底（左栏） */
--card: #FFFFFF;          /* 卡片 */
--border: #E8E5DC;
--text: #3D3929;          /* 暖黑 */
--muted: #9C9784;
--accent: #3D3929;        /* 主按钮 = 暖黑（色彩留给角色） */
--accent-text: #FAF9F5;
--success: #0F6E56;
--danger: #A32D2D;
--radius: 8px;            /* 控件 */
--radius-card: 12px;      /* 卡片 */
```

### 角色色系（C 工牌，每角色 bg / accent / strong 三档）

```css
--crew-scout-bg: #E1F5EE;   --crew-scout: #1D9E75;   --crew-scout-strong: #0F6E56;   /* 选题侦察员 */
--crew-writer-bg: #EEEDFE;  --crew-writer: #7F77DD;  --crew-writer-strong: #534AB7;  /* 编剧 */
--crew-review-bg: #FAEEDA;  --crew-review: #EF9F27;  --crew-review-strong: #854F0B;  /* 合规审核员 */
--crew-analyst-bg: #E6F1FB; --crew-analyst: #378ADD; --crew-analyst-strong: #185FA5; /* 数据分析师 */
```

**色彩纪律**：角色色只出现在署名徽/署名文字/卡片左缘条/团队栏 chip；正文永远 `--text`/`--muted`。角色色背景上的文字必须用同族 strong 档，禁黑/灰。除角色色与 success/danger 外，界面不得出现其他彩色。

## 3. 字体

```css
font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;  /* 正文 */
font-family: Georgia, "Songti SC", "STSong", serif;  /* 仅两处点缀：logo「AutoCrew · 编辑部」、工作台问候语 */
```

- 正文 14px / line-height 1.7；辅助 12px；时间戳/标注 11px（下限）
- 指标数字 22px / weight 600；标题 15-16px / 600；其余 400/500
- 中文场景 500 渲染偏弱：标题与按钮用 600，正文 400，署名 500

## 4. 形状 / 间距 / 动效

- 圆角：卡片 `--radius-card`(12px)，控件 `--radius`(8px)，角色 chip 999px（胶囊）
- 边框：1px `--border`（非视网膜屏 0.5px 发虚，统一 1px）
- **带角色左缘条的卡片**：`border-left: 3px solid var(--crew-*)` + `border-radius: 0 12px 12px 0`（左缘条与左圆角不兼容，左侧归零——获选小样的视觉记忆点）
- 间距阶梯：8 / 12 / 16 / 24px；卡片内边距 12px 14px
- 阴影：**无**。hover = border 加深一档（#D9D5C9）+ 背景微变；按下 = 无位移
- 动效：160ms ease-out；新卡片进场 fade-in 200ms（`@keyframes` opacity 0→1 + translateY 4px→0）；禁转圈炫技，loading 一律文字态

## 5. 角色系统（卡片署名 + 团队栏）

### 角色 ↔ 卡型映射（确定性，cards.js 实施）

| 卡型 | 角色 | 徽字 | 色族 |
|---|---|---|---|
| topic | 选题侦察员 | 侦 | scout |
| draft | 编剧 | 编 | writer |
| style | 编剧 | 编 | writer |
| publish / published | 合规审核员 | 审 | review |
| report | 数据分析师 | 析 | analyst |

### 署名行（卡片首行）

24px 圆徽（role-bg 底 + role-strong **单字**徽：侦/编/审/析——零依赖且工牌感强）+ 角色名（role-strong，12px/500）。kicker 原文案后移到署名行右侧或并入标题区。

### 团队栏（index.html 顶部常驻，跨双栏）

四枚胶囊 chip：`role-bg` 底 + `role-strong` 字 + 单字徽，`title` 属性写分工一句话（hover 可见）。v1 为静态展示（状态点等 activity log 基建后再点亮——不做假状态）。

## 6. 组件规格

- **用户气泡**：`--accent` 底 + `--accent-text` 字，圆角 10px 10px 2px 10px（右下收角）
- **助手气泡**（无角色的通用回复）：`--card` 底 + 1px 边框，圆角 10px 10px 10px 2px
- **工作区 tab**：选中 = `--surface` 底 + `--text` + 600；未选 = 透明底 + `--muted`；下缘 2px `--text` 指示（不用角色色——tab 是导航不是身份）
- **指标卡**：`--card` 底、无边框改 `--surface`？否——右栏底是 `--bg`，指标卡用 `--card` + 1px 边框；数值 22px/600 `--text`，正向高亮可用 `--success`
- **主按钮**：`--accent` 底 `--accent-text` 字；次按钮：透明底 1px 边框 `--text` 字；mini 按钮：11px，胶囊或 6px 圆角
- **输入区**：`--card` 底 1px 边框，聚焦 border 变 `--text`，placeholder「告诉团队你想做什么…」

## 7. 文案声纹（团队叙事）

- 欢迎语：「编辑部就位。直接说需求，比如：帮我写一条关于 Excel 快捷键的抖音口播。」
- 报告面板标题：「数据分析师 · 回流报告」；风格面板：「编剧 · 风格档案」；设置不署名
- thinking 占位保持「正在干活…」族；角色在卡片署名，不在气泡里自称

## 8. 红线

- 不引入任何字体文件/图标库/CSS 框架（零依赖纪律）
- 不改 renderer 逻辑层（事件绑定、IPC 调用、状态）——本系统只允许动：style.css 全量、index.html 结构性小改（团队栏）、cards.js 的 cardShell 署名参数与映射、各文件文案字符串
- XSS 纪律不变：角色名/徽字是常量，用户内容仍只走文本节点
