/**
 * 「写法」一节（spec 2026-10-15 §3、§15.5）：人工维护在 write-script 技能里，跟着代码版本走。
 * 版本 = 这一节全文的 hash。立意时把当时那一版的全文另存进资料库（只写一次），稿子锁住版本号；
 * 中途升级了技能，这条稿续写时仍按锁住的那一版取全文。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeTextAtomicMkdir } from "../../storage/json-atomic.js";
import { assertDataDirWritable } from "../../storage/storage-roots.js";
import { contentHash, exemplarsDir } from "./store.js";
import { ExemplarError } from "./types.js";

export const SKILL_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills", "write-script", "SKILL.md");
const START = "<!-- method:start -->";
const END = "<!-- method:end -->";

const snapshotPath = (version: string, dataDir?: string) => path.join(exemplarsDir(dataDir), "method", `${version}.md`);

/** 从技能文件里取「写法」一节；标记缺了就报错（不悄悄当成没有写法） */
export function methodSection(skill: string): string {
  const a = skill.indexOf(START);
  const b = skill.indexOf(END);
  if (a < 0 || b < a) throw new ExemplarError("method_missing", "write-script 技能里找不到「写法」一节的标记（method:start / method:end）");
  return skill.slice(a + START.length, b).trim();
}

export async function currentMethod(skillFile = SKILL_FILE): Promise<{ version: string; text: string }> {
  let skill: string;
  try { skill = await fs.readFile(skillFile, "utf8"); } catch (e) { throw new ExemplarError("method_unreadable", `write-script 技能读不了：${(e as Error).message}`); }
  const text = methodSection(skill);
  return { version: contentHash(text), text };
}

/** 立意时：把当前写法存一份快照（同版本已存就不动），返回版本号 */
export async function pinMethod(dataDir?: string, skillFile = SKILL_FILE): Promise<{ version: string; text: string }> {
  const m = await currentMethod(skillFile);
  const file = snapshotPath(m.version, dataDir);
  const existing = await fs.readFile(file, "utf8").catch(() => null);
  if (existing !== m.text) {
    assertDataDirWritable(dataDir);
    await writeTextAtomicMkdir(file, m.text);
  }
  return m;
}

/** 续写：按锁住的版本取全文；快照丢了就报错，不悄悄换成当前版 */
export async function lockedMethod(version: string, dataDir?: string): Promise<string> {
  if (!/^[0-9a-f]{16}$/.test(version)) throw new ExemplarError("bad_method_version", `写法版本号不对：${version}`);
  try {
    return await fs.readFile(snapshotPath(version, dataDir), "utf8");
  } catch (e) {
    throw new ExemplarError("method_snapshot_missing", `这篇锁住的写法第 ${version} 版读不了：${(e as Error).message}`);
  }
}
