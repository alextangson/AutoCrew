/**
 * 把 `<目录>/<体裁>/bench-*.md` 导进资料库范文库（spec 2026-10-15 §2、§16）。按内容 hash 幂等，改过的出新版本，旧版本不动。
 * 用法：npm run exemplars:import -- <目录> [--data-dir=<数据目录>]
 *       npm run exemplars:import -- <目录> --replace=<旧范文 id>   体裁满 6 篇完整范文时，指定换掉哪篇（旧版本照留）
 *       npm run exemplars:import -- --voice <文件或目录…> [--data-dir=<数据目录>]   创始人成片转写，按口吻参考入库（不当范文）
 * 有任何一篇失败：照样导完其他篇，最后以非 0 退出，逐篇列原因。
 */
import path from "node:path";
import { importExemplarDir } from "../src/modules/exemplar/import.js";
import { importVoiceFiles } from "../src/modules/exemplar/voice.js";
import { getDataDir } from "../src/storage/local-store.js";
import { isWithin, readLibraryLocation } from "../src/storage/storage-roots.js";
import { acquireLibraryLock } from "../src/storage/library-lock.js";

const args = process.argv.slice(2);
const voice = args.includes("--voice");
const replace = args.find((a) => a.startsWith("--replace="))?.slice("--replace=".length);
const paths = args.filter((a) => !a.startsWith("--"));
const dir = paths[0];
const dataDir = args.find((a) => a.startsWith("--data-dir="))?.slice("--data-dir=".length);
if (!dir) {
  console.error("用法：npm run exemplars:import -- <目录> [--data-dir=<数据目录>]");
  process.exit(2);
}
// 写资料库前先领写入锁：服务在跑（它占着锁）就明确拒绝，不半截写
const target = getDataDir(dataDir);
const location = readLibraryLocation();
let release: () => void = () => {};
try {
  if (location && isWithin(location.root, path.resolve(target))) release = acquireLibraryLock();
} catch (e) {
  console.error(`领不到资料库写入锁，什么都没导：${e instanceof Error ? e.message : String(e)}\n先停掉 AutoCrew 服务（npm run stop）再导。`);
  process.exit(1);
}
let results: Awaited<ReturnType<typeof importExemplarDir>>;
try {
  results = voice ? await importVoiceFiles(paths.map((p) => path.resolve(p)), target) : await importExemplarDir(path.resolve(dir), target, replace);
} finally {
  release();
}
for (const r of results) console.log(r.error ? `✗ ${r.file}：${r.error}` : `${r.outcome === "unchanged" ? "=" : "✓"} ${r.file} → ${r.id} v${r.version}（${r.outcome}）`);
const failed = results.filter((r) => r.error).length;
console.log(`共 ${results.length} 篇，失败 ${failed} 篇`);
process.exit(failed ? 1 : 0);
