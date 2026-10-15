/**
 * 2026-10-15 写法与范文上线迁移（逻辑在 src/modules/exemplar/migrate-1015.ts）。默认干跑，只打印；--apply 才写。
 * 用法：npm run migrate:writing-exemplars -- [--data-dir=<数据目录>] [--apply]
 * 写资料库里的数据目录时先领资料库写入锁（服务在跑就领不到，停下报错）；重复跑幂等。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../src/storage/local-store.js";
import { isWithin, readLibraryLocation } from "../src/storage/storage-roots.js";
import { acquireLibraryLock } from "../src/storage/library-lock.js";
import { mutateProfile, type CreatorProfile } from "../src/modules/profile/creator-profile.js";
import { loadSeeds, manifestInQueue, readManifestRaw, readVersionText, serialize, writeManifest, writeNextVersion } from "../src/modules/playbook/store.js";
import type { PlaybookId, PlaybookManifest } from "../src/modules/playbook/types.js";
type Seed = Awaited<ReturnType<typeof loadSeeds>>[number];
import { assertOnlyDouyinChanged, effectiveTable, FOUNDER_WORDS, migrateProposals, migrateRules, MIGRATION_ID, MigrationError, publishPlaybooks, renderTable } from "../src/modules/exemplar/migrate-1015.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dataDir = getDataDir(args.find((a) => a.startsWith("--data-dir="))?.slice("--data-dir=".length));

/** 档案必须读得出来：读坏了不能当成空档案往里写 */
async function readProfileStrict(): Promise<CreatorProfile> {
  const raw = await fs.readFile(path.join(dataDir, "creator-profile.json"), "utf8");
  const p = JSON.parse(raw) as CreatorProfile;
  if (!Array.isArray(p.writingRules)) throw new MigrationError("档案里没有 writingRules：不迁移");
  return p;
}

const STATE_TEXT = { publish: " → 发布压缩版为新版本", already_migrated: "，本次迁移已发布过，不再发布", already_compressed: "，已是压缩版" } as const;

/** 在 m 上改提案状态，算手册计划并打印 */
async function reportPlaybooks(m: PlaybookManifest, seeds: Seed[], now: string) {
  const propLog = migrateProposals(m, now);
  const books = await publishPlaybooks(m, seeds, (id, v) => readVersionText(id as PlaybookId, v, dataDir));
  console.log(`## 手册提案\n${propLog.join("\n")}\n\n## 手册压缩版\n${books.map((b) => `${b.state === "publish" ? "✓" : "="} ${b.id}：当前第 ${b.from} 版${STATE_TEXT[b.state]}`).join("\n")}`);
  return { books, changed: propLog.some((l) => l.startsWith("✓")) || books.some((b) => b.state === "publish") };
}

/** 干跑严格只读：清单不存在不种，只说明；存在就在内存里算 */
async function dryRunPlaybooks(seeds: Seed[], now: string): Promise<void> {
  const m = await readManifestRaw(dataDir);
  if (!m) { console.log("## 手册\n手册清单不存在：--apply 时会直接种 5 本压缩版，不需要迁移提案"); return; }
  await reportPlaybooks(structuredClone(m), seeds, now);
}

/** 返回这次有没有真的写东西：全是「=」时档案和手册清单一个字节都不动 */
async function plan(now: string): Promise<boolean> {
  const profile = await readProfileStrict();
  const { normalizeRules } = await import("../src/modules/profile/writing-rules.js");
  profile.writingRules = normalizeRules(profile.writingRules);
  const before = effectiveTable(profile);
  const after = structuredClone(profile);
  const ruleLog = migrateRules(after, now);
  const table = effectiveTable(after);
  assertOnlyDouyinChanged(before, table);
  const text = new Map(after.writingRules.map((r) => [r.id ?? r.rule, r.rule]));
  console.log(`数据目录：${dataDir}\n模式：${apply ? "写入" : "干跑（加 --apply 才写）"}\n\n## 档案规则\n${ruleLog.join("\n")}\n\n## 每个平台的生效规则（前 → 后，只允许抖音变）\n${renderTable(before, table, text)}\n`);
  const seeds = await loadSeeds();
  if (!apply) { await dryRunPlaybooks(seeds, now); return false; }
  const seeded = !(await readManifestRaw(dataDir));
  const bookChanged = await serialize(dataDir, async () => {
    const m = await manifestInQueue(dataDir);
    const { books, changed } = await reportPlaybooks(m, seeds, now);
    if (!changed) return false;
    for (const b of books.filter((x) => x.state === "publish")) {
      const e = m.playbooks.find((x) => x.id === b.id)!;
      const version = await writeNextVersion(e.id, Math.max(...e.versions.map((v) => v.version)) + 1, seeds.find((s) => s.id === b.id)!.text, dataDir);
      e.versions.push({ version, at: now, author: "agent", kind: "edit", founder_words: FOUNDER_WORDS, reason: "2026-10-15 压缩成三段：什么时候选它、骨架、范文清单", based_on: e.current, migration: MIGRATION_ID });
      e.current = version;
    }
    await writeManifest(m, dataDir);
    return true;
  });
  const rulesChanged = ruleLog.some((l) => l.startsWith("✓"));
  if (rulesChanged) await mutateProfile((p) => { if (!p.writingRules.length) throw new MigrationError("档案读出来是空的：不写"); migrateRules(p, now); }, dataDir);
  return seeded || bookChanged || rulesChanged;
}

const location = readLibraryLocation();
const release = apply && location && isWithin(location.root, path.resolve(dataDir)) ? acquireLibraryLock() : () => {};
try {
  const wrote = await plan(new Date().toISOString());
  console.log(!apply ? "\n干跑结束，什么都没写。" : wrote ? "\n已写入。" : "\n全部已是目标状态，什么都没写。");
} catch (e) {
  console.error(`\n迁移中止：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  release();
}
