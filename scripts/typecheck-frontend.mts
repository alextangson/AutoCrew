// Typecheck the frontend exactly as `frontend` build does (its own tsc + tsconfig, test files included),
// so `npm run check` fails on anything that would break `npm start`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontend = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend");
const tsc = path.join(frontend, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
const required = [tsc, path.join(frontend, "node_modules", "@types", "react")];

if (required.some((p) => !existsSync(p))) {
  console.error("typecheck:frontend: frontend dependencies are missing.\n  Run: (cd frontend && npm install)");
  process.exit(1);
}

const result = spawnSync(tsc, ["--noEmit", "-p", "tsconfig.json"], { cwd: frontend, stdio: "inherit" });
if (result.error) console.error(`typecheck:frontend: ${result.error.message}`);
process.exit(result.status ?? 1);
