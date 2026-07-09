/**
 * npm run smoke — 真浏览器端到端冒烟（IA v4.2 工程线:「写完自己 dogfood,修完再交付」的固化）。
 *
 * 起隔离 server（AUTOCREW_DATA_DIR=临时目录,绝不碰真实工作区）+ 系统 Chrome headless,
 * 原生 CDP（零新依赖:Node 内置 WebSocket）跑三类检查:
 *   1. 关键动线:首页五卡/看板/回收站/设置/源管理/校准中心/素材/回流/新想法落库往返/会话历史
 *   2. 布局碰撞:#main-area 内可见元素不得越进常驻对话栏（1280 与 1680 双视口——上次布局 bug 的盲区）
 *   3. 零 console error / 未捕获异常
 * 任一失败 → 非零退出码。提交前必跑。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveProfile } from "../src/modules/profile/creator-profile.js";
import { saveTopic, saveContent, updateContent } from "../src/storage/local-store.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 4390 + Math.floor(Math.random() * 100);
const HARD_TIMEOUT_MS = 90_000;

// ── CDP 最小客户端（flat 协议） ────────────────────────────────────────────────
class Cdp {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  readonly events: Array<{ method: string; params: Record<string, unknown> }> = [];

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("CDP WebSocket 连接失败"));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result ?? {});
      } else if (msg.method) {
        this.events.push({ method: msg.method, params: msg.params ?? {} });
      }
    };
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async waitEvent(method: string, timeoutMs = 15_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.events.some((e) => e.method === method)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`等待 CDP 事件超时:${method}`);
  }

  close(): void {
    try { this.ws.close(); } catch { /* noop */ }
  }
}

// ── 种子数据（隔离工作区里造一个有内容的编辑部） ──────────────────────────────
async function seed(dataDir: string): Promise<void> {
  const now = new Date().toISOString();
  await saveProfile({
    industry: "AI 效率工具",
    platforms: ["wechat_mp"],
    audiencePersona: { core: { name: "效率控", painPoints: ["工具太多"] } },
    writingRules: [
      { rule: "短句为主", source: "user_explicit", confidence: 1, createdAt: now },
      { rule: "开头不问候", source: "auto_distilled", confidence: 0.9, scope: "voice_core", createdAt: now },
    ],
    styleBoundaries: { never: [], always: [] },
    competitorAccounts: [],
    performanceHistory: [],
    styleCalibrated: true,
    createdAt: now,
    updatedAt: now,
  }, dataDir);
  for (let i = 1; i <= 3; i++) {
    await saveTopic({ title: `AI 效率选题 ${i}`, description: "d", tags: ["radar"], reason: "命中定位「AI」· 冒烟种子", link: `https://smoke.example/${i}` }, dataDir);
  }
  const c1 = await saveContent({ title: "待审冒烟稿", body: "正文。[IMAGE: 一张示意图]", platform: "wechat_mp", status: "drafting", tags: [] }, dataDir);
  await updateContent(c1.id, { status: "reviewing" }, dataDir);
  const c2 = await saveContent({ title: "已发冒烟稿", body: "正文", platform: "wechat_mp", status: "drafting", tags: [] }, dataDir);
  await updateContent(c2.id, { status: "published", publishedAt: new Date(Date.now() - 2 * 86400_000).toISOString() }, dataDir);
}

