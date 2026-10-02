#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.AUTOCREW_LOCAL_DIR || process.env.AUTOCREW_DATA_DIR || path.join(os.homedir(), ".autocrew");
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
  autocrew status --brief 一行待办（SessionStart hook 用；任何情况都退出 0）
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
  autocrew mcp            stdio ↔ 守护进程 /mcp 转发器（Claude Code 用）
  autocrew host           接入宿主（codex|claude-code|dsh|workbuddy），打印接入步骤
                          --dir <path> 把人设写进该目录的 AGENTS.md/CLAUDE.md
                          --role editor-writer|cover 选哪一份人设
  autocrew storage        资料库位置、预览和迁移（status|cancel|preview|create|open|migrate）
  autocrew doctor         检查本地运行环境
  autocrew update         更新到最新发布版（失败自动退回）

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

/** 递归找目录下最新的文件 mtime（跳过 node_modules/dist）。 */
function newestMtime(dir) {
  let newest = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        newest = Math.max(newest, newestMtime(p));
      } else {
        newest = Math.max(newest, fs.statSync(p).mtimeMs);
      }
    } catch {
      /* 单个文件读不到不影响判断 */
    }
  }
  return newest;
}

function ensureBuild() {
  const marker = path.join(ROOT, "frontend", "dist", "index.html");
  if (!fs.existsSync(marker)) return runBuild();
  // dist 存在但源码更新过 → 必须重建。否则"更新代码后 restart"会静默端出旧前端,
  // 用户以为升级了,实际一个改动都看不到（2026-08-20 真机踩坑）。
  const distAt = fs.statSync(marker).mtimeMs;
  const srcAt = newestMtime(path.join(ROOT, "frontend", "src"));
  const rootFiles = ["index.html", "package.json", "vite.config.ts"].map((f) =>
    path.join(ROOT, "frontend", f),
  );
  let newestSrc = srcAt;
  for (const f of rootFiles) {
    try {
      newestSrc = Math.max(newestSrc, fs.statSync(f).mtimeMs);
    } catch {
      /* 可选文件缺失跳过 */
    }
  }
  if (newestSrc > distAt) runBuild();
}

const LAUNCH_FILE = path.join(DATA_DIR, "autocrew.launch");
/** 新版本起得慢也给够时间；超时就结束它，绝不留一个没人管的进程（e2e P1-1） */
const LAUNCH_TIMEOUT_MS = Number(process.env.AUTOCREW_LAUNCH_TIMEOUT_MS) || 60_000;

