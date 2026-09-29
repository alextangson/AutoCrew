/**
 * 总编辑本机 agent 的工作目录与人设（spec §地基 12）。
 *
 * cwd 固定 `~/.autocrew/chief-editor/`，每次开轮前把人设写进定界符之间（复用 host-cli 的
 * applyPersonaSection：用户自己加在文件里的内容一个字不动）。Claude 读 CLAUDE.md；
 * Codex / WorkBuddy 的 AGENTS.md / CODEBUDDY.md 阶段 2 按同一段文本补。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyPersonaSection } from "../host-cli.js";
import type { LocalBackendId } from "./backends.js";

export const CHIEF_EDITOR_PERSONA = `# AutoCrew 总编辑

你是 AutoCrew 编辑部的总编辑，正在网页对话框里回复创始人。

- 一律用中文回复，说人话、短句；先给结论，再说你做了什么。
- 写完或改完稿，回复只写简短总结：改了什么、还有什么待定、下一步是什么，并说一句在编辑器打开这篇（标题 + 稿件 id）。绝不把稿件正文贴进回复——创始人在编辑器里看稿。
- 写稿、审稿、改稿、发布一律通过 AutoCrew MCP 工具（服务名 autocrew）完成，不要直接改资料库里的文件，也不要读令牌文件。
- 发布类动作（推草稿箱、标记已发布、删稿、删素材、删流水线）会先回 approval_required：停下来告诉创始人在等他批准，别换别的办法执行。收到「已批准 approval_id=…」后，用完全相同的参数加上 approval_id 重调。
- 工具回 claim_held（稿件被别的会话占着）时，如实告诉创始人是谁占着，不要绕过、不要抢。
- 跑 shell 或写文件前系统会弹权限卡；被拒绝就停下说明，不要换一种方式硬做。
- 你只接了 AutoCrew 的 MCP 和 AutoCrew 自带的技能。创始人要你用别的工具（如 ChatCut、浏览器、其他 MCP）时，直说这里做不到，不要想办法另外加载。
- 结果不确定的写操作不要自己重试；说清楚做到哪一步了。
- 工具报错时先读错误原因：能改就改了再试，同一个动作最多重试 2 次；还不行就在回复里说清「哪一步失败、为什么、创始人可以怎么做」。绝不把没成功的事说成成功。`;

const PERSONA_FILE: Record<LocalBackendId, string> = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
};

/** AutoCrew 自带技能目录（仓库 skills/） */
export function repoSkillsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
}

/**
 * 只给 agent 挂 AutoCrew 自己的技能：`<cwd>/.claude/skills` 软链到仓库 skills/（项目级来源，
 * 减负后唯一加载的技能来源）。已有同名的真实目录不动，免得覆盖用户放进去的东西。
 */
export function ensureSkills(home: string, skillsDir = repoSkillsDir()): void {
  const dir = path.join(home, ".claude");
  const link = path.join(dir, "skills");
  fs.mkdirSync(dir, { recursive: true });
  const stat = fs.lstatSync(link, { throwIfNoEntry: false });
  if (stat && !stat.isSymbolicLink()) return;
  if (stat && fs.readlinkSync(link) === skillsDir) return;
  if (stat) fs.unlinkSync(link);
  fs.symlinkSync(skillsDir, link, "dir");
}

export function ensurePersona(home: string, backend: LocalBackendId): string {
  if (backend === "claude") ensureSkills(home);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, PERSONA_FILE[backend]);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  const next = applyPersonaSection(existing, CHIEF_EDITOR_PERSONA);
  if (next !== existing) fs.writeFileSync(file, next, "utf-8");
  return file;
}
