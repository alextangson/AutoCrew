#!/usr/bin/env node

/**
 * AutoCrew CLI entry point.
 * Uses tsx to run TypeScript directly — no build step needed.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, "autocrew.ts");

try {
  execFileSync(
    path.join(__dirname, "..", "node_modules", ".bin", "tsx"),
    [entry, ...process.argv.slice(2)],
    { stdio: "inherit", cwd: path.join(__dirname, "..") }
  );
} catch (err) {
  // tsx exits with the child's exit code — just forward it
  process.exitCode = err.status ?? 1;
}