/** 端口上那个服务报的启动标记（不是 AutoCrew、或旧版本没有这个端点 → null） */
async function launchInfo() {
  try {
    const r = await fetch(`${BASE_URL}__autocrew/launch`, { signal: AbortSignal.timeout(1_500) });
    if (!r.ok) return null;
    const body = await r.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

/** 「由 npm start 管着」的唯一定义：端口上的服务报的标记 = 启动器这次写下的标记（服务端同一条规则见 src/modules/update/remote.ts） */
async function ourServerUp() {
  const info = await launchInfo();
  let mine = "";
  try { mine = fs.readFileSync(LAUNCH_FILE, "utf-8").trim(); } catch { /* 没有标记文件 */ }
  return Boolean(mine && info?.nonce && info.nonce === mine);
}

function killLaunched(pid) {
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    try { process.kill(process.platform === "win32" ? pid : -pid, sig); } catch { try { process.kill(pid, sig); } catch { /* 已经不在 */ } }
  }
}

async function waitForLaunch(logOffset, pid) {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
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
    // 端口有人应答 ≠ 是我们起的那个 AutoCrew（e2e P1-1）：只有标记对上才算已在运行
    if (await ourServerUp()) {
      console.log(`AutoCrew 已在运行: ${BASE_URL}`);
      openBrowser(BASE_URL);
      return;
    }
    const info = await launchInfo();
    console.error(info?.via === "serve"
      ? `端口 ${PORT} 上已在运行的 AutoCrew 是用 npm run serve 启动的，不归启动器管，没有启动新的。先在运行它的终端里按 Ctrl-C 停掉，再运行 npm start`
      : `端口 ${PORT} 上已在运行的不是这个启动器起的 AutoCrew（或是别的程序），没有启动新的。先在运行它的终端里按 Ctrl-C 停掉，再运行 npm start`);
    process.exit(1);
  }

  // 上次更新中断、安装不一致：只打恢复步骤就停，不接着去构建（否则一串 tsc 报错把步骤盖住，e2e 1002 P3-F）
  const help = interruptedUpdateHelp();
  if (help) { console.error(help); process.exit(1); }
  const stalePid = readPid();
  if (stalePid && !processAlive(stalePid)) await fsp.rm(PID_FILE, { force: true });
  // 测试钩子：AUTOCREW_SERVER_SCRIPT 换成一个假服务脚本（不构建前端、不碰资料库）；正常使用不设
  const testScript = process.env.AUTOCREW_SERVER_SCRIPT;
  if (!testScript) ensureBuild();

  const tsx = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  if (!fs.existsSync(tsx)) {
    console.error(`缺少依赖。请先在 ${ROOT} 执行 npm install`);
    process.exit(1);
  }

  if (!testScript) {
    const storageApply = spawnSync(tsx, [path.join(ROOT, "scripts", "storage.mts"), "apply"], { stdio: "inherit", env: process.env });
    if (storageApply.status !== 0) throw new Error("资料库准备失败；未启动服务，原资料保持不变");
  }

  const logOffset = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
  const logFd = fs.openSync(LOG_FILE, "a", 0o600);
  fs.chmodSync(LOG_FILE, 0o600);
  // 一次性启动标记：服务凭它确认「我是启动器起的」，一键更新才敢重启它（pid 文件里是 tsx 的 pid，不是服务本身）
  const launchNonce = randomBytes(16).toString("hex");
  await fsp.writeFile(LAUNCH_FILE, `${launchNonce}\n`, { mode: 0o600 });
  const child = spawn(tsx, [testScript || path.join(ROOT, "desktop", "server.ts")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, AUTOCREW_LAUNCH_NONCE: launchNonce },
  });
  fs.closeSync(logFd);
  child.unref();
  await fsp.writeFile(PID_FILE, `${child.pid}\n`, { mode: 0o600 });

  const url = await waitForLaunch(logOffset, child.pid);
  // 打印了地址还不够：端口上应答的必须是这一次起的进程（标记对上），否则可能是别的进程占着端口
  if (!url || !(await ourServerUp())) {
    killLaunched(child.pid);
    await fsp.rm(PID_FILE, { force: true });
    console.error(url
      ? `AutoCrew 启动失败：端口 ${PORT} 上应答的不是这次启动的进程，已结束它。查看日志: ${LOG_FILE}`
      : `AutoCrew ${Math.round(LAUNCH_TIMEOUT_MS / 1000)} 秒内没起来，已结束这次启动的进程。查看日志: ${LOG_FILE}`);
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
  if (processAlive(pid)) throw new Error("AutoCrew 尚未退出；不会迁移仍在写入的资料，请稍后重试");
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

/**
 * `status --brief`（P6 §3.2）：SessionStart hook 把这一行注入会话上下文。复用 mcp 转发器那条
 * 「单次 POST /mcp」的路。hook 失败会搅乱会话开场：任何情况都退出 0，只印一句人话。
 */
async function statusBrief() {
  if (!(await serverUp())) return console.log("AutoCrew 未运行（npm start）");
  const { forwardMessage, resolveForwarderToken } = await import("./mcp-forwarder.mjs");
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "autocrew_status", arguments: { brief: true } } };
  const fetchImpl = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
  const reply = await forwardMessage(call, { url: `${BASE_URL}mcp`, token: resolveForwarderToken(DATA_DIR), fetchImpl });
  const result = reply?.result?.structuredContent;
  if (typeof result?.brief === "string") return printResult(result, () => `AutoCrew 待办：${result.brief}${result.update ? `\nAutoCrew ${result.update}` : ""}`);
  const failure = reply?.error?.message ?? (reply?.result?.isError ? reply.result.content?.[0]?.text : null);
  console.log(failure ? `AutoCrew 待办读取失败（${failure}）` : "AutoCrew 运行中，但服务是旧版本、不认 --brief（autocrew restart 后重试）");
}