// ── 页面内检查脚本（Runtime.evaluate 执行,返回 {fails:[]}） ──────────────────
const PAGE_CHECKS = `(async () => {
  const fails = [];
  const ok = (cond, name, detail) => { if (!cond) fails.push(name + (detail ? "：" + detail : "")); };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // 横向滚动容器（kanban 等）内被裁剪的元素不算碰撞——只要滚动容器本身不越界
  const clippedByScroller = (el, chatLeft) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const ox = getComputedStyle(p).overflowX;
      if ((ox === "auto" || ox === "scroll" || ox === "hidden") && p.getBoundingClientRect().right <= chatLeft + 1.5) return true;
      p = p.parentElement;
    }
    return false;
  };
  const collide = (label) => {
    const chat = document.getElementById("chat-zone");
    if (!chat) return;
    const cl = chat.getBoundingClientRect().left;
    const bad = [];
    for (const el of document.querySelectorAll("#main-area *")) {
      if (!el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 6 && r.height > 6 && r.right > cl + 1.5 && !clippedByScroller(el, cl)) bad.push(el.className || el.tagName);
    }
    ok(bad.length === 0, "布局碰撞@" + label, [...new Set(bad)].slice(0, 4).join(","));
  };

  await sleep(1200);
  // 1) 首页
  ok(document.querySelectorAll(".dash-zone").length === 4, "首页四问分区", "实际 " + document.querySelectorAll(".dash-zone").length);
  ok(document.querySelectorAll(".dash-card").length === 7, "首页七卡(V5.5 四问 IA)", "实际 " + document.querySelectorAll(".dash-card").length);
  ok(/编辑部已就位/.test(document.getElementById("view-dashboard").textContent), "首页问候");
  ok((document.getElementById("view-dashboard").textContent || "").includes("待审队列"), "待审队列卡");
  ok((document.getElementById("view-dashboard").textContent || "").includes("受众画像"), "受众画像卡");
  collide("dashboard");

  // 2) 看板
  switchView("board"); await sleep(500);
  ok((document.getElementById("view-board").textContent || "").includes("灵感库"), "看板灵感列");
  ok(document.querySelectorAll(".atom-card").length >= 3, "看板卡片渲染");
  collide("board");

  // 3) 回收站直达（冷进入曾静默失败——回归钉子）
  switchView("trash"); await sleep(700);
  ok((document.getElementById("view-board").textContent || "").includes("回收站"), "回收站直达");

  // 4) 设置 + 分区
  switchView("settings"); await sleep(500);
  ok(document.querySelectorAll(".settings-zone").length === 2, "设置分区入口");

  // 5) 源管理
  switchView("scout"); await sleep(600);
  ok(document.querySelectorAll(".src-row").length >= 1, "情报源列表");
  ok(!!document.querySelector(".src-add-url"), "情报源添加行");

  // 6) 校准中心
  switchView("style"); await sleep(600);
  ok(!!document.querySelector(".style-pos-input"), "校准中心定位行");
  ok((document.getElementById("panel-style").textContent || "").includes("校准中心"), "校准中心标题");

  // 7) 素材 / 回流 路由
  switchView("library"); await sleep(400);
  ok(!document.getElementById("panel-library").classList.contains("hidden") || document.getElementById("panel-library").classList.contains("active"), "素材库路由");
  switchView("report"); await sleep(400);
  ok(document.getElementById("panel-report").classList.contains("active"), "回流路由");

  // 8) 新想法落库往返（隔离工作区,放心写）
  switchView("dashboard"); await sleep(400);
  document.getElementById("new-task").click(); await sleep(300);
  const idea = document.getElementById("idea-capture-input");
  ok(!!idea, "记想法卡");
  if (idea) {
    idea.value = "[smoke] 想法往返";
    idea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(600);
    const listed = await window.autocrew.topicsList({});
    const hit = (listed.topics || []).find(t => t.title === "[smoke] 想法往返");
    ok(!!hit, "想法落库");
    if (hit) {
      const del = await window.autocrew.topicDelete({ id: hit.id });
      ok(del.ok, "想法删除");
    }
  }

  // 9) 会话历史按钮 + 工作台素材缺口（从看板开一篇待审稿）
  ok(!!document.querySelector(".chat-history-btn"), "会话历史按钮");
  switchView("board"); await sleep(500);
  const cl = await window.autocrew.contentList({});
  const reviewing = (cl.contents || []).find(c => c.status === "reviewing");
  if (reviewing) {
    await openInBoard(reviewing.id, null); await sleep(700);
    ok(!!document.querySelector(".wb-editor"), "工作台编辑器");
    ok(!!document.querySelector(".wb-gaps"), "素材缺口块（[IMAGE:标记解析）");
    ok(document.querySelectorAll(".wb-adopt-row button").length >= 3, "采纳三键");
  } else {
    fails.push("种子待审稿缺失");
  }

  return { fails };
})()`;

// ── 主流程 ────────────────────────────────────────────────────────────────────
let serverProc: ChildProcess | null = null;
let chromeProc: ChildProcess | null = null;
let tmpData = "";
let tmpChrome = "";

