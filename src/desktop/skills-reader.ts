/**
 * 团队技能读取(V5.6 可观测性):skills/<name>/SKILL.md 是每个员工的工作手册,
 * 此前只活在仓库里——GUI 一览让"agent 为什么这么干"不再是黑箱。
 * 只读仓库内目录,不碰用户数据区。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillDoc {
  id: string;
  title: string;
  content: string;
}

const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
const MAX_SKILL_BYTES = 64 * 1024;

export async function listSkills(): Promise<SkillDoc[]> {
  let entries;
  try {
    entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const docs: SkillDoc[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const raw = await fs.readFile(path.join(SKILLS_DIR, e.name, "SKILL.md"), "utf-8");
      const content = raw.length > MAX_SKILL_BYTES ? raw.slice(0, MAX_SKILL_BYTES) : raw;
      const heading = content.match(/^#\s+(.+)$/m);
      docs.push({ id: e.name, title: heading ? heading[1].trim() : e.name, content });
    } catch {
      /* 无 SKILL.md 的目录跳过 */
    }
  }
  return docs.sort((a, b) => a.id.localeCompare(b.id));
}
