/**
 * 一键更新的执行进程（self-update §3）。两种起法，走同一个 runUpdate：
 * - 服务拉起：`--from-server --tag vX --lock-token T --log <文件> --port P`，锁已由服务拿好，这里接过来；
 * - 本机用户在终端跑 `autocrew update`：自己现查、预检、拿锁，在前台跑完并打印结果。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMachineDir } from "../src/storage/storage-roots.js";
import { gitRunner } from "../src/modules/update/git.js";
import { readStatus } from "../src/modules/update/state.js";
import { adoptLock, busyWork, releaseLock } from "../src/modules/update/preflight.js";
import { serverBusy } from "../src/modules/update/remote.js";
import { prepareUpdate } from "../src/modules/update/start.js";
import { newLogFile, realSteps, runUpdate } from "../src/modules/update/updater.js";
import { localVersion } from "../src/modules/update/check.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MACHINE = getMachineDir();
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const PORT = Number(arg("port") ?? process.env.AUTOCREW_PORT) || 4317;

async function serverUp(): Promise<boolean> {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1_000) }); return r.status < 500; } catch { return false; }
}

function launcherPidAlive(): boolean {
  try {
    const pid = Number(fs.readFileSync(path.join(MACHINE, "autocrew.pid"), "utf-8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

/** 重启前的「还有没有任务在跑」：本机 agent 轮次记录 + 服务进程里的对话轮（服务在跑才问） */
const busyNow = (serverRunning: boolean) => async () => busyWork(MACHINE) ?? (serverRunning ? await serverBusy(PORT) : null);

async function fromServer(): Promise<number> {
  const tag = arg("tag"), token = arg("lock-token"), log = arg("log");
  if (!tag || !token || !log) { console.error("缺参数"); return 2; }
  if (!adoptLock(MACHINE, token)) { console.error("锁不是交给这个进程的，不动手"); return 2; }
  try {
    const status = readStatus(MACHINE);
    const result = await runUpdate({
      root: ROOT, machineDir: MACHINE, tag, from: localVersion(ROOT), to: tag.replace(/^v/, ""),
      ...(status?.tag === tag && status.notes ? { notes: status.notes } : {}),
      git: gitRunner(ROOT), steps: realSteps(ROOT, PORT, { serverWasRunning: true, busy: busyNow(true) }), logFile: log,
    });
    return result.ok ? 0 : 1;
  } finally { releaseLock(MACHINE, token); }
}

async function fromCli(): Promise<number> {
  const running = await serverUp();
  console.log("正在检查新版本…");
  const prep = await prepareUpdate(ROOT, MACHINE, {
    launcher: async () => ({ running, managed: launcherPidAlive() }),
    // 内置引擎的对话轮只在服务内存里：服务在跑就必须问到它空闲，问不到就不动手
    ...(running ? { remoteBusy: () => serverBusy(PORT) } : {}),
  });
  if (!prep.ok) { console.log(prep.reason); return prep.code === "no_update" ? 0 : 1; }
  const log = newLogFile(MACHINE);
  console.log(`开始更新 ${prep.from} → ${prep.to}，大约 1 分钟；记录写在 ${log}`);
  try {
    const result = await runUpdate({ root: ROOT, machineDir: MACHINE, tag: prep.tag, from: prep.from, to: prep.to, notes: prep.notes,
      git: gitRunner(ROOT), steps: realSteps(ROOT, PORT, { serverWasRunning: running, busy: busyNow(running) }), logFile: log });
    console.log(result.message);
    if (result.manualCommands) console.log(result.manualCommands.join("\n"));
    for (const n of result.ok ? prep.notes : []) for (const t of n.todo) console.log(`需要你做的（${n.version}）：${t}`);
    return result.ok ? 0 : 1;
  } finally { releaseLock(MACHINE, prep.token); }
}

process.exitCode = process.argv.includes("--from-server") ? await fromServer() : await fromCli();
