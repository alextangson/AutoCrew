/**
 * Build desktop/main.ts + desktop/preload.ts → desktop/dist/*.cjs
 *
 * esbuild is an explicit devDep (npm i -D esbuild).
 * esbuild CJS bundles run inside Node's CJS module wrapper, so native
 * __dirname / __filename are in scope. The `define` replaces any
 * import.meta.url references with __filename to silence the warning and
 * give correct runtime behaviour.
 */
import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const shared = {
    bundle: true,
    platform: "node" as const,
    external: ["electron"],
    format: "cjs" as const,
    outdir: path.join(root, "desktop", "dist"),
    outExtension: { ".js": ".cjs" },
    sourcemap: true,
    define: { "import.meta.url": "__filename" },
  };

  await build({
    ...shared,
    entryPoints: [
      path.join(root, "desktop", "main.ts"),
      path.join(root, "desktop", "preload.ts"),
    ],
  });

  console.log("build:desktop complete — desktop/dist/main.cjs + preload.cjs");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
