#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.AUTOCREW_DATA_DIR || path.join(os.homedir(), ".autocrew");
const PID_FILE = path.join(DATA_DIR, "autocrew.pid");
const LOG_FILE = path.join(DATA_DIR, "server.log");
const PORT = Number(process.env.AUTOCREW_PORT) || 4317;
const BASE_URL = `http://127.0.0.1:${PORT}/`;
const NO_OPEN = process.argv.includes("--no-open");
const rawCommand = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const command = process.argv.includes("--help") || process.argv.includes("-h") ? "help" : rawCommand || "start";

function printHelp() {
  console.log(`AutoCrew 快速启动器

用法:
  autocrew                后台启动并打开浏览器
  autocrew start          同上
  autocrew stop           停止后台服务
  autocrew restart        重启并打开浏览器
  autocrew status         查看状态
  autocrew logs           跟踪服务日志
  autocrew build          重新构建前端
  autocrew topics         列出选题
  autocrew contents       列出稿件
  autocrew write          开始写稿（--topic --platform）
  autocrew revise         修改稿件（--content --instruction）
  autocrew prepare        生成发布文案（--content）
  autocrew retro          生成复盘（--mode weekly|monthly）
  autocrew runs           查看最近任务事件
  autocrew call           调用任意内部能力（channel --payload JSON）
  autocrew mcp            以前台 stdio 方式启动 MCP Server
  autocrew doctor         检查本地运行环境

选项:
  --no-open               启动后不打开浏览器
  --json                  输出机器可读 JSON`);
}

