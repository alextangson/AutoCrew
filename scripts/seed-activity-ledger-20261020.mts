/**
 * 2026-10-20 活动台账首次建账（逻辑在 src/modules/publish/activity-ledger-seed.ts）。默认干跑只打印；--write 才写。
 * 用法：npm run seed:activity-ledger -- [--data-dir=<数据目录>] [--write]
 * 写资料库里的数据目录时先领资料库写入锁（服务在跑就领不到，停下报错）。
 */
import path from "node:path";
import { getDataDir } from "../src/storage/local-store.js";
import { isWithin, readLibraryLocation } from "../src/storage/storage-roots.js";
import { acquireLibraryLock } from "../src/storage/library-lock.js";
import { seedLedger } from "../src/modules/publish/activity-ledger-seed.js";

const args = process.argv.slice(2);
const write = args.includes("--write");
const dataDir = getDataDir(args.find((a) => a.startsWith("--data-dir="))?.slice("--data-dir=".length));
const location = readLibraryLocation();
const release = write && location && isWithin(location.root, path.resolve(dataDir)) ? acquireLibraryLock() : () => {};
try {
  const r = await seedLedger({ dataDir, write });
  const rel = (f: string) => path.relative(dataDir, f);
  console.log(`# 活动台账建账${write ? "" : "（干跑，未写入；加 --write 才写）"}\n数据目录：${dataDir}\n扫描核查文件：${r.scanned}`);
  console.log(`\n## 导入 ${r.imported.length} 条\n${r.imported.map((x) => `✓ ${x.key}  ${x.name}  核查于 ${x.verified_at}  ← ${rel(x.file)}`).join("\n")}`);
  console.log(`\n## 读不懂/无可导入 ${r.unreadable.length} 个文件（未猜）\n${r.unreadable.map((x) => `✗ ${rel(x.file)}：${x.reason}`).join("\n")}`);
  console.log(`\n## 台账里已有、不覆盖 ${r.already_in_ledger.length}\n${r.already_in_ledger.map((x) => `= ${x.key} ← ${rel(x.file)}`).join("\n")}`);
  console.log(`\n## 被更新核查取代 ${r.superseded.length}\n${r.superseded.map((x) => `= ${x.key} ← ${rel(x.file)}：${x.reason}`).join("\n")}`);
  console.log(`\n## 单条视频排除项未导入 ${r.skipped_exclusions.length}（不是账号层面判断，需要时发布时重核入账）\n${r.skipped_exclusions.map((x) => `- ${x.name}  ← ${rel(x.file)}`).join("\n")}`);
} finally {
  release();
}
