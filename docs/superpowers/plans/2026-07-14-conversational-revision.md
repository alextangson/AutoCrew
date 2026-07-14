# 对话式修改 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把选段/整篇修改从"一次性二选一"改成一段锚定焦点、可反问、可迭代的对话——对话在总编辑,红绿 diff 长在编辑器,采纳时才学习。

**Architecture:** 一个客户端共享 store(`revision.ts`,照抄 `ui.tsx` 的 module-observable)持有「修改焦点」和「修改提案」。编辑器设置焦点、渲染提案的红绿 diff、收下时落库;总编辑读焦点、产出提案卡。后端 `reviseFocus` 复用写手路由,二选一返回"反问"或"改写(限焦点范围)";采纳走新通道 `draft:adopt_revision`(存新版本 + 触发延迟学习)。

**Tech Stack:** TypeScript,React(frontend/),tsx 后端,vitest,现有 runLoop/writer 路由/pending-edit diff/record_edit 蒸馏管线。

**Spec:** `docs/superpowers/specs/2026-07-14-conversational-revision-design.md`

---

## File Structure

- **Create** `src/modules/writing/revise-focus.ts` — `reviseFocus()`:入(contentId, instruction, focus)→ 出 `{kind:'question'}` 或 `{kind:'revision'}`。复用写手路由 + writingRules。单一职责:一次焦点范围的"问或改"。
- **Modify** `src/desktop/chat-router.ts` — 对话轮 context 增 `revision_focus`;加 `revise_focus` 工具(调 reviseFocus,question→回复,revision→ `revision_proposal` 卡,不落库);system prompt 增焦点规则。
- **Modify** `src/desktop/channels.ts` + `channel-contracts.ts` + `ipc.ts` — 加 `draft:adopt_revision` 通道 + handler(存新版本 + record_edit 学习)。
- **Create** `frontend/src/revision.ts` — 共享 store:focus/proposal 的 set/clear/subscribe + hooks。
- **Modify** `frontend/src/chat/ChatDock.tsx` — 读 focus 塞进 turn context;渲染「正在改:…」焦点条;`revision_proposal` 卡 → `setProposal`。
- **Modify** `frontend/src/views/Editor.tsx` + `frontend/src/views/SelectionBar.tsx` — 选段「改这段」/无选「改这篇」设焦点;读 proposal 渲染红绿 diff;「收下这版」采纳。
- **Create** `frontend/src/apply-span.ts` — 纯函数 `applySpan(body, start, end, span)`(收下选段时替换);可单测(把 Editor 里 adoptPending 的替换逻辑抽纯)。

---

## Task 1: `reviseFocus` —"问或改"的核心原语

**Files:**
- Create: `src/modules/writing/revise-focus.ts`
- Test: `src/modules/writing/revise-focus.test.ts`

**Interface(先定死,后续任务引用):**
```ts
export type ReviseFocus =
  | { scope: "draft" }
  | { scope: "selection"; selection: string };

export type ReviseFocusResult =
  | { kind: "question"; question: string }
  | { kind: "revision"; title?: string; body?: string; span?: string };

export async function reviseFocus(
  contentId: string,
  instruction: string,
  focus: ReviseFocus,
  dataDir?: string,
  deps?: { runLoopImpl?: RunLoopImpl },
): Promise<ReviseFocusResult>;
```

实现要点:复用 `reviseDraft` 的写手路由 + `loadProfile().writingRules` 注入。给 runLoop 两个工具 `submit_question({question})` 与 `submit_revision({title?, body?, span?})`,模型**只调一个**。system prompt:焦点信息不足就 `submit_question` 反问;充分就 `submit_revision`——`selection` 范围只回 `span`(改写后的这一段),`draft` 范围回完整 `title`+`body`,禁止省略。

- [ ] **Step 1: 写失败测试**(mock runLoop,断言不变量,不冻结文本):
```ts
// selection + 清楚指令 → 调 submit_revision → kind==='revision', span 非空
// selection + 模糊指令 → 调 submit_question → kind==='question', question 非空, 无 span
// draft 范围 → submit_revision → body 非空
```
mock 方式:`deps.runLoopImpl` 直接调传入的 tool.execute 模拟模型选择(参照 `style-distiller.test.ts` 的 runLoop 注入)。
- [ ] **Step 2:** 跑测试确认 FAIL(函数未定义)。`npx vitest run src/modules/writing/revise-focus.test.ts`
- [ ] **Step 3:** 实现 `reviseFocus`(照 `draft-revision.ts` 结构)。
- [ ] **Step 4:** 跑测试确认 PASS。
- [ ] **Step 5:** `npm run typecheck` 绿。
- [ ] **Step 6:** commit `feat: reviseFocus — scoped revise-or-ask primitive`

