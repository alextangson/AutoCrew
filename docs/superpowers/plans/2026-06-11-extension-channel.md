# 浏览器扩展通道 Implementation Plan（MVP）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox tracking.

**Goal:** PRD §6 主读数通道的 MVP：Chrome 扩展（真实 profile、零重登、无 CDP）读创作者后台的**按作品列表页**，经 native messaging 喂进现有导入管线。验证 v1 主通道可行性，替代每周手动导出。

**Architecture（核心决定）:** **扩展 = 另一个 CSV 生产者。** content script 把页面表格抽成 `{列名: 值}` 行 → background → native host → 行序列化为 CSV 文本 → **复用 `importPerformanceCsv` 原样**（校验/打标/对账/幂等/needsReview 全继承，零新数据路径）。抽取选择器是 content script 顶部的**配置常量**（校准=改配置，runbook 模式）。

**红线落实（PRD §6）：** 只读（无任何 DOM 写操作/表单填充）；用户触发（点扩展按钮抓当前页一次，无定时无后台轮询）；不碰登录/不自动导航；人类节奏。

**范围（MVP，锁定）：** 仅抖音（creator.douyin.com 作品列表页）一个适配器——三平台里数据最全（完播率+5s完播率）。视频号/小红书适配器 = 后续配置级增量。扩展手动加载（chrome://extensions 开发者模式）——安装向导归桌面壳计划。**Edge Add-ons 上架不在本计划。**

**可测性边界（诚实声明）：** native host 协议/序列化/ingest 全 vitest（纯函数+temp dataDir）。extension/ 三个文件运行在浏览器，无法进 vitest——验证 = 代码评审 + 实机 dogfood（runbook 流程），extraction 逻辑写成纯函数便于读审。extension/ 用现代纯 JS（无构建步骤，YAGNI），在 tsconfig exclude，eslint 单独豁免说明。

## File Structure

| 文件 | 职责 |
|---|---|
| Create `src/bridge/protocol.ts` + test | Chrome native messaging 帧编解码（4 字节 LE 长度前缀 + JSON）、消息类型 |
| Create `src/bridge/ingest.ts` + test | rows → CSV 文本 → importPerformanceCsv；响应构造 |
| Create `src/bridge/native-host.ts` | stdin/stdout 入口循环（薄，逻辑全在上面两个可测模块） |
| Create `scripts/install-native-host.mts` | 写 Chrome NativeMessagingHosts manifest（macOS 路径，扩展 ID 作参数）+ 生成启动 wrapper |
| Create `extension/manifest.json` `extension/background.js` `extension/content-douyin.js` | MV3 扩展（纯 JS，selector 配置在文件顶部） |
| Modify `docs/dogfood-runbook.md` | 「九、扩展通道 dogfood」安装与校准流程 |

---

### Task 1: 协议 + ingest（纯 TS，全 TDD）

**Files:** `src/bridge/protocol.ts`、`protocol.test.ts`、`src/bridge/ingest.ts`、`ingest.test.ts`

```typescript
// protocol.ts 合同
export interface IngestRowsMessage { type: "ingest_rows"; platform: string; rows: Array<Record<string, string>>; }
export interface PingMessage { type: "ping"; }
export type BridgeMessage = IngestRowsMessage | PingMessage;
export interface BridgeResponse { ok: boolean; type: string; data?: unknown; error?: string; }

/** 4 字节小端长度前缀 + UTF-8 JSON（Chrome native messaging 线格式） */
export function encodeFrame(msg: unknown): Buffer;
/** 增量解码器：feed(chunk) 返回完整消息数组（处理半包/粘包）；非法 JSON 抛带上下文错误 */
export function createFrameDecoder(): { feed(chunk: Buffer): unknown[] };
export function parseBridgeMessage(raw: unknown): BridgeMessage; // 信任边界：类型校验，非法 → 抛中文错误
```

```typescript
// ingest.ts 合同
export function rowsToCsvText(rows: Array<Record<string, string>>): string; // 表头=首行键集，引号转义同 parseCsv 语义
export async function handleBridgeMessage(msg: BridgeMessage, dataDir?: string): Promise<BridgeResponse>;
// ingest_rows → rowsToCsvText → importPerformanceCsv(platform, csv, localDateStamp(), dataDir) → {ok, type:"ingest_result", data: ImportReport}
// platform 必须在 PLATFORM_MAPPINGS 内（错误列出可用值）；rows 空 → 错误；ping → {ok, type:"pong"}
// importPerformanceCsv 抛错 → {ok:false, error 透传}
```

