/**
 * Build desktop/main.ts + desktop/preload.ts → desktop/dist/*.cjs
 *
 * esbuild is an explicit devDep (npm i -D esbuild).
 *
 * Two separate builds on purpose:
 * - main.cjs bundles the engine, where modules may use import.meta.url.
 *   The define replaces it with `__importMetaUrl`, which the banner computes
 *   as a real file:// URL from __filename. (Substituting __filename directly
 *   would crash fileURLToPath callers — it's a plain path, not a URL.)
 * - preload.cjs gets NO banner/define: the sandboxed preload cannot require
 *   node builtins, so the bundle must stay free of them (it only bundles the
 *   dependency-free channels.ts). esbuild's empty-import-meta warning will
 *   flag any import.meta.url that sneaks in.
 */
import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const shared = {
  bundle: true,
  platform: "node" as const,
  external: ["electron"],
  format: "cjs" as const,
  outdir: path.join(root, "desktop", "dist"),
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
};

async function main(): Promise<void> {
  await build({
    ...shared,
    entryPoints: [path.join(root, "desktop", "main.ts")],
    define: { "import.meta.url": "__importMetaUrl" },
    banner: {
      js: `const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;`,
    },
  });

  await build({
    ...shared,
    entryPoints: [path.join(root, "desktop", "preload.ts")],
  });

  console.log("build:desktop complete — desktop/dist/main.cjs + preload.cjs");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
