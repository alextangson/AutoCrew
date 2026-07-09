/**
 * npm run smoke — 真浏览器端到端冒烟（IA v4.2 工程线:「写完自己 dogfood,修完再交付」的固化）。
 *
 * 起隔离 server（AUTOCREW_DATA_DIR=临时目录,绝不碰真实工作区）+ 系统 Chrome headless,
 * 原生 CDP（零新依赖:Node 内置 WebSocket）跑三类检查（D 期后被测对象 = React 前端）:
 *   1. 关键动线:工作台四问九卡(V5.6 +目标卡)/看板五列/回收站往返/编辑器(框选区+采纳+素材)/校准中心/设置六区/素材库/会话控件
 *   2. 布局碰撞:.main 内可见元素不得越进常驻对话栏 .dock（1280 与 1680 双视口）
 *   3. 零 console error / 未捕获异常
 * 前置:frontend/dist 必须已构建(npm run fe:build),缺失即失败。任一失败 → 非零退出码。提交前必跑。
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

// ── 页面内检查脚本（Runtime.evaluate 执行,返回 {fails:[]}）——React 全链走查 ──
const PAGE_CHECKS = `(async () => {
  const fails = [];
  const ok = (cond, name, detail) => { if (!cond) fails.push(name + (detail ? "：" + detail : "")); };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // 横向滚动容器（kanban 等）内被裁剪的元素不算碰撞——只要滚动容器本身不越界
  const clippedByScroller = (el, dockLeft) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const ox = getComputedStyle(p).overflowX;
      if ((ox === "auto" || ox === "scroll" || ox === "hidden") && p.getBoundingClientRect().right <= dockLeft + 1.5) return true;
      p = p.parentElement;
    }
    return false;
  };
  const collide = (label) => {
    const dock = document.querySelector(".dock");
    if (!dock) { fails.push("对话栏缺失@" + label); return; }
    const dl = dock.getBoundingClientRect().left;
    const bad = [];
    for (const el of document.querySelectorAll(".main *")) {
      if (!el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 6 && r.height > 6 && r.right > dl + 1.5 && !clippedByScroller(el, dl)) bad.push(el.className || el.tagName);
    }
    ok(bad.length === 0, "布局碰撞@" + label, [...new Set(bad)].slice(0, 4).join(","));
  };
  const navTo = async (label) => {
    const b = [...document.querySelectorAll(".topnav button")].find(x => x.textContent.trim() === label);
    if (!b) { fails.push("导航缺失:" + label); return false; }
    b.click();
    await sleep(700);
    return true;
  };

  await sleep(1500);
  // 1) 工作台(四问 IA)
  ok(!!document.querySelector(".shell"), "壳渲染");
  ok(document.querySelectorAll(".zone").length === 4, "四问分区", "实际 " + document.querySelectorAll(".zone").length);
  // V5.6:+目标卡(北极星) → 九卡
  ok(document.querySelectorAll(".card").length === 9, "工作台九卡", "实际 " + document.querySelectorAll(".card").length);
  const t = document.body.textContent || "";
  ok(t.includes("编辑部已就位"), "问候行");
  ok(t.includes("待审队列"), "待审队列卡");
  ok(t.includes("受众画像"), "受众画像卡");
  ok(t.includes("目标"), "目标卡");
  ok(t.includes("总编辑"), "对话栏");
  ok(t.includes("＋新想法"), "＋新想法入口");
  ok(t.includes("＋新会话"), "会话控件");
  collide("dashboard");

  // 2) 看板:五列 → 回收站往返 → 编辑器
  if (await navTo("看板")) {
    ok(!!document.querySelector(".kanban"), "看板渲染");
    ok(document.querySelectorAll(".kcol").length === 5, "看板五列", "实际 " + document.querySelectorAll(".kcol").length);
    ok(document.querySelectorAll(".acard").length >= 5, "看板原子卡(种子)", "实际 " + document.querySelectorAll(".acard").length);
    collide("board");
    const trashBtn = [...document.querySelectorAll(".board-bar button")].find(b => (b.textContent || "").includes("回收站"));
    ok(!!trashBtn, "回收站入口");
    if (trashBtn) {
      trashBtn.click(); await sleep(700);
      ok((document.body.textContent || "").includes("回收站"), "回收站面板");
      const back = [...document.querySelectorAll(".board-bar button")].find(b => (b.textContent || "").includes("看板"));
      if (back) { back.click(); await sleep(500); }
    }
    const chip = document.querySelector(".acard .chip");
    ok(!!chip, "稿件 chip(种子稿)");
    if (chip) {
      chip.click(); await sleep(900);
      ok(!!document.querySelector(".ed-body"), "编辑器正文");
      ok(!!document.querySelector(".ed-title"), "编辑器标题输入");
      const te = document.body.textContent || "";
      ok(te.includes("采纳裁决"), "采纳裁决行");
      ok(te.includes("素材（"), "编辑器素材区");
      ok(te.includes("选中正文任意一段") || te.includes("选中任意一段"), "框选改写提示");
      collide("editor");
    }
  }

  // 3) 校准中心
  if (await navTo("校准中心")) {
    const t2 = document.body.textContent || "";
    ok(t2.includes("写作规则"), "校准中心规则区");
    ok(t2.includes("受众"), "校准中心受众行");
    ok(t2.includes("爆款吸收"), "爆款吸收区");
  }

  // 4) 设置(六区收口)
  if (await navTo("设置")) {
    const t3 = document.body.textContent || "";
    for (const key of ["引擎", "搜索 API", "发布(publish.json)", "情报源", "工作区", "知识库"]) {
      ok(t3.includes(key), "设置区:" + key);
    }
  }

  // 5) 素材库 / 数据回流
  if (await navTo("素材库")) {
    ok((document.body.textContent || "").includes("导入素材"), "素材库导入区");
  }
  if (await navTo("数据回流")) {
    ok((document.body.textContent || "").includes("基线洞察") || (document.body.textContent || "").includes("作品数"), "回流页渲染");
  }

  return { fails };
})()`;

// ── 主流程 ────────────────────────────────────────────────────────────────────
let serverProc: ChildProcess | null = null;
let chromeProc: ChildProcess | null = null;
let tmpData = "";
let tmpChrome = "";

async function main(): Promise<number> {
  // D 期后 React 是唯一前端:dist 缺失直接失败(不是跳过)
  try {
    await fs.access(path.resolve(import.meta.dirname, "..", "frontend", "dist", "index.html"));
  } catch {
    console.error("[smoke] ❌ frontend/dist 缺失——先执行 npm run fe:build");
    return 1;
  }
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
           const dock = document.querySelector(".dock");
           if (!dock) { fails.push("对话栏缺失@${width}px"); return { fails }; }
           const dl = dock.getBoundingClientRect().left;
           const clipped = (el) => {
             let p = el.parentElement;
             while (p && p !== document.body) {
               const ox = getComputedStyle(p).overflowX;
               if ((ox === "auto" || ox === "scroll" || ox === "hidden") && p.getBoundingClientRect().right <= dl + 1.5) return true;
               p = p.parentElement;
             }
             return false;
           };
           const bad = [];
           for (const el of document.querySelectorAll(".main *")) {
             if (!el.offsetParent) continue;
             const r = el.getBoundingClientRect();
             if (r.width > 6 && r.height > 6 && r.right > dl + 1.5 && !clipped(el)) bad.push(el.className || el.tagName);
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


  if (consoleErrors.length) fails.push(`console 错误 ${consoleErrors.length} 条：${consoleErrors.slice(0, 3).join(" | ")}`);

  cdp.close();
  if (fails.length === 0) {
    console.log("[smoke] ✅ PASS — React 全链动线/布局(1280+1680)/console 全部通过");
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
