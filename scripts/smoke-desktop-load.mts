/**
 * Load smoke for desktop bundles — catches module-load crashes (bad
 * import.meta.url substitution, unresolvable requires) without a GUI.
 * Stubs "electron" via Module._load interception, then requires both
 * artifacts; any throw at load time fails the build.
 *
 * 还断言 main.ts 的 IPC 边界纵深防御接线（终审 2026-06-11）：
 *   1. payload 中 `_` 前缀键（_dataDir seam）在转交 handler 前被剥掉
 *   2. flywheel:import_csv 的 csv_path 必须命中 dialog:pick_file 白名单
 * 守卫纯逻辑在 src/desktop/ipc-guard.test.ts 单测；这里只验接线。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type IpcInvoke = (event: unknown, payload: unknown) => Promise<Record<string, unknown>>;
const registrations = new Map<string, IpcInvoke>();
let pickTarget: string | null = null;

const electronStub = {
  app: { whenReady: () => new Promise(() => {}), on() {} },
  BrowserWindow: class {
    loadFile(): void {}
    static getAllWindows(): unknown[] {
      return [];
    }
    static getFocusedWindow(): unknown {
      return null;
    }
  },
  ipcMain: {
    handle(ch: string, fn: IpcInvoke) {
      registrations.set(ch, fn);
    },
  },
  dialog: {
    showOpenDialog: async () =>
      pickTarget === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [pickTarget] },
  },
  contextBridge: { exposeInMainWorld() {} },
  ipcRenderer: { invoke: async () => ({}) },
};

type ModuleLoader = { _load: (request: string, ...rest: unknown[]) => unknown };
const ModuleInternals = require("node:module") as unknown as ModuleLoader;
const origLoad = ModuleInternals._load;
ModuleInternals._load = function (request: string, ...rest: unknown[]): unknown {
  if (request === "electron") return electronStub;
  return origLoad.call(this, request, ...rest);
};

function assert(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    console.log(`smoke: ${label} OK`);
    return;
  }
  console.error(`smoke: FAIL — ${label}`);
  if (detail !== undefined) console.error(detail);
  process.exit(1);
}

async function invoke(ch: string, payload: unknown): Promise<Record<string, unknown>> {
  const fn = registrations.get(ch);
  if (!fn) {
    console.error(`smoke: FAIL — channel ${ch} not registered`);
    process.exit(1);
  }
  return fn(undefined, payload);
}

/** _dataDir 注入探针：指向含 marker baseUrl 的临时目录。剥掉了 → 读默认配置，绝不会回出 marker。只读，无副作用。 */
async function assertSanitizeWired(tmpDir: string): Promise<void> {
  const MARKER = "https://ipc-guard-smoke.invalid";
  writeFileSync(path.join(tmpDir, "engine.json"), JSON.stringify({ baseUrl: MARKER }));
  const res = await invoke("settings:get", { _dataDir: tmpDir });
  const baseUrl = (res.data as { baseUrl?: string } | undefined)?.baseUrl;
  assert(res.ok === true && baseUrl !== MARKER, "ipcMain strips _-prefixed payload keys", res);
}

/** csv_path 白名单：未选过的路径必须被守卫拒绝（/etc/passwd 可读，仅断言 ok:false 不够——必须是白名单错误）；
 *  选过的路径放行到真 handler（文件不存在 → "读不到"，证明守卫已透传且无写副作用）。 */
async function assertCsvWhitelistWired(tmpDir: string): Promise<void> {
  const denied = await invoke("flywheel:import_csv", { platform: "douyin", csv_path: "/etc/passwd" });
  assert(
    denied.ok === false && typeof denied.error === "string" && denied.error.includes("文件选择"),
    "import_csv rejects un-picked csv_path",
    denied,
  );

  pickTarget = path.join(tmpDir, "picked-but-missing.csv");
  const picked = await invoke("dialog:pick_file", {});
  assert(
    (picked.data as { path?: string } | undefined)?.path === pickTarget,
    "dialog:pick_file returns stubbed path",
    picked,
  );
  const allowed = await invoke("flywheel:import_csv", { platform: "douyin", csv_path: pickTarget });
  assert(
    allowed.ok === false && typeof allowed.error === "string" && allowed.error.includes("读不到"),
    "import_csv lets picked path through to real handler",
    allowed,
  );
}

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "autocrew-smoke-"));
try {
  for (const artifact of ["main.cjs", "preload.cjs"]) {
    require(path.join(root, "desktop", "dist", artifact));
    console.log(`smoke: ${artifact} loads OK`);
  }

  // Sandboxed preload cannot require node builtins — plain-node require above
  // would not catch the engine sneaking back into the preload bundle.
  const preloadSrc = readFileSync(path.join(root, "desktop", "dist", "preload.cjs"), "utf-8");
  if (/require\(["'](?:node:)?(?!electron)[a-z0-9_/-]+["']\)/.test(preloadSrc)) {
    console.error("smoke: preload.cjs requires a non-electron module — sandboxed preload will fail");
    process.exit(1);
  }
  console.log("smoke: preload.cjs requires only electron");

  assert(registrations.size === 17, `all 17 IPC channels registered (got ${registrations.size})`);
  await assertSanitizeWired(tmpDir);
  await assertCsvWhitelistWired(tmpDir);
  process.exit(0);
} catch (err) {
  console.error("smoke: desktop bundle failed:");
  console.error(err);
  process.exit(1);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
