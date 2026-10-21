# DESIGN.md — AutoCrew 视觉设计系统 v1

> 裁决记录：2026-06-11 创始人在三方向小样中选定「**C 团队工牌为主，融 A 晨间编辑部的暖调**」。
> 核心隐喻 =「你的数字员工团队」（PRD §4 crew 呈现层裁决）。token 的真源是 `frontend/src/tokens.css`，本文件跟着代码走——改了 token 回来同步这里。

## 1. 基调

**暖纸工作室 + 角色色块。** 整体安静（低饱和暖中性，A 的纸感），色彩只给两样东西：**角色身份**和**关键数据**。结构靠边框与底色层次表达，不用阴影堆质感。别人是工具皮肤，我们是团队叙事——每一张卡片都该回答「这是团队里谁干的」。

## 2. 色彩 Token（落 `frontend/src/tokens.css` `:root`）

> 代码是真源：下面的值照抄 `tokens.css`，两边不一致时以代码为准、回来改这里。

### 基底（暖纸编辑部：近黑白 + 发丝线）

```css
--bg: #F5F4EF;            /* 页面底（暖纸） */
--surface: #F5F4EF;       /* 面板底、卡片里的浅灰块、悬停底 */
--card: #FFFFFF;          /* 卡片、弹层 */
--lane: #ECEAE2;          /* 看板泳道、分段开关底、选中/悬停的灰底 */
--border: #DCD9CF;        /* 默认 1px 边框 */
--line-2: #B9B5A8;        /* 悬停加深一档的边框 */
--line-soft: #E8E6E1;     /* 比 border 浅一档的分隔线（弹层内、卡片内分行） */
--ink: #16150F;           /* 近黑：正文、主按钮、强调边 */
--text: #16150F;
--text-2: #6E6A5E;        /* 次要正文：小字说明、副标题 */
--muted: #8B877B;         /* 辅助信息、时间戳、禁用字 */
--accent: #16150F;        /* 主按钮 = 近黑（色彩留给角色和数据） */
--accent-text: #F8F7F2;   /* 深底上的字 */
--hot: #C63D00;           /* 警示橙：只用于提醒/风险，不做焦点或装饰 */
--success: #14523F;
--danger: #A32D2D;
--danger-line: #E5C2B5;
--ok-line: #B7D3C7;
```

### 角色色（每角色一档，只做署名/左缘条/chip）

```css
--crew-scout: #35553F;      /* 选题侦察员 */
--crew-writer: #3E3A66;     /* 编剧 */
--crew-review: #8A4B14;     /* 合规审核员 */
--crew-analyst: #2E4A66;    /* 数据分析师 */
--crew-publisher: #6a4fb3;  /* 发布员 */
```

**色彩纪律**：角色色只出现在署名徽/署名文字/卡片左缘条/团队栏 chip；正文永远 `--text`/`--text-2`/`--muted`。除角色色、数据图表色与 success/danger/hot 外，界面不得出现其他彩色。新样式一律用 token，不写裸色值；`platform-mock.css`（模仿抖音/小红书界面）例外。

## 3. 字体

```css
font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;  /* 正文 */
font-family: Georgia, "Songti SC", "STSong", serif;  /* 仅两处点缀：logo「AutoCrew · 编辑部」、工作台问候语 */
```

- 正文 14px / line-height 1.7；辅助 12px；时间戳/标注 11px（下限）
- 指标数字 22px / weight 600；标题 15-16px / 600；其余 400/500
- 中文场景 500 渲染偏弱：标题与按钮用 600，正文 400，署名 500

## 4. 形状 / 间距 / 阴影 / 焦点 / 动效

- 圆角：按钮 `--radius-btn`(8px)，控件与卡片 `--radius` / `--radius-card`(4px)，弹窗 `--radius-dialog`(6px)，角色 chip 999px（胶囊）
- 边框：1px `--border`（非视网膜屏 0.5px 发虚，统一 1px）；分行用 `--line-soft`
- **带角色左缘条的卡片**：`border-left: 3px solid var(--crew-*)`，左侧圆角归零
- 间距阶梯：`--s1`…`--s6` = 4 / 8 / 12 / 16 / 24 / 32px；控件高 `--h-sm` 28px、`--h-md` 36px
- 字号阶梯：`--fs-xs` 12 / `--fs-sm` 13 / `--fs-md` 14 / `--fs-lg` 16 / `--fs-xl` 22 / `--fs-2xl` 28px（`--fs-answer` 20px 只给数据页结论）
- 阴影：**只有浮层有阴影，卡片永远没有。** 两档 token——
  - `--shadow-pop`：下拉、浮出菜单、选区浮条、提示条
  - `--shadow-dialog`：弹窗、抽屉
  - 选中标记用的内描边（`inset 0 0 0 2px var(--ink)`、`inset 2px 0 0 var(--ink)`）和聚光遮罩不算阴影，照旧
  - 卡片的层次靠边框和底色（`--card` 压在 `--bg` 上），hover = 边框加深到 `--line-2`
- 焦点环：只在键盘聚焦（`:focus-visible`）出现，鼠标点击不出现。`outline: var(--focus-ring)`（2px 墨色）+ `outline-offset: var(--focus-ring-offset)`（2px），中间那圈露出纸底，黑底主按钮上也看得清。全站一种，不按页面换颜色（橙色留给警示）。输入框/文本框/下拉框不加环，聚焦时边框变 `--ink`
- 动效：过渡 150ms ease；弹窗/下拉入场 120–150ms 淡入 + 上移几像素；禁转圈炫技，loading 一律文字态或骨架呼吸
- 减少动态效果：系统开了 `prefers-reduced-motion: reduce` 时全站关掉过渡和动画（含骨架呼吸、弹窗/下拉入场），滚动一律瞬时

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