function optionValue(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function positionalAfterCommand() {
  const args = process.argv.slice(2);
  const index = args.indexOf(command);
  return args.slice(index + 1).filter((arg) => !arg.startsWith("--"));
}

function printResult(result, summary) {
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(summary?.(result) ?? JSON.stringify(result, null, 2));
}

async function invokeChannel(channel, payload = {}) {
  if (!(await serverUp())) throw new Error("AutoCrew 未运行，请先执行 autocrew start");
  let token = "";
  try {
    token = (await fsp.readFile(path.join(DATA_DIR, "server-token"), "utf-8")).trim();
  } catch {
    throw new Error("找不到本地访问凭证，请执行 autocrew restart");
  }
  const response = await fetch(`${BASE_URL}api/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, payload }),
  });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || `调用失败：HTTP ${response.status}`);
  return result;
}

function requiredOption(name) {
  const value = optionValue(name);
  if (!value) throw new Error(`缺少 --${name}`);
  return value;
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf-8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function serverUp() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(BASE_URL, { signal: controller.signal });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function openBrowser(url) {
  if (NO_OPEN) return;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(opener, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function runBuild() {
  console.log("AutoCrew 正在构建前端…");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["run", "fe:build"], { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function ensureBuild() {
  if (!fs.existsSync(path.join(ROOT, "frontend", "dist", "index.html"))) runBuild();
}

async function waitForLaunch(logOffset, pid) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) break;
    let chunk = "";
    try {
      // logOffset 来自 stat.size（字节）；必须按 Buffer 字节切，不能拿它切 UTF-16 字符串。
      // 日志含中文时两者会偏移，导致明明已启动却永远匹配不到 URL。
      const data = await fsp.readFile(LOG_FILE);
      chunk = data.subarray(logOffset).toString("utf-8");
    } catch {
      // 日志可能尚未创建，继续等。
    }
    const match = chunk.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/);
    if (match) return match[0];
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function start() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.chmod(DATA_DIR, 0o700).catch(() => {});

  if (await serverUp()) {
    console.log(`AutoCrew 已在运行: ${BASE_URL}`);
    openBrowser(BASE_URL);
    return;
  }

  const stalePid = readPid();
  if (stalePid && !processAlive(stalePid)) await fsp.rm(PID_FILE, { force: true });
  ensureBuild();

  const tsx = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  if (!fs.existsSync(tsx)) {
    console.error(`缺少依赖。请先在 ${ROOT} 执行 npm install`);
    process.exit(1);
  }

  const logOffset = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
  const logFd = fs.openSync(LOG_FILE, "a", 0o600);
  fs.chmodSync(LOG_FILE, 0o600);
  const child = spawn(tsx, [path.join(ROOT, "desktop", "server.ts")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  fs.closeSync(logFd);
  child.unref();
  await fsp.writeFile(PID_FILE, `${child.pid}\n`, { mode: 0o600 });

  const url = await waitForLaunch(logOffset, child.pid);
  if (!url) {
    await fsp.rm(PID_FILE, { force: true });
    console.error(`AutoCrew 启动失败。查看日志: ${LOG_FILE}`);
    process.exit(1);
  }
  console.log(`AutoCrew 已启动（PID ${child.pid}）`);
  console.log(`浏览器地址: ${BASE_URL}`);
  console.log(`日志: ${LOG_FILE}`);
  openBrowser(url);
}

async function stop() {
  const pid = readPid();
  if (!pid || !processAlive(pid)) {
    await fsp.rm(PID_FILE, { force: true });
    console.log("AutoCrew 当前未由快速启动器运行");
    return;
  }
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await fsp.rm(PID_FILE, { force: true });
  console.log("AutoCrew 已停止");
}

async function status() {
  const pid = readPid();
  const up = await serverUp();
  if (up) {
    console.log(`AutoCrew 运行中${pid && processAlive(pid) ? `（PID ${pid}）` : ""}: ${BASE_URL}`);
    return;
  }
  console.log("AutoCrew 未运行");
  process.exitCode = 1;
}

switch (command) {
  case "start":
    await start();
    break;
  case "stop":
    await stop();
    break;
  case "restart":
    await stop();
    await start();
    break;
  case "status":
    await status();
    break;
  case "logs": {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    if (!fs.existsSync(LOG_FILE)) await fsp.writeFile(LOG_FILE, "", { mode: 0o600 });
    const tail = spawn("tail", ["-n", "80", "-f", LOG_FILE], { stdio: "inherit" });
    await new Promise((resolve) => tail.on("exit", resolve));
    break;
  }
  case "build":
    runBuild();
    break;
  case "topics": {
    const result = await invokeChannel("topics:list");
    const topics = result.topics ?? result.data?.topics ?? [];
    printResult(result, () => topics.length ? topics.map((item) => `[${item.id}] ${item.title}${typeof item.score === "number" ? ` · ${item.score}/100` : ""}`).join("\n") : "暂无选题");
    break;
  }
  case "contents": {
    const result = await invokeChannel("content:list");
    const contents = result.contents ?? [];
    printResult(result, () => contents.length ? contents.map((item) => `[${item.id}] ${item.title} · ${item.platform ?? "未分平台"} · ${item.status}`).join("\n") : "暂无稿件");
    break;
  }
  case "write": {
    const topic = requiredOption("topic");
    const platform = optionValue("platform", "wechat_mp");
    const result = await invokeChannel("generate:script", { topic, platform });
    printResult(result, (data) => `写稿任务已受理 · ${data.contentId ?? ""} · ${data.runId ?? ""}`);
    break;
  }
  case "revise": {
    const contentId = requiredOption("content");
    const instruction = requiredOption("instruction");
    const result = await invokeChannel("chat:turn", {
      message: instruction,
      context: { content_id: contentId },
    });
    printResult(result, (data) => `修改任务已完成 · ${data.data?.actionId ?? data.data?.runId ?? ""}`);
    break;
  }
  case "prepare": {
    const contentId = requiredOption("content");
    const result = await invokeChannel("publish:clipboard", { content_id: contentId });
    printResult(result, (data) => data.data?.copyText ?? data.copyText ?? "发布文案已准备");
    break;
  }
  case "retro": {
    const mode = optionValue("mode", "weekly");
    if (mode !== "weekly" && mode !== "monthly") throw new Error("--mode 仅支持 weekly 或 monthly");
    const result = await invokeChannel("retro:generate", { mode });
    printResult(result, () => `${mode === "weekly" ? "周" : "月"}复盘任务已受理`);
    break;
  }
  case "runs": {
    const result = await invokeChannel("events:recent", { limit: Number(optionValue("limit", "20")) });
    const events = result.data?.events ?? result.events ?? [];
    printResult(result, () => events.length ? events.map((event) => `${event.ts}  ${event.label}`).join("\n") : "暂无任务事件");
    break;
  }
  case "call": {
    const [channel] = positionalAfterCommand();
    if (!channel) throw new Error("用法：autocrew call <channel> --payload '{...}'");
    let payload = {};
    try { payload = JSON.parse(optionValue("payload", "{}")); } catch { throw new Error("--payload 必须是合法 JSON"); }
    printResult(await invokeChannel(channel, payload));
    break;
  }
  case "mcp": {
    const tsx = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    const child = spawn(tsx, [path.join(ROOT, "mcp", "server.ts")], { cwd: ROOT, stdio: "inherit", env: process.env });
    await new Promise((resolve) => child.on("exit", resolve));
    break;
  }
  case "doctor": {
    // 公众号发布依赖：脚本已收进仓库(vendor/wechat-format)，经 uv 运行。
    const vendorWechat = path.join(ROOT, "vendor", "wechat-format");
    const wechatScript = path.join(vendorWechat, "scripts", "publish.py");
    const wechatConfig = path.join(vendorWechat, "config.json");
    const wechatConfigExample = path.join(vendorWechat, "config.example.json");
    // 缺 config.json 则从 example 兜底生成（脚本 import 期即读它；真实凭证走 env）。
    let wechatConfigCreated = false;
    if (!fs.existsSync(wechatConfig) && fs.existsSync(wechatConfigExample)) {
      try { fs.copyFileSync(wechatConfigExample, wechatConfig); wechatConfigCreated = true; } catch {}
    }
    const uvOk = !spawnSync("uv", ["--version"], { stdio: "ignore" }).error;
    // 生图就绪:配了中转(原生 HTTP 生图,自包含)→ 封面/正文图不依赖 ~/.openclaw 外部脚本。
    let imageRelay = false;
    let apiProxySet = false;
    try {
      const pub = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "publish.json"), "utf-8")).wechatMp || {};
      imageRelay = Boolean(pub.imageBaseUrl && pub.imageApiKey);
      apiProxySet = Boolean(pub.apiProxy);
    } catch {}

    const checks = {
      node: process.version,
      server: await serverUp(),
      frontendBuilt: fs.existsSync(path.join(ROOT, "frontend", "dist", "index.html")),
      dependencies: fs.existsSync(path.join(ROOT, "node_modules", ".bin", "tsx")),
      dataDir: DATA_DIR,
      engineConfigured: fs.existsSync(path.join(DATA_DIR, "engine.json")),
      mcpServer: fs.existsSync(path.join(ROOT, "mcp", "server.ts")),
      uv: uvOk,
      wechatPublishScript: fs.existsSync(wechatScript),
      wechatConfig: fs.existsSync(wechatConfig),
      imageGenRelay: imageRelay,
    };
    printResult(checks, () =>
      Object.entries(checks).map(([key, value]) => `${value ? "✓" : "✕"} ${key}: ${value}`).join("\n")
      + (wechatConfigCreated ? `\n  已从 config.example.json 生成 ${wechatConfig}（占位凭证；真实凭证在「设置→发布」填写）` : "")
      + (uvOk ? "" : "\n  → 公众号发布需要 uv：curl -LsSf https://astral.sh/uv/install.sh | sh")
      + (imageRelay ? "" : "\n  → 生图(封面/正文图)建议配中转：设置→发布 填生图 Key/端点(OpenAI 兼容)，原生生图不依赖外部脚本")
      + (apiProxySet ? "\n  公众号 API 代理已配（固定出口 IP，动态 IP 变动免疫 40164）" : ""),
    );
    if (!checks.frontendBuilt || !checks.dependencies || !checks.engineConfigured
      || !checks.uv || !checks.wechatPublishScript) process.exitCode = 1;
    break;
  }
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  default:
    printHelp();
    process.exitCode = 1;
}