/**
 * `autocrew update`（第 12 轮 P1）：更新进程脱离终端在后台跑，前台只跟它的输出。
 * - 关终端窗口 / ssh 断线：前台走了，更新照常跑完（成功或退回），结果在页面和下一次 autocrew update 里看得见；
 * - Ctrl-C：转给更新进程请求中止，前台继续等到退回跑完、拿到结果才把提示符还给你；再按只提示「正在退回，请稍等」。
 */
/** 更新进程的退出码：预检没过、什么都没动（与 scripts/update.mts 的 REFUSED 同一个值） */
const UPDATE_REFUSED = 3;

async function runDetachedUpdate(tsx) {
  const logDir = path.join(DATA_DIR, "update-logs");
  await fsp.mkdir(logDir, { recursive: true });
  const out = path.join(logDir, `cli-${new Date().toISOString().replace(/[:.]/g, "-")}.out`);
  const fd = fs.openSync(out, "a", 0o600);
  // 不经 tsx 命令行外壳：外壳收到 Ctrl-C 只等子进程几十毫秒就强杀它，而更新进程可能正忙着删目录（e2e 1002 P1-A）。
  // 直接一个 node 进程、用 --import tsx 载入 TypeScript。前台转发信号时只发给这一个进程（child.kill，不发整个进程组），
  // 它自己的 git / npm 子进程不会跟着死在半路，由它在安全点中止（第 15 轮）
  void tsx;
  const child = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "scripts", "update.mts")], {
    cwd: ROOT, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, AUTOCREW_PORT: String(PORT) },
  });
  fs.closeSync(fd);
  // 只发给更新进程本身：发给整个进程组会把它正在跑的 git merge 一起杀掉，留下写了一半的工作区（第 15 轮）
  const toChild = (sig) => { try { child.kill(sig); } catch { /* 已经结束 */ } };
  // 每次 Ctrl-C 都转给更新进程，由它按自己走到哪一步来说（正在退回 / 新版正在检查 / 正在收尾），前台不自己编一句（第 16 轮 R1）
  process.on("SIGINT", () => toChild("SIGINT"));
  process.on("SIGTERM", () => toChild("SIGTERM"));
  // 终端没了：不再往屏幕写，直接走；更新进程不在这个终端的进程组里，会自己跑完
  process.on("SIGHUP", () => process.exit(0));
  let offset = 0;
  const pump = () => {
    try {
      const buf = fs.readFileSync(out);
      if (buf.length > offset) { process.stdout.write(buf.subarray(offset)); offset = buf.length; }
    } catch { /* 还没写 */ }
  };
  const timer = setInterval(pump, 200);
  const startedAt = Date.now();
  const { code, signal } = await new Promise((resolve) => child.on("exit", (c, s) => resolve({ code: c, signal: s })));
  clearInterval(timer);
  pump();
  // 更新进程意外没了（被信号杀掉、崩了）：没留下这一次的结果，前台要说一声（e2e 1002 P3-E）。
  // 0 = 好了 / 不用更新；3 = 预检没过、什么都没动（原因已经打印，第 15 轮 P2）；1 = 更新失败但结果写好了
  let at = 0;
  try { at = Date.parse(JSON.parse(fs.readFileSync(path.join(DATA_DIR, "update-result.json"), "utf-8")).at); } catch { /* 没有结果 */ }
  const wroteResult = at >= startedAt - 1000;
  if (signal || (code !== 0 && code !== UPDATE_REFUSED && !wroteResult)) {
    console.error("更新进程意外退出了，没来得及写下结果。再运行一次 autocrew update，它会告诉你现在的状态和怎么恢复。");
  }
  return code ?? 1;
}

