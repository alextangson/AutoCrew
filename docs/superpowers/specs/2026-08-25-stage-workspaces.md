# 稿件阶段制工作台 · 文案 → 剪辑 → 封面 → 发布

> 依据：创始人 IA 裁决（2026-08-25）——剪辑不该塞在文案页底下；推进按钮驱动阶段，每个阶段有自己的工作台。
> 前序：视频线四刀已落 main（横屏/剪辑师/三门/复用）；封面形象库已落（47a9dfa）。本文是把这些能力从"文案页折叠面板"重排为"阶段工作台"。

## 0. 裁决

| 决定 | 内容 |
|---|---|
| 阶段即状态 | 视频平台稿件：`approved`（文案定稿）→ **`editing`（剪辑，新状态）** → **`cover_pending`（待封面，复活既有孤儿状态）** → `publish_ready` → 发布。文字平台流程不变 |
| 工作台随状态 | 打开稿件按状态进对应工作台：文案编辑器（≤approved）/ 剪辑工作台（editing）/ 封面工作台（cover_pending）/ 发布工作台（≥publish_ready）。**文案页移除成片/封面折叠面板** |
| 迁移表仍单表 | `STATE_TRANSITIONS` 保持平台无关的单表，**平台差异走独立 guard 层**（人话拒绝），不在表里分叉 |

`cover_pending` 当年被摘出 approved 出口的理由是"封面设计师未转正、无 UI 通道"——形象库落地后转正条件已满足，复活它而不是发明新状态。

**复活的残留清扫清单**（codex 全仓查实，运行时三处必改）：
1. `approveCoverVariantLocked` 会把 cover_pending 倒拨回 approved——删除该倒拨（新流程里批准只做标记，推进是人的动作）
2. 看板/dashboard/today-summary 把 cover_pending 归入"待审"、文案写"等待封面生成"——按新语义改归类与文案
3. 旧测试断言 approved 不可进 cover_pending——随迁移表更新

## 1. 状态机

### 1.1 迁移表变更

```
approved:      ["publish_ready", "reviewing", "editing"]      // 增 editing
editing:       ["cover_pending", "approved"]                  // 新；回 approved = 回文案改稿
cover_pending: ["publish_ready", "editing"]                   // 出口从 approved 改为 editing（回剪辑）
```

### 1.2 Guard 层（新；codex 评审 2026-08-25 吸收后的终稿口径）

**位置与原子性**：guard 在 `local-store` 的串行写锁**内**执行，与"读当前状态→校验→写入"构成一个原子操作（现实现锁外读锁内写，无真 CAS——一并修）。**全部 status 写入点收口到这一条通道**：`saveContent` 初始态、`transitionStatus`、`approveCoverVariantLocked`、`confirm_published`；**`updateContent({status})` 直写禁止**（类型上移除该字段的可写性）；`force` 只可越过*状态图形状*，不可越过*产品 guard*。

- 非视频平台 → `editing`：拒，"剪辑阶段只属于视频平台稿件"
- 视频平台 `approved → publish_ready`：拒，"视频稿要先过剪辑与封面（推进到剪辑）"
- `editing → cover_pending`：**不用 `videoReadyAt`**（它是首次盖章永不覆盖，重剪后旧戳会放行过时成片——codex 点名）。新增 `Content.videoDone?: { renderedRevision: number; at: string }`：审片通过时由视频线写入，从 done 重开（回剪/回选段）时清除。guard 只认 `videoDone` 非空
- `cover_pending → publish_ready`：要求封面已批准（复用既有判定），"封面还没定稿"
- **封面批准后又 revise**：若稿件已在 `publish_ready`，撤销批准同步降级回 `cover_pending`（toast 明示），不留"发布就绪但封面作废"的错位态
- **pre-publish 的自动流转（全过检自动进 publish_ready）必须走同一 guard**——预检不许绕过阶段门

### 1.3 标签

`VARIANT_STATUS` 增 `editing: "剪辑中"`；`cover_pending: "待封面"` 已有。看板/列表/推进下拉随之显示。

## 2. 工作台路由