---

## Task 2: `revise_focus` 对话工具 + 焦点上下文 + 提案卡

**Files:**
- Modify: `src/desktop/chat-router.ts`(runChatTurn 参数/上下文、TOOL_ROLE 表、工具注册、SYSTEM_PROMPT)
- Test: `src/desktop/chat-router.test.ts`(已存在,加用例)

实现要点:
- chat:turn 的 `context` 已带 `content_id`;扩成也接 `revision_focus: {scope, selection?}`。runChatTurn 读它。
- 注册工具 `revise_focus`:无参或 `{instruction}`;从 context 取 focus + contentId,调 `reviseFocus`。
  - `kind==='question'` → 工具返回该问题文本(进 reply),**不产卡、不落库**。
  - `kind==='revision'` → push 一张 `revision_proposal` 卡 `{focus, title?, body?, span?}`,**不落库**。
- SYSTEM_PROMPT 增:存在 revision_focus 时,针对该范围用 `revise_focus`——不清楚先反问,清楚才改;**改动只提案不保存,提示用户「收下这版」才落**。
- TOOL_ROLE:`revise_focus: { role:"writer", label:"编剧正在改这段" }`。

- [ ] **Step 1:** 写失败测试:带 `revision_focus` 的 turn + mock reviseFocus 回 revision → 结果 cards 含 `revision_proposal`;回 question → reply 含该问、无 proposal 卡、无版本落库。
- [ ] **Step 2:** 跑测试确认 FAIL。
- [ ] **Step 3:** 实现(工具 + context + prompt)。
- [ ] **Step 4:** 跑测试确认 PASS;`npm run typecheck` 绿。
- [ ] **Step 5:** commit `feat: revise_focus chat tool + focus context + proposal card`

---

## Task 3: `draft:adopt_revision` — 采纳落库 + 延迟学习

**Files:**
- Modify: `src/desktop/channels.ts`(加 `"draft:adopt_revision"`)、`channel-contracts.ts`(`["content_id","body"]`)、`ipc.ts`(import + 注册 + handler)
- Test: `src/desktop/ipc.test.ts` 或新 `src/desktop/adopt-revision.test.ts`

Handler `draftAdoptRevisionHandler({content_id, title?, body, before?, feedback?})`:
1. `content:update`(现成路径)存新 body/title → 新版本(旧版进版本记录)。
2. 若有 `before` 与 `feedback`:调现成学习管线 `recordDiff`/`style:record_edit`(before→body,note=feedback)→ 沉淀 style rule。**只在这里学**(采纳即闸门)。

- [ ] **Step 1:** 写失败测试:adopt → 版本数 +1;传 before+feedback → 学习**恰好触发一次**;不传 → 不学。(用临时 dataDir + mock 学习依赖计数。)
- [ ] **Step 2:** 跑测试确认 FAIL。
- [ ] **Step 3:** 实现三处接线 + handler。
- [ ] **Step 4:** 跑测试确认 PASS;`npm run typecheck` 绿。
- [ ] **Step 5:** commit `feat: draft:adopt_revision — save version + gated learning`

---

## Task 4: 前端共享 store `revision.ts`

**Files:**
- Create: `frontend/src/revision.ts`
- Test: `frontend/src/revision.test.ts`

照抄 `ui.tsx` 的 module-observable:
```ts
export interface RevisionFocus { contentId: string; scope: "selection" | "draft"; selection?: { start: number; end: number; text: string }; }
export interface RevisionProposal { contentId: string; scope: "selection" | "draft"; title?: string; body?: string; span?: string; selection?: { start: number; end: number; text: string }; }
// setFocus/clearFocus/getFocus, setProposal/clearProposal/getProposal, subscribe(fn)
// hooks: useRevisionFocus(), useRevisionProposal()  (useState+useEffect 订阅)
```

