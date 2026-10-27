/**
 * Codex 用的 AutoCrew 技能随 AutoCrew 一起装、一起更新：`autocrew connect codex` 把它们软链进
 * `<codexHome>/skills/<name>`，指向本安装的 `skills/<name>`。
 * 原来就有的真目录或指向别处的链接先挪成 `<name>.bak-<YYYYMMDD-HHMM>`（绝不删）；断开只删指向本安装的链接。
 */
import fs from "node:fs";
import path from "node:path";

export const CODEX_SKILLS = ["personal-ip-video-loop", "publish-content", "cover-generator"] as const;

export interface SkillLinkReport {
  linked: string[];
  unchanged: string[];
  backedUp: { name: string; backup: string }[];
  errors: { name: string; error: string }[];
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 链接指向的绝对路径；不是链接返回 null */
function linkTarget(file: string): string | null {
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) return null;
    return path.resolve(path.dirname(file), fs.readlinkSync(file));
  } catch { return null; }
}

function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch { return false; }
}

/**
 * 备份 = 先用 mkdtemp 建一个唯一的空目录 `<name>.bak-<时间>-XXXXXX`，再把原件挪进去（`<该目录>/<name>`）。
 * mkdtemp 是原子的独占创建，两个并发 connect 不会拿到同一个名字；挪进新建的空目录也绝不会盖掉别的东西。
 */
function backupInto(dest: string, now: Date): string {
  const holder = fs.mkdtempSync(`${dest}.bak-${stamp(now)}-`);
  const backup = path.join(holder, path.basename(dest));
  fs.renameSync(dest, backup);
  return backup;
}

/** 先在临时名上建好链接（建不了就什么都不动），再挪开原件、换上链接；换不上就把原件挪回去 */
function placeLink(src: string, dest: string, now: Date): string | null {
  const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  fs.symlinkSync(src, tmp, "dir");
  let backup: string | null = null;
  try {
    if (exists(dest)) backup = backupInto(dest, now);
    fs.renameSync(tmp, dest);
    return backup;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 已经不在 */ }
    if (backup && !exists(dest)) {
      try { fs.renameSync(backup, dest); fs.rmdirSync(path.dirname(backup)); backup = null; } catch { /* 挪不回去：下面报出备份位置 */ }
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(backup ? `${msg}（原来的留在 ${backup}）` : msg);
  }
}

export function linkCodexSkills(codexHome: string, skillsRoot: string, now = new Date()): SkillLinkReport {
  const report: SkillLinkReport = { linked: [], unchanged: [], backedUp: [], errors: [] };
  const dir = path.join(codexHome, "skills");
  for (const name of CODEX_SKILLS) {
    const src = path.resolve(skillsRoot, name);
    const dest = path.join(dir, name);
    try {
      if (!fs.existsSync(path.join(src, "SKILL.md"))) throw new Error(`本安装里没有 skills/${name}`);
      if (linkTarget(dest) === src) { report.unchanged.push(name); continue; }
      fs.mkdirSync(dir, { recursive: true });
      const backup = placeLink(src, dest, now);
      if (backup) report.backedUp.push({ name, backup });
      report.linked.push(name);
    } catch (err) {
      report.errors.push({ name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

/** 只删指向本安装的链接；别的东西（真目录、指向别处的链接、备份）一律不碰 */
export function unlinkCodexSkills(codexHome: string, skillsRoot: string): string[] {
  const removed: string[] = [];
  for (const name of CODEX_SKILLS) {
    const dest = path.join(codexHome, "skills", name);
    // 判归属和删紧挨着做：不是链接、或已经不指向本安装，就一律不碰
    if (linkTarget(dest) !== path.resolve(skillsRoot, name)) continue;
    fs.unlinkSync(dest);
    removed.push(name);
  }
  return removed;
}

export interface SkillLinkStatus { name: string; ok: boolean; detail: string }

export function checkCodexSkills(codexHome: string, skillsRoot: string): SkillLinkStatus[] {
  return CODEX_SKILLS.map((name) => {
    const dest = path.join(codexHome, "skills", name);
    const target = linkTarget(dest);
    if (target === path.resolve(skillsRoot, name)) {
      return fs.existsSync(path.join(target, "SKILL.md"))
        ? { name, ok: true, detail: "已链到本安装" }
        : { name, ok: false, detail: `链到了本安装，但那里没有 skills/${name}/SKILL.md（安装不完整，重新拉取）` };
    }
    if (target) return { name, ok: false, detail: `链接指向别处（${target}）` };
    if (exists(dest)) return { name, ok: false, detail: "是一份独立拷贝，不会随导演椅更新" };
    return { name, ok: false, detail: "没装" };
  });
}

export function describeLinkReport(r: SkillLinkReport): string {
  const parts: string[] = [];
  if (r.linked.length) parts.push(`已把 Codex 技能链到本安装：${r.linked.join("、")}`);
  for (const b of r.backedUp) parts.push(`原来的 ${b.name} 已挪到 ${b.backup}`);
  for (const e of r.errors) parts.push(`技能 ${e.name} 没链上：${e.error}`);
  return parts.length ? `${parts.join("；")}。` : "";
}
