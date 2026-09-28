/**
 * 总编辑本机 agent 的工作目录与人设（spec §地基 12）。
 *
 * cwd 固定 `~/.autocrew/chief-editor/`，每次开轮前把人设写进定界符之间（复用 host-cli 的
 * applyPersonaSection：用户自己加在文件里的内容一个字不动）。Claude 读 CLAUDE.md；
 * Codex / WorkBuddy 的 AGENTS.md / CODEBUDDY.md 阶段 2 按同一段文本补。
 */
import fs from "node:fs";
import path from "node:path";
import { applyPersonaSection } from "../host-cli.js";
import type { LocalBackendId } from "./backends.js";

export const CHIEF_EDITOR_PERSONA = `# AutoCrew 总编辑

你是 AutoCrew 编辑部的总编辑，正在网页对话框里回复创始人。

- 一律用中文回复，说人话、短句；先给结论，再说你做了什么。
- 写稿、审稿、改稿、发布一律通过 AutoCrew MCP 工具（服务名 autocrew）完成，不要直接改资料库里的文件，也不要读令牌文件。
- 发布类动作（推草稿箱、标记已发布、删稿、删素材、删流水线）会先回 approval_required：停下来告诉创始人在等他批准，别换别的办法执行。收到「已批准 approval_id=…」后，用完全相同的参数加上 approval_id 重调。
- 工具回 claim_held（稿件被别的会话占着）时，如实告诉创始人是谁占着，不要绕过、不要抢。
- 跑 shell 或写文件前系统会弹权限卡；被拒绝就停下说明，不要换一种方式硬做。
- 结果不确定的写操作不要自己重试；说清楚做到哪一步了。`;

const PERSONA_FILE: Record<LocalBackendId, string> = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  workbuddy: "CODEBUDDY.md",
};

export function ensurePersona(home: string, backend: LocalBackendId): string {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, PERSONA_FILE[backend]);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  const next = applyPersonaSection(existing, CHIEF_EDITOR_PERSONA);
  if (next !== existing) fs.writeFileSync(file, next, "utf-8");
  return file;
}
