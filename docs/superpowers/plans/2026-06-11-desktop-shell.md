# 桌面壳 Implementation Plan（MVP）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox tracking.

**Goal:** PRD §5 桌面应用外壳的 MVP：Electron（§14 Q1 就此裁决——引擎是 TS/Node，单运行时换 v1 速度）+ 本地 web UI，把已建成的全部能力（生成/稿件/回流报告/风格）装进非技术用户能用的界面。**OpenClaw 宿主依赖归零**：UI 经 IPC 直调进程内函数。

**Architecture:** `desktop/main.ts` + `desktop/preload.ts`（esbuild 打包成 CJS——esbuild 已随 tsx 在 node_modules，零新增构建依赖；构建脚本 `scripts/build-desktop.mts`）。渲染层 `desktop/renderer/` 纯 HTML/JS/CSS **无构建步骤**（与 extension/ 同姿势，tsconfig exclude，node --check 把关）。IPC：contextIsolation + preload 白名单通道，main 侧 handler 是 `src/desktop/ipc.ts`（纯 TS，**vitest 可测**——薄包装已测过的 execute* 函数）。四屏：①回流报告（首屏=report 数据：works/avgMetrics/insights/needsReview）②生成（topic+platform → autocrew_generate → 展示稿件+violations）③稿件（列表/clipboard 复制/confirm_published）④风格（规则列表/distill/absorb）。

**设计决定（锁定）：**
- **Electron 而非 Tauri**：引擎 TS/Node 同进程直调（Tauri 需 sidecar + IPC 序列化两层）；包大的代价 v1 接受（§9 已记入分发预算）。PRD §14 Q1 随本计划关闭。
- **渲染层零框架零构建**：四屏量级用不上 React（YAGNI）；fetch 式交互全走 `window.autocrew.*`（preload 暴露）。桌面 UI 美化是 v1.5（先能用）。
- **不做自动更新/打包分发**：dogfood 用 `npm run app` 启动；electron-builder/签名/公证是发布期工作（§9 预算项），显式推迟。
- 安全基线：`contextIsolation: true`、`nodeIntegration: false`、CSP meta、preload 只暴露白名单方法（invoke 通道枚举固定）。
- 引擎 key：复用现有 loadEngineConfig（env/engine.json）——UI 引导写 engine.json 是 v1.5，本计划 runbook 说明。

## File Structure

