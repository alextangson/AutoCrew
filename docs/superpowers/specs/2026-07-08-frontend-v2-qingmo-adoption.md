# 前端 v2:提取 qingmo 设计细节,AutoCrew 原生实现(设计契约)

> 日期:2026-07-08 · 依据:PRD-v4 §11(本地 server + 浏览器)+ 创始人批评「只换壳,没实现动态工作流」
> 裁决(2026-07-08 创始人纠偏):**只取设计细节,不取代码**。qingmo 被放弃的根因 = 多租户账号隔离在
> 内容分发上无解——那套前端绑着多租户 SaaS 架构,搬回来 = 把包袱拖回来。AutoCrew 保持本地单租户 +
> 自有前端(现 vanilla,编辑部风),qingmo 仅作设计规格书:拖拽/回收站/灵感库列/平台矩阵/任务动态/编辑器细节,逐项原生重实现。

## 为什么(根因,不是感觉)

创始人连续三轮对 vanilla 前端不满(小编辑框/状态不能退/没删除没回收站/子页面是静态壳/没有 Polsia 任务动态感)。
逐条核对 qingmoagent/frontend:**全部已存在成熟实现**——
pipeline 混合看板(第一列=选题库 Topic 卡,后列=Content 卡)、HTML5 拖拽换状态、每卡移入回收站+回收站弹窗恢复、
inbox 数字员工工作台(feed 情报卡/自动工作历史/待决策/cron)、contents/[id] 编辑器(60vh+自动保存+选中浮层 AI 快改)、
diff 全家桶(inline-diff/block-diff/pending-edit-card + diff-match-patch)、calibration 风格校准、assets/broll、records 复盘。
**这些设计细节按规格逐项在 AutoCrew 原生实现——代码不搬(多租户/云依赖是已知弃因)。**

## 红线(继承,不重谈)

- 引擎/数据/发布链全部本地(PRD-v4 §11);qingmo 前端剥掉 auth/org/多租户/订阅——**搬前端,不搬云**。
- musegzh 的云端 qingmo 照跑,不动。
- 编辑部风视觉 token(§7.3-4)覆盖 qingmo 的彩色系:衬线/等宽/近黑白/发丝线。

## IA v4.1(回应创始人逐条)

**管线(单看板,idea 为主体):**
灵感库(Topic 卡)→ 在写 → 待审 → 待发 → 已发(卡上带回流数据)
- 卡 = 观点/idea。**点开 idea → 平台矩阵**:抖音/小红书/视频号/公众号/B站/Twitter/Instagram/Reddit——
  有稿的平台亮起点进编辑器;无稿的显示「生成」→ 派生该平台原生变体(裂变时刻)。
  英文平台按 PRD 裁决 F 排队:矩阵中显示为「席位未开通」,诚实呈现,不假装能写。
- 拖拽换列 = content:transition(回退边已开);每卡可删 → 回收站(soft delete+restore)。
- 数据模型:idea = 既有 Topic 实体,变体 = Content.topicId(取代 siblings hack)。

**任务动态(Polsia Tasks):**
- 引擎事件加 runId(chat turn / 调度批次);前端按 runId 聚合成任务卡:进行中(SSE 实时步进)/完成(产物链接)。
- 复用 qingmo inbox 的 auto-work-history + pending-decisions 结构。任务卡出现在主区顶部任务带 + 右栏对话内。

**子页面处置(深改,不换壳):**
| 旧页 | 处置 |
|---|---|
| 选题侦察员 | **页面死**。雷达产出直接流入灵感库列;情报以 feed 卡进任务带。源配置进设置 |
| 素材 | 编辑器内上下文挂接为主;完整管理页移植 qingmo assets/broll,菜单可达 |
| 风格 | 移植 qingmo calibration(校准中心),归入设置,低频 |
| 数据 | 已发卡片上 + 移植 qingmo records/[id] 复盘页 |

## 引擎补口(小,先行)

1. Topic/Content soft-delete + trash 列表 + restore 通道(对齐 qingmo 语义:trashed/archived)
2. 平台枚举扩全域(twitter/instagram/reddit…,生成能力按包排队,类型先行)
3. event-hub 事件加 runId;chat turn 透传
4. Topic 聚合端点:idea + 各平台变体状态一次返回(平台矩阵的数据源)

## 分期

- **A 脚手架**:Vite+React SPA(不用 Next——本地静态托管,免 SSR/export 纠缠),本地 server 托管 dist;
  transport hook(invoke+SSE);编辑部风 token;两区 shell(主区+总编辑常驻)。
- **B 管线**:pipeline 页移植(拖拽/回收站/混合列)+ 平台矩阵 + contents/[id] 编辑器(自动保存/选中快改/diff)。
- **C 动态**:任务卡(runId 聚合)+ inbox 情报流 + calibration/assets/records 移植。
- **D 清场**:删 vanilla renderer(app/board/today/views/chat/workbench.js 等)与 Electron 壳残留。

每期结束:真浏览器 CDP 验证 + 截图 + 全量测试,不攒大爆炸。
