/**
 * 宿主的 JSON 版 MCP 配置（`~/.workbuddy/mcp.json`、找不到 claude 命令时的 `~/.claude.json`）
 * 的合并 / 删除 / 整文件备份。从 workbuddy-connect 抽出来，三个宿主共用同一套文件纪律（spec O6）：
 *
 * - 解析失败绝不覆盖，报错让人手修；软链一律拒绝（跟着链接写会改到别处的文件）；
 * - 写前把整份原文件备份到 `<file>.autocrew-bak`（权限与原文件一致）；
 * - 同目录临时文件 + rename 原子落盘；读到换名之间文件被宿主自己改过就不覆盖，如实说。
 * - 别的条目一个字不动。
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export const SERVER_NAME = "autocrew";

export type MergeOutcome = "created" | "added" | "updated" | "unchanged";
export type MergeResult = { ok: true; file: string; outcome: MergeOutcome; backup?: string } | { ok: false; error: string };
export type RemoveResult = { ok: true; file: string; removed: boolean; backup?: string } | { ok: false; error: string };

/** JSON.parse 的报错只留位置，不带原文片段（文件里可能有别的服务的密钥） */
function parseErrorWhere(err: unknown, raw: string): string {
  const pos = /position (\d+)/.exec(err instanceof Error ? err.message : "")?.[1];
  if (!pos) return "无法解析";
  return `第 ${raw.slice(0, Number(pos)).split("\n").length} 行附近`;
}

export function isSymlink(p: string): boolean {
  return lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
}

type Doc = { doc: Record<string, unknown>; servers: Record<string, unknown> };

/** 读 + 校验：拿到整份文档与 mcpServers（纯计算，不落盘） */
export function parseMcpDoc(file: string, raw: string, verb = "连接"): Doc | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `${file} 解析失败（${parseErrorWhere(err, raw)}），没有写入。先手动修好这个文件再点${verb}。` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: `${file} 不是一个 JSON 对象，没有写入。先手动修好再点${verb}。` };
  const doc = parsed as Record<string, unknown>;
  const servers = doc.mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
    return { error: `${file} 里的 mcpServers 不是对象，没有写入。先手动修好再点${verb}。` };
  }
  return { doc, servers: { ...((servers as Record<string, unknown>) ?? {}) } };
}

/** 文件里现有的 autocrew 条目；没有文件 / 没有条目 = undefined；读不懂 = { error } */
export function readMcpEntry(file: string): { entry?: unknown } | { error: string } {
  if (!existsSync(file)) return {};
  let raw: string;
  try { raw = readFileSync(file, "utf-8"); } catch (err) { return { error: `${file} 读不了：${errText(err)}` }; }
  const parsed = parseMcpDoc(file, raw);
  if ("error" in parsed) return parsed;
  return { entry: parsed.servers[SERVER_NAME] };
}

/** 键排序后的 JSON：判断「现有条目和要写的一样」用，不受键顺序影响 */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function sameEntry(a: unknown, b: unknown): boolean {
  return a !== undefined && canonical(a) === canonical(b);
}

/**
 * 整份文件备份到 `<file>.autocrew-bak-<时间戳>`。每次一份新文件、从不覆盖、也不清理：
 * 重试或断开时再备份，第一次替换前存下的用户原定义也还在（第 3 轮评审 P2，spec O7）。
 * 文件不存在 = 没什么可备份，回 null。抛错（软链、写不了）由调用方变成可见的失败。
 */
export function backupFile(file: string): string | null {
  if (!existsSync(file)) return null;
  if (isSymlink(file)) throw new Error(`${file} 是软链接，没有改它（跟着链接写可能改到别的文件）。`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..*/, "");
  const mode = statSync(file).mode & 0o777;
  let backup = `${file}.autocrew-bak-${stamp}`;
  // 同一秒里第二份：加随机尾巴；wx 独占创建，碰上同名（含软链）就失败而不是覆盖
  if (existsSync(backup) || isSymlink(backup)) backup = `${backup}-${randomBytes(3).toString("hex")}`;
  writeFileSync(backup, readFileSync(file), { flag: "wx", mode });
  chmodSync(backup, mode);
  return backup;
}

/** 同目录随机名、独占创建（O_EXCL，不跟软链）、权限与原文件一致 */
function writeExclusive(file: string, content: string, mode: number): string {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.autocrew-${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(tmp, content, { encoding: "utf-8", flag: "wx", mode });
  chmodSync(tmp, mode);
  return tmp;
}

/** 写回：先比对原文没被宿主改过，再 rename；改过就不覆盖 */
function swapIn(file: string, raw: string, next: string, hooks: { beforeRename?: () => void }): string | null {
  const tmp = writeExclusive(file, next, statSync(file).mode & 0o777);
  hooks.beforeRename?.();
  if (readFileSync(file, "utf-8") !== raw) {
    rmSync(tmp, { force: true });
    return `${file} 在写入过程中被别的程序改过了，没有覆盖。稍后再试一次。`;
  }
  renameSync(tmp, file);
  return null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function mergeMcpJson(file: string, entry: Record<string, unknown>, hooks: { beforeRename?: () => void } = {}): MergeResult {
  const dir = path.dirname(file);
  if (isSymlink(dir) || isSymlink(file)) return { ok: false, error: `${file} 或它所在的目录是软链接，没有写入（跟着链接写可能改到别的文件）。` };
  try {
    if (!existsSync(file)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // 独占创建：刚好宿主同时建了这个文件就失败，不覆盖它
      try {
        writeFileSync(file, `${JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2)}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });
      } catch {
        return { ok: false, error: `${file} 刚被别的程序建出来了，没有写入。稍后再试一次。` };
      }
      return { ok: true, file, outcome: "created" };
    }
    const raw = readFileSync(file, "utf-8");
    const parsed = parseMcpDoc(file, raw);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    // 现有条目就是要写的这一条：不是替换，不备份、不写盘
    if (sameEntry(parsed.servers[SERVER_NAME], entry)) return { ok: true, file, outcome: "unchanged" };
    const outcome: MergeOutcome = parsed.servers[SERVER_NAME] ? "updated" : "added";
    parsed.servers[SERVER_NAME] = entry;
    const backup = backupFile(file) as string;
    const conflict = swapIn(file, raw, `${JSON.stringify({ ...parsed.doc, mcpServers: parsed.servers }, null, 2)}\n`, hooks);
    if (conflict) return { ok: false, error: conflict };
    return { ok: true, file, outcome, backup };
  } catch (err) {
    return { ok: false, error: `写 ${file} 失败：${errText(err)}（原文件没动）` };
  }
}

export function removeMcpJson(file: string): RemoveResult {
  if (isSymlink(path.dirname(file)) || isSymlink(file)) return { ok: false, error: `${file} 或它所在的目录是软链接，没有改它。` };
  try {
    if (!existsSync(file)) return { ok: true, file, removed: false };
    const raw = readFileSync(file, "utf-8");
    const parsed = parseMcpDoc(file, raw, "断开");
    if ("error" in parsed) return { ok: false, error: parsed.error };
    if (!(SERVER_NAME in parsed.servers)) return { ok: true, file, removed: false };
    delete parsed.servers[SERVER_NAME];
    const backup = backupFile(file) as string;
    const conflict = swapIn(file, raw, `${JSON.stringify({ ...parsed.doc, mcpServers: parsed.servers }, null, 2)}\n`, {});
    if (conflict) return { ok: false, error: conflict };
    return { ok: true, file, removed: true, backup };
  } catch (err) {
    return { ok: false, error: `改 ${file} 失败：${errText(err)}（原文件没动）` };
  }
}