- [ ] **Step 1:** 写失败测试:setFocus → getFocus 返回之;subscribe 收到通知;clearProposal 后 getProposal===null。
- [ ] **Step 2:** 跑测试确认 FAIL。`npx vitest run frontend/src/revision.test.ts`
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑测试确认 PASS。
- [ ] **Step 5:** commit `feat: client revision store (focus + proposal)`

---

## Task 5: 纯函数 `applySpan` + 编辑器接线

**Files:**
- Create: `frontend/src/apply-span.ts`
- Test: `frontend/src/apply-span.test.ts`
- Modify: `frontend/src/views/Editor.tsx`、`frontend/src/views/SelectionBar.tsx`

`applySpan(body, start, end, span)` = `body.slice(0,start)+span+body.slice(end)`(把 Editor 现有 adoptPending 替换逻辑抽纯、可单测)。

编辑器接线(组件,靠跑通验证,不强求单测):
- 选段 → SelectionBar 的「改这段」→ `setFocus({contentId, scope:'selection', selection:{start,end,text}})` + 聚焦对话(移除原内联一次性改写)。无选 → 面板「改这篇」→ `setFocus(scope:'draft')`(收编「基本要重写」死路)。
- `useRevisionProposal()`:属于本稿时——selection→在该 span 渲染红绿 diff(复用 `.pe-before/.pe-after`),**待定期间锁正文手改防错位**;draft→提案 body 作待定,配版本 diff 对比。
- 「收下这版」→ `invoke('draft:adopt_revision', {content_id, title?, body/applySpan结果, before, feedback})` → `clearFocus/clearProposal` → reload。

- [ ] **Step 1:** 写 `applySpan` 失败测试:替换中段、首段、末段;start===end(插入)。
- [ ] **Step 2:** 跑测试确认 FAIL。
- [ ] **Step 3:** 实现 `applySpan`;编辑器/SelectionBar 接线用它。
- [ ] **Step 4:** 跑测试确认 PASS;`npm run fe:build` 绿。
- [ ] **Step 5:** commit `feat: applySpan + editor revision focus/adopt wiring`

---

## Task 6: ChatDock 接焦点 + 路由提案卡

**Files:**
- Modify: `frontend/src/chat/ChatDock.tsx`
- (卡类型)`frontend/src/chat/cards.tsx` / `response.ts` — 加 `revision_proposal` 卡形

实现要点:
- `useRevisionFocus()`:有焦点时 chat:turn 的 `context` 带 `revision_focus`;顶部渲染「正在改:〈这段/整篇〉」条 + × (`clearFocus`)。
- 解析回复卡时,`revision_proposal` → `setProposal(...)`(送进 store 给编辑器),不在对话里重复渲染整段绿字(diff 归编辑器)。

- [ ] **Step 1:** 写失败测试(逻辑层):给定 focus,构造的 turn payload.context 含 `revision_focus`;解析含 `revision_proposal` 的回复 → 调用 setProposal。(把这两段抽成可测纯函数。)
- [ ] **Step 2:** 跑测试确认 FAIL。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑测试确认 PASS;`npm run fe:build` 绿。
- [ ] **Step 5:** commit `feat: ChatDock revision focus chip + proposal routing`

---

## 集成验证(全部任务后)

- [ ] `npm run check`(typecheck + lint + test)全绿。
- [ ] `npm run fe:build` 绿。
- [ ] 重启 server,在浏览器里跑一遍真实闭环:选段→改这段→模糊指令收到反问→补充→出红绿 diff→再迭代一版→收下→版本+1→确认 style rule 落库(`~/.autocrew` learnings)。截图留证。

---

## Self-Review

**Spec coverage:** 反问=Task1/2(question 分支+prompt);迭代=对话天然+proposal 反复更新(Task2/6);部分采纳=对话+手改绿字(Task5);选段焦点=Task4/5;整篇=scope:draft 全程;采纳即学习闸门=Task3;diff 在编辑器/对话只承来回=Task5/6。全覆盖。

**Placeholder scan:** 无 TBD;组件接线标注"靠跑通验证"是有意的(React 组件不强 TDD),但可测不变量都抽成纯函数(applySpan / payload 构造 / 提案解析)有单测。

**Type consistency:** `ReviseFocus`/`ReviseFocusResult`(Task1)↔ `revise_focus` 工具(Task2)↔ `RevisionProposal`(Task4)↔ adopt payload(Task3/5)字段一致:`scope`、`selection{start,end,text}`、`title?/body?/span?`。
