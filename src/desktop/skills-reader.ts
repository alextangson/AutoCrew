/**
 * 团队技能读取(V5.6 可观测性):skills/<name>/SKILL.md 是每个员工的工作手册,
 * 此前只活在仓库里——GUI 一览让"agent 为什么这么干"不再是黑箱。
 * 只读仓库内目录,不碰用户数据区。
 *
 * 双协议(对话控制面 Phase 1):同一份 SKILL.md 服务两个面——harness 面照旧整篇消费,
 * GUI 面只吃 `## GUI` 节(步骤只引用 chat 工具)。入选靠 listGuiSkills 的 fail-closed 门控。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Dirent } from "node:fs";

export interface SkillDoc {
  id: string;
  title: string;
  content: string;
}

/** GUI 面技能:id = 目录名(同时是 read_skill 的白名单键),summary 进索引,guiContent 是 read_skill 的返回体 */
export interface GuiSkill {
  id: string;
  summary: string;
  guiContent: string;
}

const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
const MAX_SKILL_BYTES = 64 * 1024;
/** GUI 节长度是创作约束(设计 §Phase 1):中文≈1 字符 1 token,超限拒载而不是截断 */
const MAX_GUI_SECTION_CHARS = 6000;

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

/**
 * frontmatter 单行契约(设计 §Phase 1 解析契约):不引 YAML 依赖,只认顶格 `key: value`。
 * multiline(`|` / `>`)与其缩进续行一概跳过——`description: |` 的正文里含 "Trigger:" 之类
 * 伪 key,靠"顶格才算 key"挡掉。skills 是仓库受控内容,格式由我们保证。
 */
function parseSingleLineFrontmatter(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return out;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") break;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue; // 缩进续行 / 空行 / 列表项
    const value = m[2].trim();
    if (!value || value.startsWith("|") || value.startsWith(">")) continue; // block scalar / 嵌套映射
    out[m[1]] = value.replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
  }
  return out;
}

/** `## GUI` 行到下一个 `## ` 标题(或文件尾)。节内无正文视同没有节。 */
function extractGuiSection(content: string): string | null {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##[ \t]+GUI[ \t]*$/.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##[ \t]/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (!lines.slice(start + 1, end).join("\n").trim()) return null;
  return lines.slice(start, end).join("\n").trim();
}

const insideDir = (root: string, target: string): boolean =>
  target === root || target.startsWith(root + path.sep);

const rejectGuiSkill = (id: string, reason: string): void =>
  console.warn(`[skills] GUI 技能「${id}」拒载：${reason}`);

async function loadGuiSkills(root: string): Promise<GuiSkill[]> {
  let realRoot: string;
  let entries: Dirent[];
  try {
    realRoot = await fs.realpath(root);
    entries = await fs.readdir(realRoot, { withFileTypes: true });
  } catch {
    return []; // skills 目录缺失 = 无技能,对话行为与今天完全一致
  }
  const skills: GuiSkill[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue; // 目录级 symlink 也在此被挡(isDirectory 不认 symlink)
    const id = e.name;
    const file = path.join(realRoot, id, "SKILL.md");
    let raw: string;
    try {
      const real = await fs.realpath(file);
      if (!insideDir(realRoot, real)) {
        rejectGuiSkill(id, "SKILL.md 指向 skills/ 之外(symlink 越界)");
        continue;
      }
      raw = await fs.readFile(real, "utf-8");
    } catch {
      continue; // 无 SKILL.md 的目录跳过(与 listSkills 同)
    }

    const fm = parseSingleLineFrontmatter(raw);
    const surfaces = (fm.surfaces ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    // 没声明 gui 的是 harness-only,属正常状态不是错误——静默跳过,不刷警告
    if (!surfaces.includes("gui")) continue;

    if (fm.name !== id) {
      rejectGuiSkill(id, `frontmatter name「${fm.name ?? ""}」与目录名不一致`);
      continue;
    }
    const summary = fm.gui_summary ?? "";
    if (!summary) {
      rejectGuiSkill(id, "缺少单行 gui_summary(索引无法生成)");
      continue;
    }
    const guiContent = extractGuiSection(raw);
    if (!guiContent) {
      rejectGuiSkill(id, "标了 gui 表面却没有 `## GUI` 节");
      continue;
    }
    if (guiContent.length > MAX_GUI_SECTION_CHARS) {
      rejectGuiSkill(id, `GUI 节 ${guiContent.length} 字符,超过 ${MAX_GUI_SECTION_CHARS} 上限`);
      continue;
    }
    skills.push({ id, summary, guiContent });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

/** 进程内 lazy 缓存(按目录键):设计明确不做热重载,改 SKILL.md 需重启 */
const guiSkillCache = new Map<string, Promise<GuiSkill[]>>();

/**
 * GUI 对话面的技能白名单(fail-closed):surfaces 含 gui + name===目录名 + realpath 在
 * skills/ 内 + 有 gui_summary + 有 `## GUI` 节 + 节 ≤6000 字符,全过才收,任一不过跳过并警告。
 */
export function listGuiSkills(skillsDir: string = SKILLS_DIR): Promise<GuiSkill[]> {
  const key = path.resolve(skillsDir);
  let cached = guiSkillCache.get(key);
  if (!cached) {
    cached = loadGuiSkills(key);
    guiSkillCache.set(key, cached);
  }
  return cached;
}