| 文件 | 职责 |
|---|---|
| Create `src/desktop/ipc.ts` + test | IPC 通道合同 + handler 注册表（纯函数，薄包装 execute*）|
| Create `desktop/main.ts`、`desktop/preload.ts` | Electron 主进程（窗口/IPC 接线）与 preload 白名单 |
| Create `scripts/build-desktop.mts` | esbuild 打包 main/preload → desktop/dist/*.cjs |
| Create `desktop/renderer/index.html`、`app.js`、`style.css` | 四屏 UI（零构建纯 JS）|
| Modify `package.json` | devDep electron；scripts: `build:desktop`、`app` |
| Modify `docs/dogfood-runbook.md` | 「十、桌面壳 dogfood」|

---

### Task 1: IPC 合同 + handler 注册表（纯 TS，全 TDD）

**Files:** `src/desktop/ipc.ts`、`ipc.test.ts`

```typescript
// 合同
export const IPC_CHANNELS = [
  "flywheel:report", "generate:script", "style:distill", "style:absorb",
  "content:list", "content:get", "publish:clipboard", "publish:confirm",
] as const;
export type IpcChannel = (typeof IPC_CHANNELS)[number];

/** 每通道一个 handler：吃 payload（Record<string, unknown>），回 {ok, data?, error?}（复用工具层结果形状） */
export type IpcHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
export function buildIpcHandlers(deps?: Partial<Record<IpcChannel, IpcHandler>>): Record<IpcChannel, IpcHandler>;
```

实现：每个 handler 直调既有 execute*（**先读各工具实际签名**：executeFlywheel/executeGenerate/executeStyle/executeContentSave/executePublish——payload 原样透传 + 注入 action 字段，如 `"flywheel:report"` → `executeFlywheel({action: "report", ...payload})`）；deps 注入覆盖单通道（测试用）；未知 payload 类型容错（非对象 → {ok:false}）。所有 handler 不抛——catch 转 {ok:false, error}（渲染层只处理一种失败形状）。

测试：8 通道全部有 handler；mock 注入验证 action 注入正确（如 publish:confirm → action=confirm_published）；handler 抛错 → {ok:false, error}；非对象 payload → {ok:false}；真实 temp dataDir 走通 flywheel:report（复用既有测试套路）。

Commit: `feat: desktop IPC contract — typed channels over the existing tool layer`

---

### Task 2: Electron 主进程 + 构建

**Files:** `desktop/main.ts`、`desktop/preload.ts`、`scripts/build-desktop.mts`；Modify `package.json`

1. `npm install -D electron`（版本取当前稳定 major）。
2. main.ts：app.whenReady → BrowserWindow（1100×750，webPreferences：contextIsolation true / nodeIntegration false / preload=dist 路径）→ loadFile(renderer/index.html)；`for (const ch of IPC_CHANNELS) ipcMain.handle(ch, (_e, payload) => handlers[ch](payload))`（handlers = buildIpcHandlers()）；mac 关窗不退出的常规处理；CSP 由 index.html meta 声明。
3. preload.ts：`contextBridge.exposeInMainWorld("autocrew", Object.fromEntries(IPC_CHANNELS.map(ch => [chToMethod(ch), (payload) => ipcRenderer.invoke(ch, payload ?? {})])))`——`chToMethod`: `"flywheel:report"` → `flywheelReport`（驼峰化，**合同写死在 preload 与渲染层共识里，列出全部 8 个方法名**：flywheelReport/generateScript/styleDistill/styleAbsorb/contentList/contentGet/publishClipboard/publishConfirm）。
4. build-desktop.mts：esbuild API（`import {build} from "esbuild"`——esbuild 在 node_modules 经 tsx 依赖存在；若 import 失败则 `npm i -D esbuild` 显式声明）bundle 两入口 → `desktop/dist/main.cjs`、`desktop/dist/preload.cjs`（platform:"node", external:["electron"], format:"cjs", bundle:true）。
5. package.json scripts：`"build:desktop": "tsx scripts/build-desktop.mts"`、`"app": "npm run build:desktop && electron desktop/dist/main.cjs"`。
6. tsconfig：`desktop/renderer` exclude（main/preload 是 TS 进 tsc；renderer 纯 JS 不进）。
7. 验证：`npm run build:desktop` 产物存在且 `node --check` 通过（CJS 可 check）；tsc 0；套件无回归。**GUI 启动冒烟留给 dogfood（无头环境无法验证窗口）——报告中声明。**

Commit: `feat: electron shell — window, whitelisted IPC, esbuild bundling`

---

### Task 3: 渲染层四屏（纯 JS，评审 + 实机 dogfood 验证）

**Files:** `desktop/renderer/index.html`、`app.js`、`style.css`

1. index.html：CSP meta（`default-src 'self'`）；左侧 nav（报告/生成/稿件/风格四项）+ 主区四个 section（全部渲染在 DOM 中、按 nav 切 display——无路由库）。
2. app.js（每屏一个 init 函数 + 一个轻量 `h()` DOM helper，禁 innerHTML 注入用户数据——XSS 基线）：
   - **报告屏（首屏）**：load 时 `autocrew.flywheelReport()` → 指标卡（作品数/平均播放/平均完播率/打标进度 traitSampleSize/3）+ insights 列表 + needsReview 列表（含确认提示语）+ byPlatform 简单条形（纯 CSS div 宽度，不引图表库）。
   - **生成屏**：topic 输入框 + platform 下拉（5 平台）+ research 可选多行 → `autocrew.generateScript({topic, platform, research})` → 生成中状态（按钮禁用 + 文案）→ 成功：展示 title/body/hashtags/tokensUsed + violations 红色警示（非空时）+「去稿件屏发布」引导；失败：error 原文展示（引擎未配置的提示要原样可读——含 DEEPSEEK_API_KEY 指引）。
   - **稿件屏**：`autocrew.contentList()` → 列表（标题/平台/状态/时间，按时间倒序）→ 点击 → 详情（body 全文 + hashtags）+ 两个动作：「复制发布文案」（`autocrew.publishClipboard({content_id})` → 结果写剪贴板 `navigator.clipboard.writeText` + 提示）和「确认已发布」（输入 publish_url 可选 → `autocrew.publishConfirm({content_id, publish_url})` → 状态刷新）。
   - **风格屏**：profile 的 writingRules 列表（经 `autocrew.contentGet`? 不——**Task 1 需补一个 `style:rules` 通道**读 loadProfile 的 writingRules/styleBoundaries；本计划修订：IPC_CHANNELS 共 9 个）+「从编辑中学习」按钮（styleDistill → summary 展示）+ 爆款吸收 textarea（1-5 条，每行一条 → styleAbsorb({samples})）。
3. 交互基线：每个按钮有 loading/disabled 态；所有 `{ok:false}` 走统一 toast（顶部红条 5s）；空态文案（无稿件/无规则/无数据时引导动作）。
4. 验证：`node --check desktop/renderer/app.js`；评审即门（与 extension/ 同姿势）；GUI 实机冒烟留 dogfood。

Commit: `feat: renderer four screens — report, generate, drafts, style`

---

### Task 4: runbook + 收尾

1. **Task 1 修订回填**：`style:rules` 通道（读 profile → {rules, boundaries}）补进 IPC 合同与测试（9 通道）。
2. runbook 「十、桌面壳 dogfood」：启动（`npm run app`）；首屏即回流报告（与 autocrew_flywheel report 同源）；生成→发布→confirm 全流程在 UI 内闭环演示步骤；引擎 key 配置说明（沿用 engine.json/env——UI 配置页是 v1.5）；已知边界（无自动更新/未打包/美化待 v1.5）。
3. 终验：`npx vitest run`（记录确切数）+ `npx tsc --noEmit` 0 + `node --check desktop/renderer/app.js` + `npm run build:desktop` 产物存在。
4. PRD §14 Q1 划掉（已裁决：Electron，引用本计划）。

Commit: `docs: desktop shell dogfood guide; PRD Q1 closed — Electron`

## Self-Review

- PRD §5 桌面外壳 MVP ✓（本地 web UI/打包引擎；扩展安装向导**显式推迟 v1.5**——现阶段 runbook 第九章已覆盖手动流程）；§14 Q1 关闭 ✓；OpenClaw 宿主依赖归零（IPC 直调）✓。
- 可测性诚实：ipc.ts 全 TDD；main/preload 构建产物 node --check；renderer 评审即门 + 实机 dogfood——与 extension/ 同一姿势，无假装覆盖。
- 边界全部显式：零框架渲染层（美化 v1.5）、不打包不签名不自动更新（发布期）、key 配置 UI（v1.5）。
- 类型链：IPC_CHANNELS 9 通道为唯一合同源（main 注册/preload 暴露/渲染层调用三处同源）；执行序=文档序。
