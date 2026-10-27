/**
 * Codex 里 AutoCrew 工具免审批（2026-10-26 安克首跑：后台 Codex 任务审批策略是 never，调 AutoCrew 工具一律
 * 「MCP tool call requires approval」被拒，缩略图和登记只能等会话补）。
 *
 * Codex 的 config.toml 支持按 MCP 服务设 `default_tools_approval_mode`（auto / prompt / writes / approve；
 * codex-cli 0.153 实测非法值报错列出这四个）。只给 `[mcp_servers.autocrew]` 这一段写 `approve`，
 * 不动全局 approval_policy、也不碰别的服务。`codex mcp add` 没有这个选项，所以 add 之后直接改这一段。
 */
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { codexConfigFile } from "./detect.js";
import type { HostEnv } from "./env.js";

export const CODEX_APPROVAL_KEY = "default_tools_approval_mode";
export const CODEX_APPROVAL_VALUE = "approve";
const HEADER = /^\s*\[\s*mcp_servers\.(?:autocrew|"autocrew")\s*\]\s*(#.*)?$/;
const ANY_HEADER = /^\s*\[/;
const KEY_LINE = new RegExp(`^\\s*${CODEX_APPROVAL_KEY}\\s*=`);

/** [mcp_servers.autocrew] 这一段的行区间 [表头, 下一个表头)；没有 = null */
function section(lines: string[]): [number, number] | null {
  const start = lines.findIndex((l) => HEADER.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !ANY_HEADER.test(lines[end])) end++;
  return [start, end];
}

/** 这一段里 default_tools_approval_mode 的值；没有条目 / 没写 = null */
export function codexApprovalMode(env: HostEnv): string | null {
  let raw: string;
  try { raw = readFileSync(codexConfigFile(env), "utf-8"); } catch { return null; }
  const lines = raw.split("\n");
  const s = section(lines);
  if (!s) return null;
  const line = lines.slice(s[0] + 1, s[1]).find((l) => KEY_LINE.test(l));
  const m = line ? /=\s*"([^"]*)"/.exec(line) : null;
  return m ? m[1] : null;
}

/** 给 autocrew 这一段写上 approve（已经是就不动）；文件或条目不在、写不进去都如实报 */
export function ensureCodexAutoApprove(env: HostEnv): { ok: true; changed: boolean } | { ok: false; error: string } {
  const file = codexConfigFile(env);
  let raw: string;
  try { raw = readFileSync(file, "utf-8"); } catch (e) { return { ok: false, error: `读不了 ${file}：${e instanceof Error ? e.message : String(e)}` }; }
  const lines = raw.split("\n");
  const s = section(lines);
  if (!s) return { ok: false, error: `${file} 里没有 [mcp_servers.autocrew]，免审批没写上` };
  const want = `${CODEX_APPROVAL_KEY} = "${CODEX_APPROVAL_VALUE}"`;
  const at = lines.slice(s[0] + 1, s[1]).findIndex((l) => KEY_LINE.test(l));
  if (at >= 0) {
    if (lines[s[0] + 1 + at].trim() === want) return { ok: true, changed: false };
    lines[s[0] + 1 + at] = want;
  } else {
    lines.splice(s[0] + 1, 0, want);
  }
  try {
    const mode = statSync(file).mode & 0o777;
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.autocrew-${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(tmp, lines.join("\n"), { encoding: "utf-8", flag: "wx", mode });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) { return { ok: false, error: `写不进 ${file}：${e instanceof Error ? e.message : String(e)}` }; }
  return { ok: true, changed: true };
}

/** doctor 用：接了 Codex 时 AutoCrew 工具是不是免审批（没接 Codex = null，不算问题） */
export function codexApprovalStatus(env: HostEnv, connected: boolean): { name: string; ok: boolean; detail: string } | null {
  if (!connected) return null;
  const mode = codexApprovalMode(env);
  return mode === CODEX_APPROVAL_VALUE
    ? { name: "导演椅工具免审批", ok: true, detail: "Codex 后台任务能直接调导演椅工具" }
    : { name: "导演椅工具免审批", ok: false, detail: `[mcp_servers.autocrew] 的 ${CODEX_APPROVAL_KEY} 是 ${mode ?? "没设"}，后台 Codex（审批策略 never）调导演椅工具会被拒` };
}
