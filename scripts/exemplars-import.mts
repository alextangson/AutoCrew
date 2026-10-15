/**
 * 把 `<目录>/<体裁>/bench-*.md` 导进资料库范文库（spec 2026-10-15 §2、§16）。按内容 hash 幂等，改过的出新版本，旧版本不动。
 * 用法：npm run exemplars:import -- <目录> [--data-dir=<数据目录>]
 * 有任何一篇失败：照样导完其他篇，最后以非 0 退出，逐篇列原因。
 */
import path from "node:path";
import { importExemplarDir } from "../src/modules/exemplar/import.js";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const dataDir = args.find((a) => a.startsWith("--data-dir="))?.slice("--data-dir=".length);
if (!dir) {
  console.error("用法：npm run exemplars:import -- <目录> [--data-dir=<数据目录>]");
  process.exit(2);
}
const results = await importExemplarDir(path.resolve(dir), dataDir);
for (const r of results) console.log(r.error ? `✗ ${r.file}：${r.error}` : `${r.outcome === "unchanged" ? "=" : "✓"} ${r.file} → ${r.id} v${r.version}（${r.outcome}）`);
const failed = results.filter((r) => r.error).length;
console.log(`共 ${results.length} 篇，失败 ${failed} 篇`);
process.exit(failed ? 1 : 0);