/** 进程启动时刻（UTC 秒）；进程不在就是 null。与 src/desktop/chief-editor/run-store.ts 的 startEpoch 同一种读法 */
function startEpoch(pid) {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" } });
  const t = r.stdout?.trim() ? Date.parse(`${r.stdout.trim()} GMT`) : NaN;
  return Number.isFinite(t) ? Math.round(t / 1000) : null;
}

/** 有一个活着的更新进程拿着更新锁吗（pid 在、记了启动时刻的话也要对得上） */
function liveUpdateLock() {
  let body;
  try { body = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "update.lock"), "utf-8")); } catch { return null; }
  if (!body?.pid || !processAlive(body.pid)) return null;
  if (typeof body.start === "number" && body.start > 0) {
    const now = startEpoch(body.pid);
    if (now === null || Math.abs(now - body.start) > 1) return null;
  }
  return body;
}

/**
 * 上次一键更新被硬生生打断（第 12 轮 P1）：在途记录还在、却没有活的更新进程。依赖可能装到一半、连 tsx 都没有，
 * 所以这里用纯 JS 按磁盘现状算恢复命令（与 src/modules/update/interrupted.ts 同一条规则：有留着的旧依赖就改名换回，不需要网络）。
 */
function interruptedUpdateHelp() {
  let inflight;
  try { inflight = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "update-inflight.json"), "utf-8")); } catch { return null; }
  if (!inflight?.oldHead || liveUpdateLock()) return null;
  // 与 src/modules/update/interrupted.ts 的 installState 同一条规则（第 15 轮 P2-1）：
  // 在新版且新版过了健康检查（verified）、或在旧版且没有留着的完整旧依赖、程序文件没改动——能用，不打扰；
  // 版本既不是旧的也不是新的、工作区干净——用户自己换了版本，清掉记录、说一句就放行
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).stdout?.trim();
  const depsOk = (rel) => fs.existsSync(path.join(ROOT, rel === "node_modules" ? "node_modules/.bin/tsx" : "frontend/node_modules/.bin/vite"));
  // 只认这次在途记录那一戳的完整备份 `.prev-<戳>`（第 16 轮 P2-2）；老记录没戳才认任意 `.prev-<数字>`；删到一半的 .trash-… 不认
  const prevOf = (base) => inflight.stamp ? (n) => n === `${base}.prev-${inflight.stamp}` : (n) => new RegExp(`^${base.replace(".", "\\.")}\\.prev-\\d+$`).test(n);
  const backups = new Map();
  for (const rel of ["node_modules", "frontend/node_modules", "frontend/dist"]) {
    let names = [];
    try { names = fs.readdirSync(path.dirname(path.join(ROOT, rel))).filter(prevOf(path.basename(rel))).sort(); } catch { /* 目录不在 */ }
    const latest = names[names.length - 1];
    if (latest) backups.set(rel, path.join(path.dirname(rel), latest).replace(/^\.\//, ""));
  }
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: ROOT, encoding: "utf-8" });
  const clean = status.status === 0 && status.stdout.trim() === "";
  const allDeps = depsOk("node_modules") && depsOk("frontend/node_modules");
  if (head && head === inflight.commit && inflight.verified && allDeps) return null;
  if (head && head === inflight.oldHead && allDeps && backups.size === 0 && clean) return null;
  if (head && head !== inflight.commit && head !== inflight.oldHead && clean) {
    console.error("上次一键更新中断后，程序已经换成别的版本（像是自己 git pull 过），不再提示恢复。");
    // 这次的旧备份不再是恢复来源：先改名走（原名立刻不在）再清记录，不留孤儿；垃圾目录下次启动 / 更新时清
    for (const prev of backups.values()) {
      try { fs.renameSync(path.join(ROOT, prev), `${path.join(ROOT, prev)}.trash-${process.pid}-${Date.now()}`); } catch { /* 下次再清 */ }
    }
    try { fs.rmSync(path.join(DATA_DIR, "update-inflight.json"), { force: true }); } catch { /* 删不掉下次再说 */ }
    return null;
  }
  // 与 src/modules/update/interrupted.ts 的 recoveryCommands 逐字同一套输出（第 16 轮 P2-1）：换回那一行可以重复跑
  const steps = [];
  for (const rel of ["node_modules", "frontend/node_modules", "frontend/dist"]) {
    const prev = backups.get(rel);
    if (prev) { steps.push(`[ -d "${prev}" ] && { rm -rf "${rel}" && mv "${prev}" "${rel}"; }`); continue; }
    if (rel === "frontend/dist") continue;
    if (!depsOk(rel)) steps.push(rel === "node_modules" ? "npm ci" : "(cd frontend && npm ci)");
  }
  if (!backups.has("frontend/dist")) steps.push("npm run fe:build");
  return [`上次一键更新中断了（没跑完，也没有自动退回）。请依次执行下面的命令恢复到 ${inflight.from}：`,
    `cd "${ROOT}"`, `git reset --hard ${inflight.oldHead}`, ...steps, "npm run restart"].join("\n");
}


