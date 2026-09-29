/**
 * WorkBuddy 反向接入（spec「WorkBuddy：反向接」W1–W8）：WorkBuddy 当宿主，自己连 AutoCrew MCP。
 *
 * 做两件事：发 `workbuddy` 命名令牌；往 `~/.workbuddy/mcp.json` 合并一条 stdio 条目 `autocrew`
 * （走现有 `bin/autocrew.mjs mcp` 转发器，带 AUTOCREW_HOST=workbuddy，只认这个宿主的令牌——撤销后 401，不回落到本机全能令牌）。
 * 文件纪律：不存在就新建；解析失败绝不覆盖，报错让人手修；写前备份到 `mcp.json.autocrew-bak`；
 * 已有 autocrew 就原地更新（仓库挪了位置也能修好）；别的条目（ChatCut 等）一个字不动。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureHostToken } from "./host-tokens.js";

export const WORKBUDDY_HOST = "workbuddy";
export const WORKBUDDY_APP_PATHS = ["/Applications/WorkBuddy.app", path.join(os.homedir(), "Applications", "WorkBuddy.app")];

export function workbuddyInstalled(paths: string[] = WORKBUDDY_APP_PATHS): boolean {
  return paths.some((p) => existsSync(p));
}

function repoRoot(): string {
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

export function autocrewEntry(root = repoRoot(), node = stableNodePath()): Record<string, unknown> {
  return { type: "stdio", command: node, args: [path.join(root, "bin", "autocrew.mjs"), "mcp"], env: { AUTOCREW_HOST: WORKBUDDY_HOST } };
}

export type MergeOutcome = "created" | "added" | "updated";

/** JSON.parse 的报错只留位置，不带原文片段（文件里可能有别的服务的密钥） */
function parseErrorWhere(err: unknown, raw: string): string {
  const pos = /position (\d+)/.exec(err instanceof Error ? err.message : "")?.[1];
  if (!pos) return "无法解析";
  const before = raw.slice(0, Number(pos));
  return `第 ${before.split("\n").length} 行附近`;
}

export function mergeWorkbuddyMcp(home: string, entry = autocrewEntry()): { ok: true; file: string; outcome: MergeOutcome; backup?: string } | { ok: false; error: string } {
  const dir = path.join(home, ".workbuddy");
  const file = path.join(dir, "mcp.json");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ mcpServers: { autocrew: entry } }, null, 2)}\n`, "utf-8");
    return { ok: true, file, outcome: "created" };
  }
  const raw = readFileSync(file, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `${file} 解析失败（${parseErrorWhere(err, raw)}），没有写入。先手动修好这个文件再点连接。` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: `${file} 不是一个 JSON 对象，没有写入。先手动修好再点连接。` };
  const doc = parsed as { mcpServers?: unknown };
  if (doc.mcpServers !== undefined && (typeof doc.mcpServers !== "object" || doc.mcpServers === null || Array.isArray(doc.mcpServers))) {
    return { ok: false, error: `${file} 里的 mcpServers 不是对象，没有写入。先手动修好再点连接。` };
  }
  const servers = { ...((doc.mcpServers as Record<string, unknown>) ?? {}) };
  const outcome: MergeOutcome = servers.autocrew ? "updated" : "added";
  servers.autocrew = entry;
  const backup = `${file}.autocrew-bak`;
  copyFileSync(file, backup);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...doc, mcpServers: servers }, null, 2)}\n`, "utf-8");
  renameSync(tmp, file);
  return { ok: true, file, outcome, backup };
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
  return `通过 autocrew MCP 调用 autocrew_desk 打开《${title}》（id: ${id}），总结这篇现在在哪一步、卡在哪，然后等我指示，先不要改任何东西。`;
}
