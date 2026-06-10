/**
 * Load smoke for desktop bundles — catches module-load crashes (bad
 * import.meta.url substitution, unresolvable requires) without a GUI.
 * Stubs "electron" via Module._load interception, then requires both
 * artifacts; any throw at load time fails the build.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const electronStub = {
  app: { whenReady: () => new Promise(() => {}), on() {} },
  BrowserWindow: class {
    loadFile(): void {}
    static getAllWindows(): unknown[] {
      return [];
    }
  },
  ipcMain: { handle() {} },
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
  process.exit(0);
} catch (err) {
  console.error("smoke: desktop bundle failed at module load:");
  console.error(err);
  process.exit(1);
}