/**
 * 更新进行中不许手动启动 / 停止 / 重启（第 12 轮 P2）：会打断更新、在依赖换到一半时去构建，把服务弄停。
 * 更新进程自己调启动器时带 AUTOCREW_UPDATER=1，不受这条限制。
 */
if (["start", "stop", "restart"].includes(command) && process.env.AUTOCREW_UPDATER !== "1") {
  const lock = liveUpdateLock();
  if (lock) {
    console.error(`AutoCrew 正在更新，先别${command === "stop" ? "停止" : command === "start" ? "启动" : "重启"}——等它跑完会自动重启好。进度记录在 ${path.join(DATA_DIR, "update-logs")} 里最新的那份。`);
    process.exit(1);
  }
}

switch (command) {
  case "start":
    await start();
    break;
  case "stop":
    await stop();
    break;
  case "restart": {
    // 上次更新中断、安装不一致：先拒绝再停——停了之后才发现起不来，等于把还在跑的服务白白停掉（第 16 轮 P3）
    const help = interruptedUpdateHelp();
    if (help) { console.error(help); process.exit(1); }
    await stop();
    // 停完端口上还有人应答：旧的没停下来（pid 记录丢了 / 不是启动器起的）。这不是「已在运行」，是重启失败（Codex 审第 10 轮 P1）
    if (await serverUp()) {
      console.error(`AutoCrew 重启失败：端口 ${PORT} 上已在运行的旧服务停不下来（找不到它的进程记录）。先在运行它的终端里按 Ctrl-C 停掉，再运行 npm start`);
      process.exit(1);
    }
    await start();
    break;
  }
  case "status":
    if (process.argv.includes("--brief")) await statusBrief();
    else await status();
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
    // 转发器,不是服务器(P3 §3):stdio 上的 JSON-RPC 原样转发到守护进程的 /mcp,
    // 于是 Claude Code / Codex / 工作台共用同一个写进程。守护进程没起就报错,
    // 绝不在这里偷偷起第二个——跨进程的 last-writer-wins 是这一片要根治的病。
    const { runForwarder } = await import("./mcp-forwarder.mjs");
    await runForwarder();
    break;
  }
  case "host": {
    const [host] = positionalAfterCommand();
    const tsx = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    if (!host || !fs.existsSync(tsx)) {
      console.error(host
        ? `缺少依赖。请先在 ${ROOT} 执行 npm install`
        : "用法：autocrew host <codex|claude-code|dsh|workbuddy> [--dir <path>] [--role editor-writer|cover]");
      process.exitCode = 1;
      break;
    }
    // --dir 把人设写进那个工作目录的 AGENTS.md / CLAUDE.md；--role 选哪一份人设
    const dir = optionValue("dir");
    const role = optionValue("role");
    const args = [
      path.join(ROOT, "src", "desktop", "host-cli.ts"),
      host,
      ...(dir ? ["--dir", dir] : []),
      ...(role ? ["--role", role] : []),
    ];
    const child = spawn(tsx, args, { cwd: ROOT, stdio: "inherit", env: process.env });
    process.exitCode = await new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
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
    // 视频生产线（视频 spec §6.1/§4.3）：ffmpeg/ffprobe 是外部二进制、ASR 首跑要下 ~1GB 模型。
    // 三项都是**纯检查**——doctor 不装东西、不预热（预热是分钟级下载，要用户自己按下）。
    // uv 复用上面那一项，不重复探测：ASR sidecar 与公众号发布共用同一个运行器。
    const binOk = (cmd) => !spawnSync(cmd, ["-version"], { stdio: "ignore" }).error;
    const storageResult = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "scripts", "storage.mts"), "status"], { encoding: "utf8", env: process.env });
    let storage = {};
    try { storage = JSON.parse(storageResult.stdout || "{}"); } catch {}
    const configDir = storage.configRoot;
    const contentDir = storage.dataRoot;
    let asrStatus = "absent";
    try {
      asrStatus = JSON.parse(fs.readFileSync(path.join(contentDir, "video", "asr-status.json"), "utf-8")).status || "absent";
    } catch {}
    const asrSidecarOk = fs.existsSync(path.join(ROOT, "sidecars", "asr", "asr.py"));
    // 原片内容比对要的转写环境（1b §10）：uv / .venv / 模型，与比对器同一个判定（notReady）
    let asrEnv = { ready: false, reason: "资料库不可用，没法查转写模型状态", fix: "先让 autocrew storage status 显示已连接" };
    if (contentDir) {
      const asrResult = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "scripts", "asr-doctor.mts"), contentDir], { encoding: "utf8", env: process.env, timeout: 30_000 });
      try { asrEnv = JSON.parse((asrResult.stdout || "").trim().split("\n").pop() || "{}"); } catch { asrEnv = { ready: false, reason: "检查脚本没跑成", fix: "重跑 autocrew doctor；还不行看 autocrew logs" }; }
    }
    // 生图就绪:配了中转(原生 HTTP 生图,自包含)→ 封面/正文图不依赖 ~/.openclaw 外部脚本。
    let imageRelay = false;
    let apiProxySet = false;
    try {
      const pub = JSON.parse(fs.readFileSync(path.join(configDir, "publish.json"), "utf-8")).wechatMp || {};
      imageRelay = Boolean(pub.imageBaseUrl && pub.imageApiKey);
      apiProxySet = Boolean(pub.apiProxy);
    } catch {}

    // 发布前把关（TypeSafe / Jev）：有没有密钥、调一次通不通；密钥值不打印。可选项，不影响退出码
    let typesafe = { configured: false, reachable: false };
    const tsResult = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "scripts", "typesafe-doctor.mts")], { encoding: "utf8", env: process.env, timeout: 30_000 });
    try { typesafe = JSON.parse((tsResult.stdout || "").trim().split("\n").pop() || "{}"); } catch { typesafe = { configured: false, reachable: false, error: "检查脚本没跑成" }; }

    const checks = {
      node: process.version,
      server: await serverUp(),
      frontendBuilt: fs.existsSync(path.join(ROOT, "frontend", "dist", "index.html")),
      dependencies: fs.existsSync(path.join(ROOT, "node_modules", ".bin", "tsx")),
      dataDir: storage.root ?? "资料库不可用",
      machineDir: DATA_DIR,
      storageConnected: storage.connected === true,
      engineConfigured: Boolean(configDir && fs.existsSync(path.join(configDir, "engine.json"))),
      mcpServer: fs.existsSync(path.join(ROOT, "mcp", "server.ts")),
      uv: uvOk,
      wechatPublishScript: fs.existsSync(wechatScript),
      wechatConfig: fs.existsSync(wechatConfig),
      imageGenRelay: imageRelay,
      ffmpeg: binOk("ffmpeg"),
      ffprobe: binOk("ffprobe"),
      asrSidecar: asrSidecarOk,
      asrModelReady: asrStatus === "ready",
      asrMatchReady: asrEnv.ready === true,
      typesafeKey: typesafe.configured === true,
      typesafeReachable: typesafe.reachable === true,
    };
    // 灵感收件箱三项（spec §4）：心跳只存在于 server 进程内存，经 /api/invoke 读；
    // 绝不带外调 Telegram getUpdates（会抢正式消费者的游标 → 真丢消息）。
    const inbox = checks.server
      ? await invokeChannel("doctor:inbox").then((r) => r.data).catch((err) => ({
          text: `· inbox: 收件箱检查不可用（${err.message}）`,
        }))
      : { text: "· inbox: AutoCrew 未运行，收件箱状态未知（autocrew start 后重查）" };

    printResult({ ...checks, inbox: inbox.checks ?? [] }, () =>
      Object.entries(checks).map(([key, value]) => `${value ? "✓" : "✕"} ${key}: ${value}`).join("\n")
      + `\n${inbox.text}`
      + (wechatConfigCreated ? `\n  已从 config.example.json 生成 ${wechatConfig}（占位凭证；真实凭证在「设置→发布」填写）` : "")
      + (uvOk ? "" : "\n  → 公众号发布需要 uv：curl -LsSf https://astral.sh/uv/install.sh | sh")
      + (imageRelay ? "" : "\n  → 生图(封面/正文图)建议配中转：设置→发布 填生图 Key/端点(OpenAI 兼容)，原生生图不依赖外部脚本")
      + (apiProxySet ? "\n  公众号 API 代理已配（固定出口 IP，动态 IP 变动免疫 40164）" : "")
      + (checks.ffmpeg && checks.ffprobe ? "" : "\n  → 成片渲染需要 ffmpeg/ffprobe：brew install ffmpeg")
      + (checks.asrSidecar ? "" : "\n  → 缺 ASR sidecar(sidecars/asr/asr.py)：仓库不完整，重新拉取")
      + (asrEnv.ready ? "" : `\n  → 原片内容比对的转写环境没就绪（${asrEnv.reason}）：${asrEnv.fix}。没就绪时原片只比文件名，对不上的记成候选等你在卡片上点`)
      + (typesafe.configured
        ? (typesafe.reachable ? `\n  发布前把关语义检查（TypeSafe，密钥来自 ${typesafe.source === "env" ? "环境变量" : "本机设置"}）可用` : `\n  → TypeSafe 调不通：${typesafe.error ?? "未知原因"}（发布前把关的语义检查会标「没跑成」，确定性检查照常）`)
        : "\n  → 发布前把关的语义检查需要 TypeSafe 密钥：设置→接入更多 填，或设环境变量 TYPESAFE_API_KEY（不配也能发，语义检查会标「没跑成」）")
      + (checks.asrModelReady
        ? ""
        : `\n  → ASR 模型未就绪(当前 ${asrStatus})：设置页点「预热 ASR 模型」或调 video:asr_warmup，首跑约 1GB 下载${uvOk ? "" : "；它也要 uv"}`),
    );
    if (!checks.frontendBuilt || !checks.dependencies || !checks.engineConfigured
      || !checks.uv || !checks.wechatPublishScript || inbox.failed) process.exitCode = 1;
    break;
  }
  case "update": {
    // 一键更新（self-update §3）：和看板上「更新」走同一个执行进程，只是在前台跑
    // 先看有没有更新正在跑（纯 JS，不依赖 node_modules）：装依赖那几十秒里 tsx 暂时不在，不能叫人去 npm ci（e2e 1002 P2-D）
    if (liveUpdateLock()) {
      console.error("AutoCrew 正在更新，等它跑完；跑完会自动重启好。进度记录在 " + path.join(DATA_DIR, "update-logs") + " 里最新的那份。");
      process.exitCode = 1;
      break;
    }
    const tsx = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    if (!fs.existsSync(tsx)) {
      console.error(interruptedUpdateHelp() ?? `缺少依赖。请先在 ${ROOT} 执行 npm ci`);
      process.exitCode = 1;
      break;
    }
    process.exitCode = await runDetachedUpdate(tsx);
    break;
  }
  case "storage": {
    const taskArgs = process.argv.slice(process.argv.indexOf("storage") + 1);
    const result = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "scripts", "storage.mts"), ...(taskArgs.length ? taskArgs : ["status"])], { stdio: "inherit", env: process.env });
    process.exitCode = result.status ?? 1;
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