测试要点：编解码往返（含中文/emoji）；半包两次 feed、粘包一次 feed 双消息；长度前缀声明超大(>10MB)→ 抛拒绝（防内存炸）；parseBridgeMessage 拒绝未知 type/缺字段/rows 非数组；rowsToCsvText 引号逗号换行转义后能被 parseCsv 原样读回（往返性质测试）；handleBridgeMessage 真实 temp dataDir 走通 importPerformanceCsv（rows 用抖音真实列名，断言 journal 入库）；未知平台错误；localDateStamp 作为 metricDate（**复用 quality-baseline 导出的 localDateStamp**）。

Commit: `feat: native-messaging bridge protocol + ingest — extension rows reuse the CSV pipeline`

---

### Task 2: host 入口 + 安装脚本

**Files:** `src/bridge/native-host.ts`、`scripts/install-native-host.mts`

1. native-host.ts：stdin 流 → createFrameDecoder → 每消息 parseBridgeMessage + handleBridgeMessage → encodeFrame 写 stdout；顶层 try/catch 把错误编码为 BridgeResponse 而非进程崩溃；**所有日志走 stderr**（stdout 是协议通道）。入口薄（<50 行），不另写测试（逻辑已在 T1 测毕）——在文件头声明此分工。
2. install-native-host.mts：参数=扩展 ID；生成 `~/.autocrew/bridge/launch.sh`（`#!/bin/bash\nexec npx tsx <repo绝对路径>/src/bridge/native-host.ts`，chmod +x）；写 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.autocrew.bridge.json`（name/description/path=launch.sh/type:"stdio"/allowed_origins:["chrome-extension://<ID>/"]）；幂等可重跑；打印验证步骤。无测试（一次性安装脚本，dogfood 验证），头注释声明。

Commit: `feat: native host entry + installer — stdio loop, stderr-only logging`

---

### Task 3: 扩展三件套（纯 JS，评审+实机验证）

**Files:** `extension/manifest.json`、`extension/background.js`、`extension/content-douyin.js`；tsconfig exclude `extension/`

1. manifest.json：MV3；`action` 按钮；content_scripts 匹配 `https://creator.douyin.com/*`；permissions: `["nativeMessaging", "activeTab", "scripting"]`；**不申请 tabs/全站 host 权限**（最小权限=红线姿态）。
2. content-douyin.js：顶部 `SELECTOR_CONFIG`（表格行/列到字段名的映射，**字段名直接用 PLATFORM_MAPPINGS.douyin 认识的中文列名**：作品名称/发布时间/播放量/完播率/5s完播率/点赞量/评论量/分享量/收藏量/粉丝增量）；`extractRows()` 纯函数：查表格 DOM → 行数组（值为 innerText.trim()）；监听 background 的 `{cmd:"extract"}` 消息 → 返回 `{rows, pageUrl, rowCount}`；**零 DOM 写操作**。选择器初值按通用表格结构写（`table tbody tr` 兜底 + 列序映射），头注释写明"首次使用必校准（runbook 九）"。
3. background.js：action.onClicked → 校验 tab URL 是 creator.douyin.com → chrome.tabs.sendMessage 取行 → `chrome.runtime.connectNative("com.autocrew.bridge")` → 发 `{type:"ingest_rows", platform:"douyin", rows}` → 收响应 → `chrome.notifications` 或 badge 显示导入结果（成功 N 条/错误）；连接失败提示"先运行 install-native-host"。
4. 三个文件全部带红线头注释（只读/用户触发/无轮询）。

Commit: `feat: chrome extension MVP — douyin works-list reader, read-only, user-triggered`

---

### Task 4: runbook + 收尾

1. runbook 「九、扩展通道 dogfood（v1 主通道预演）」：chrome://extensions 开发者模式加载 extension/ → 复制扩展 ID → `npx tsx scripts/install-native-host.mts <ID>` → 打开抖音创作者中心作品列表页 → 点扩展按钮 → 看通知/`autocrew_flywheel action=report` 复核；**首次必校准 SELECTOR_CONFIG**（症状：rowCount=0 或 rejected 全军——开 DevTools 看真实表格结构改配置）；红线提醒（每周手动点一次，别频繁刷）；与 CSV 导出并行可用（同一管线幂等，混用安全）。
2. 终验：`npx vitest run`（baseline 385，记录确切数）+ `npx tsc --noEmit` 0（确认 extension/ 被 exclude 不进 tsc）+ extension JS 语法校验（`node --check extension/*.js`）。

Commit: `docs: extension channel dogfood guide — install, calibrate, red lines`

## Self-Review

- §6 主通道 MVP ✓（扩展+native messaging，真实 profile 零 CDP）；红线四条全部落实为代码形态（无写操作/无轮询/最小权限/用户触发）✓；复用导入管线（幂等/verify/对账零重写）✓。
- 范围边界已锁：单平台、手动加载、不上架、安装向导归桌面壳——四者均显式记录。
- 可测性诚实：T1/T2 逻辑层全测，extension/ 评审+实机；无假装覆盖。
- 类型链：BridgeMessage/ImportReport/localDateStamp 全部复用既有导出；执行序=文档序。
