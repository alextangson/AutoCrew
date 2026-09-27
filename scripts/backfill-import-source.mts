/**
 * 一次性补写（P6 §13.4-B）：09-26 那批本地稿是在「导入来源只进回执」时导入的，稿件上没有
 * `writingSource`，导入稿补证入口认不出。按标签找出这些稿，补上 `{kind:"manual_import"}`。
 *
 * 默认只预览，`--apply` 才写；已有来源的稿一律跳过（可重复跑）。导入时刻取稿件创建时刻。
 * 用法：tsx scripts/backfill-import-source.mts <数据目录> [标签] [--apply] [--reason 原因]
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listContents, updateContent } from "../src/storage/local-store.js";

export const DEFAULT_TAG = "本地稿导入-20260926";
export const DEFAULT_REASON = "2026-09-26 写稿存盘失败后留在本地的稿件，按创始人 09-27 决定导入（来源补写）";

export interface BackfillChange { id: string; title: string; importedAt: string }

export async function backfillImportSource(
  dataDir: string,
  opts: { tag?: string; apply?: boolean; reason?: string } = {},
): Promise<{ applied: boolean; changed: BackfillChange[]; skipped: string[] }> {
  const tag = opts.tag ?? DEFAULT_TAG;
  const reason = opts.reason ?? DEFAULT_REASON;
  const tagged = (await listContents(dataDir)).filter((c) => c.tags?.includes(tag));
  const changed: BackfillChange[] = [];
  const skipped: string[] = [];
  for (const content of tagged) {
    if (content.writingSource) { skipped.push(content.id); continue; }
    const importedAt = content.createdAt;
    if (opts.apply) {
      await updateContent(content.id, { writingSource: { kind: "manual_import", importedAt, reason }, _versionNote: "补写导入来源" }, dataDir);
    }
    changed.push({ id: content.id, title: content.title, importedAt });
  }
  return { applied: Boolean(opts.apply), changed, skipped };
}

function parseArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const reasonAt = argv.indexOf("--reason");
  const reason = reasonAt >= 0 ? argv[reasonAt + 1] : undefined;
  const positional = argv.filter((a, i) => !a.startsWith("--") && (reasonAt < 0 || i !== reasonAt + 1));
  return { dataDir: positional[0], tag: positional[1], apply, reason };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dataDir || !path.isAbsolute(args.dataDir)) {
    throw new Error("用法：tsx scripts/backfill-import-source.mts <数据目录的完整路径> [标签] [--apply] [--reason 原因]");
  }
  const result = await backfillImportSource(args.dataDir, { tag: args.tag, apply: args.apply, reason: args.reason });
  for (const c of result.changed) console.log(`${result.applied ? "已补写" : "将补写"} ${c.id} 《${c.title}》 importedAt=${c.importedAt}`);
  for (const id of result.skipped) console.log(`跳过 ${id}（已有来源）`);
  console.log(result.applied ? `完成：补写 ${result.changed.length} 篇。` : `预览：${result.changed.length} 篇待补写；加 --apply 才会写入。`);
}