- 稿件路由不变，**按状态渲染工作台**；顶栏推进按钮全局在场。
- 任何工作台都有"查看文案"只读入口（不改状态）；要改文案 → 推进按钮回退到 approved/reviewing（既有边）。
- **文案编辑器**：移除「成片」向导、「封面设计」折叠区；保留写作工具、发布件、素材附件（文字平台的配图仍在此）。
- **剪辑工作台**（editing）：现有三门向导升格整页 = 素材挂接（A-roll/B-roll/BGM 入口**搬进来**，含常备池）+ 构建卡 + 门一看片 + 门二计划 + 门三审片 + 清理行。
- **封面工作台**（cover_pending）：CoverPanel + 形象库升格整页；顶部缩略图带上成片首帧与标题（封面要对着片子做）。
- **发布工作台**（≥publish_ready）：发布件、预检、剪贴板/公众号推送、发布 URL 回填、数据回流入口。

## 3. 五问（product-sense，验收即按此表）

**① 状态**
- 剪辑台空态（无 A-roll）：引导挂素材，「开始构建」禁用带原因；构建各 phase/state 已有全覆盖卡
- 封面台空态：无方案 → 引导生成；生成中/已批准各有既有视图
- 旧稿在途（状态 approved 但视频已剪到半路）：文案页顶横幅"此稿已有剪辑进度，推进到剪辑继续"——不静默丢进度
- 状态与工作台错位（如 editing 但视频 state 为空）：剪辑台自己的空态兜住，不白屏

**② 最坏输入**
- `confirm_published` / 聊天工具 / IPC 直改状态跳阶段：全部经由收口后的单通道，guard 一体生效
- pre-publish 现实现**忽略 transition 失败仍报"全部通过"**——修为：流转被 guard 拦下时预检结果明示"卡在阶段门：<原因>"，不谎报
- 另一开着的旧标签页推进过时状态：`content:transition` 校验当前状态，冲突人话拒绝（不覆盖）
- 非视频稿被 API 直接打 `editing`：guard 拒
- 推进到 cover_pending 时成片文件被人手删：guard 只认 `videoDone` 戳（决策记录在，文件可重建）——放行并在封面台提示成片缺失

**③ 防呆**
- 推进按钮双击：transition 幂等（同状态→同状态原地合法或第二次因已迁移被拒，均无副作用）
- 剪辑未完成时推进下拉里 cover_pending 灰显带原因，不是点了才报错
- editing → approved 回退：视频进度不清（决策 JSON 全留），横幅说明"回文案不丢剪辑进度"
- 已发布稿件不允许回 editing（既有发布后规则不动）

**④ 失败可见**
- guard 拒绝 → toast 原话；构建失败 → 剪辑台既有 failed/blocked 卡；预检自动流转被 guard 拦 → 预检结果里明示"卡在阶段门：<原因>"

**⑤ 显式不做**
- 文字平台（公众号）流程与页面不变，不进 editing/cover_pending
- 不做阶段回退时的产物清理（决策 JSON 本就保留）
- 不做多稿并行的剪辑队列视图（看板已按状态分列，够用）
- 不做 cover_pending 对公众号封面的启用（下期议）
- 聊天工具（build_video 等）行为不变，只是它们改的状态会反映到工作台路由

## 4. 边界清单（③④已含的不重复）

| # | 边界 | 期望 |
|---|---|---|
| 1 | 视频稿 approved 直接点发布预检 | 预检走 guard，明示卡在剪辑阶段 |
| 2 | editing 中稿件被聊天工具改状态 | 工作台随状态即时切换（SSE 已有），不留幽灵页 |
| 3 | cover_pending 回 editing 再剪 | 合法；重开即清 `videoDone`，重新 done 后才可再推进（`videoReadyAt` 作为首次达成指标不动） |
| 4 | 历史稿 status=cover_pending（孤儿数据） | 直接进封面工作台——复活后它不再是死状态 |
| 5 | 看板拖拽改状态（若支持） | 同一 transition 通道，guard 同样生效 |
| 6 | 剪辑台内"查看文案"时文案被另端改 | 只读视图刷新即新，无编辑冲突面 |

## 5. 实现落点提示

- guard：`src/tools/content-save.ts` 的 `transitionStatus` 调用处或 `local-store.transitionStatus` 内新增 guard 调用（单点）；pre-publish 自动流转同点复用
- 前端：`Editor.tsx` 按状态分派工作台组件（新 `EditingWorkspace.tsx` / `CoverWorkspace.tsx` / `PublishWorkspace.tsx`，内容基本是现有面板的重排）；`VideoPanel` 向导与素材挂接迁入剪辑台
- `content:allowed_transitions` 返回值带 guard 预判（灰显要原因）