async function main(): Promise<number> {
  tmpData = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-smoke-data-"));
  tmpChrome = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-smoke-chrome-"));
  await seed(tmpData);
  console.log(`[smoke] 隔离工作区 ${tmpData}`);

  // server
  serverProc = spawn("npx", ["tsx", "desktop/server.ts"], {
    env: { ...process.env, AUTOCREW_PORT: String(PORT), AUTOCREW_DATA_DIR: tmpData },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverOut = "";
  serverProc.stdout!.on("data", (d) => { serverOut += String(d); });
  serverProc.stderr!.on("data", (d) => { serverOut += String(d); });
  const token = await (async () => {
    for (let i = 0; i < 60; i++) {
      const m = serverOut.match(/token=([a-f0-9]+)/);
      if (m) return m[1];
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("server 未就绪:\n" + serverOut.slice(-500));
  })();
  console.log(`[smoke] server ready :${PORT}`);

  // chrome
  chromeProc = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${tmpChrome}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let chromeErr = "";
  chromeProc.stderr!.on("data", (d) => { chromeErr += String(d); });
  const wsUrl = await (async () => {
    for (let i = 0; i < 60; i++) {
      const m = chromeErr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) return m[1];
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("Chrome 未就绪:\n" + chromeErr.slice(-500));
  })();

  const cdp = new Cdp();
  await cdp.connect(wsUrl);
  const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
  const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);

  const fails: string[] = [];
  const consoleErrors: string[] = [];

  const runChecks = async (width: number, height: number, layoutOnly: boolean) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    cdp.events.length = 0;
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/?token=${token}` }, sessionId);
    await cdp.waitEvent("Page.loadEventFired");
    const expr = layoutOnly
      ? `(async () => { const fails = []; await new Promise(r=>setTimeout(r,1200));
           const chat = document.getElementById("chat-zone").getBoundingClientRect();
           const clipped = (el) => {
             let p = el.parentElement;
             while (p && p !== document.body) {
               const ox = getComputedStyle(p).overflowX;
               if ((ox === "auto" || ox === "scroll" || ox === "hidden") && p.getBoundingClientRect().right <= chat.left + 1.5) return true;
               p = p.parentElement;
             }
             return false;
           };
           const bad = [];
           for (const el of document.querySelectorAll("#main-area *")) {
             if (!el.offsetParent) continue;
             const r = el.getBoundingClientRect();
             if (r.width > 6 && r.height > 6 && r.right > chat.left + 1.5 && !clipped(el)) bad.push(el.className || el.tagName);
           }
           if (bad.length) fails.push("布局碰撞@${width}px：" + [...new Set(bad)].slice(0,4).join(","));
           return { fails }; })()`
      : PAGE_CHECKS;
    const res = (await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)) as {
      result?: { value?: { fails?: string[] } }; exceptionDetails?: { text?: string };
    };
    if (res.exceptionDetails) fails.push(`检查脚本异常@${width}px：${res.exceptionDetails.text ?? "unknown"}`);
    for (const f of res.result?.value?.fails ?? []) fails.push(f);
    // console 错误收集
    for (const e of cdp.events) {
      if (e.method === "Runtime.exceptionThrown") {
        consoleErrors.push(String((e.params.exceptionDetails as Record<string, unknown>)?.text ?? "uncaught"));
      }
      if (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") {
        consoleErrors.push(JSON.stringify((e.params.args as Array<{ value?: unknown }>)?.map((a) => a.value)).slice(0, 160));
      }
    }
  };

  await runChecks(1280, 860, false);  // 全量动线 + 布局（上次真 bug 的宽度）
  await runChecks(1680, 900, true);   // 宽屏布局回归

  // V5.5b:/v2 React 壳(dist 存在才校验——未构建不算失败,构建了就必须能开)
  try {
    await fs.access(path.resolve(import.meta.dirname, "..", "frontend", "dist", "index.html"));
    console.log("[smoke] /v2 dist 存在,校验 React 壳");
    cdp.events.length = 0;
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/v2/?token=${token}` }, sessionId);
    await cdp.waitEvent("Page.loadEventFired");
    const v2 = (await cdp.send("Runtime.evaluate", {
      expression: `(async () => { const fails = [];
        await new Promise(r => setTimeout(r, 1500));
        const t = document.body.textContent || "";
        if (!document.querySelector(".shell")) fails.push("v2 壳未渲染");
        if (document.querySelectorAll(".zone").length !== 4) fails.push("v2 四问分区：实际 " + document.querySelectorAll(".zone").length);
        if (!t.includes("总编辑")) fails.push("v2 对话栏缺失");
        if (!t.includes("受众画像")) fails.push("v2 受众画像卡缺失");
        // B 期动线:导航进看板 → 五列 → 点稿件 chip 进编辑器
        const navBtn = [...document.querySelectorAll(".topnav button")].find(b => b.textContent.trim() === "看板");
        if (!navBtn) { fails.push("v2 看板导航缺失"); return { fails }; }
        navBtn.click();
        await new Promise(r => setTimeout(r, 900));
        if (!document.querySelector(".kanban")) fails.push("v2 看板未渲染");
        if (document.querySelectorAll(".kcol").length !== 5) fails.push("v2 看板列数：实际 " + document.querySelectorAll(".kcol").length);
        const chip = document.querySelector(".acard .chip");
        if (!chip) { fails.push("v2 看板无稿件 chip(种子数据未显示)"); return { fails }; }
        chip.click();
        await new Promise(r => setTimeout(r, 900));
        if (!document.querySelector(".ed-body")) fails.push("v2 编辑器正文缺失");
        if (!document.querySelector(".ed-title")) fails.push("v2 编辑器标题输入缺失");
        if (!(document.body.textContent || "").includes("采纳裁决")) fails.push("v2 采纳裁决行缺失");
        // C 期:校准中心 + 设置
        const navTo = async (label) => {
          const b = [...document.querySelectorAll(".topnav button")].find(x => x.textContent.trim() === label);
          if (!b) { fails.push("v2 导航缺失:" + label); return false; }
          b.click();
          await new Promise(r => setTimeout(r, 700));
          return true;
        };
        if (await navTo("校准中心")) {
          const t2 = document.body.textContent || "";
          if (!t2.includes("写作规则")) fails.push("v2 校准中心规则区缺失");
          if (!t2.includes("受众")) fails.push("v2 校准中心受众行缺失");
        }
        if (await navTo("设置")) {
          const t3 = document.body.textContent || "";
          for (const key of ["引擎", "搜索 API", "发布(publish.json)", "情报源", "工作区"]) {
            if (!t3.includes(key)) fails.push("v2 设置缺区:" + key);
          }
        }
        if (await navTo("素材库")) {
          const t4 = document.body.textContent || "";
          if (!t4.includes("导入素材")) fails.push("v2 素材库导入区缺失");
        }
        if (!(document.body.textContent || "").includes("＋新想法")) fails.push("v2 ＋新想法入口缺失");
        return { fails }; })()`,
      awaitPromise: true, returnByValue: true,
    }, sessionId)) as { result?: { value?: { fails?: string[] } }; exceptionDetails?: { text?: string } };
    if (v2.exceptionDetails) fails.push(`v2 检查脚本异常：${v2.exceptionDetails.text ?? "unknown"}`);
    for (const f of v2.result?.value?.fails ?? []) fails.push(f);
    for (const e of cdp.events) {
      if (e.method === "Runtime.exceptionThrown") {
        consoleErrors.push("v2: " + String((e.params.exceptionDetails as Record<string, unknown>)?.text ?? "uncaught"));
      }
    }
  } catch { /* dist 未构建:跳过 v2 校验 */ }

  if (consoleErrors.length) fails.push(`console 错误 ${consoleErrors.length} 条：${consoleErrors.slice(0, 3).join(" | ")}`);

  cdp.close();
  if (fails.length === 0) {
    console.log("[smoke] ✅ PASS — 动线/布局(1280+1680)/console 全部通过");
    return 0;
  }
  console.error(`[smoke] ❌ FAIL ${fails.length} 项:`);
  for (const f of fails) console.error("  - " + f);
  return 1;
}

const killAll = async () => {
  for (const p of [serverProc, chromeProc]) { try { p?.kill("SIGKILL"); } catch { /* noop */ } }
  for (const d of [tmpData, tmpChrome]) { if (d) await fs.rm(d, { recursive: true, force: true }).catch(() => {}); }
};

const timer = setTimeout(async () => {
  console.error("[smoke] ⏰ 超时强杀");
  await killAll();
  process.exit(1);
}, HARD_TIMEOUT_MS);

main()
  .then(async (code) => { clearTimeout(timer); await killAll(); process.exit(code); })
  .catch(async (err) => { clearTimeout(timer); console.error("[smoke] 崩溃:", err); await killAll(); process.exit(1); });
