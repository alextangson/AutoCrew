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

function freeBackupPath(dest: string, now: Date): string {
  const base = `${dest}.bak-${stamp(now)}`;
  let candidate = base;
  for (let i = 2; exists(candidate); i++) candidate = `${base}-${i}`;
  return candidate;
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
      if (exists(dest)) {
        const backup = freeBackupPath(dest, now);
        fs.renameSync(dest, backup);
        report.backedUp.push({ name, backup });
      }
      fs.symlinkSync(src, dest, "dir");
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
    if (target === path.resolve(skillsRoot, name)) return { name, ok: true, detail: "已链到本安装" };
    if (target) return { name, ok: false, detail: `链接指向别处（${target}）` };
    if (exists(dest)) return { name, ok: false, detail: "是一份独立拷贝，不会随 AutoCrew 更新" };
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
