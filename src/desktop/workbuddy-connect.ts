/**
 * WorkBuddy 反向接入（spec「WorkBuddy：反向接」W1–W8）：WorkBuddy 当宿主，自己连 AutoCrew MCP。
 *
 * 做两件事：发 `workbuddy` 命名令牌；往 `~/.workbuddy/mcp.json` 合并一条 stdio 条目 `autocrew`
 * （走现有 `bin/autocrew.mjs mcp` 转发器，带 AUTOCREW_HOST=workbuddy，只认这个宿主的令牌——撤销后 401，不回落到本机全能令牌）。
 * 文件纪律：不存在就新建；解析失败绝不覆盖，报错让人手修；写前备份到 `mcp.json.autocrew-bak`；
 * 已有 autocrew 就原地更新（仓库挪了位置也能修好）；别的条目（ChatCut 等）一个字不动。
 */
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHostToken } from "./host-tokens.js";
import { mergeMcpJson, type MergeOutcome, type MergeResult } from "./host-connect/mcp-json-file.js";

export const WORKBUDDY_HOST = "workbuddy";
export const WORKBUDDY_APP_PATHS = ["/Applications/WorkBuddy.app", path.join(os.homedir(), "Applications", "WorkBuddy.app")];

export function workbuddyInstalled(paths: string[] = WORKBUDDY_APP_PATHS): boolean {
  return paths.some((p) => existsSync(p));
}

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * 条目里的 node 用稳定路径：Homebrew 的 execPath 带版本号（…/Cellar/node/26.5.0/bin/node），升级 node 就断；
 * 常见的稳定软链指向同一个可执行文件就用它。WorkBuddy 起进程时 PATH 未必有 Homebrew，所以不写裸 `node`。
 */
export function stableNodePath(exec = process.execPath, candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]): string {
  for (const c of candidates) {
    try { if (existsSync(c) && realpathSync(c) === realpathSync(exec)) return c; } catch { /* 下一个 */ }
  }
  return exec;
}

export function autocrewEntry(root = repoRoot(), node = stableNodePath(), env: NodeJS.ProcessEnv = process.env, host = WORKBUDDY_HOST): Record<string, unknown> {
  // 守护进程若跑在非默认端口 / 状态目录，WorkBuddy 起的转发器也得指过去（评审 P2-9）
  const extra = Object.fromEntries((["AUTOCREW_PORT", "AUTOCREW_LOCAL_DIR"] as const).filter((k) => env[k]).map((k) => [k, env[k] as string]));
  return { type: "stdio", command: node, args: [path.join(root, "bin", "autocrew.mjs"), "mcp"], env: { AUTOCREW_HOST: host, ...extra } };
}

export type { MergeOutcome } from "./host-connect/mcp-json-file.js";

/** 合并逻辑在 host-connect/mcp-json-file（三个宿主共用同一套备份 / 原子写 / 不跟软链纪律） */
export function mergeWorkbuddyMcp(home: string, entry = autocrewEntry(), hooks: { beforeRename?: () => void } = {}): MergeResult {
  return mergeMcpJson(path.join(home, ".workbuddy", "mcp.json"), entry, hooks);
}

const OUTCOME_TEXT: Record<MergeOutcome, string> = {
  created: "新建了 WorkBuddy 的 MCP 配置，里面只有 autocrew 一条",
  added: "在 WorkBuddy 的 MCP 配置里加了 autocrew 一条，别的条目原样保留",
  updated: "更新了 WorkBuddy 配置里已有的 autocrew 条目（指向当前的 AutoCrew）",
};

/** 「连接 WorkBuddy」：没装就不写（W1）；发令牌 + 合并配置；提示重启（W6） */
export function connectWorkbuddy(opts: { home?: string; dataDir?: string; installed?: boolean; entry?: Record<string, unknown> } = {}): Record<string, unknown> {
  if (!(opts.installed ?? workbuddyInstalled())) return { ok: false, error: "没找到 WorkBuddy（/Applications/WorkBuddy.app）。装好后再点连接；「复制给 WorkBuddy」不受影响。" };
  const merged = mergeWorkbuddyMcp(opts.home ?? os.homedir(), opts.entry ?? autocrewEntry());
  if (!merged.ok) return merged;
  ensureHostToken(WORKBUDDY_HOST, opts.dataDir);
  return {
    ok: true,
    data: { file: merged.file, outcome: merged.outcome, ...(merged.backup ? { backup: merged.backup } : {}) },
    message: `${OUTCOME_TEXT[merged.outcome]}。重启 WorkBuddy 后生效。`,
  };
}

/** 「复制给 WorkBuddy」的那句话（创始人认过的措辞） */
export function workbuddyPrompt(title: string, id: string): string {
  return `通过 autocrew MCP 调用 autocrew_content summary 查看《${title}》（id: ${id}），总结这篇现在在哪一步、卡在哪，然后等我指示，先不要改任何东西。`;
}
