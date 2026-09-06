/**
 * 命名宿主 token（P3 §4.1）——归因 + 撤销。
 *
 * 一个 token 一个文件：`<dataDir>/tokens/<host>.token`（0600，目录 0700）。
 * 认证时接受目录下任意一个，`principal.subject` 就是文件名里的宿主名；旧的
 * `<dataDir>/server-token` 继续有效，subject 仍是 `local-user`。
 * 撤销 = 删文件，下一次调用立刻 401。
 *
 * 「最后调用时间」记在同名的 `<host>.used` 空文件的 mtime 上，节流到每分钟一次：
 * token 文件自己的 mtime 要留给创建时间，而单独一个 index.json 会引入解析与并发写
 * 两类新失败——touch 一个空文件是活得过重启的最简做法。
 *
 * 风险如实记：token 是本机全能凭证，一把能调全部工具。本篇不做按宿主的工具白名单
 * （单用户本机，威胁模型是误操作不是恶意）。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { getDataDir } from "../storage/local-store.js";

/** 宿主名同时是文件名，所以限死小写字母开头的 kebab，路径穿越无从谈起。 */
export const HOST_NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

const TOKEN_SUFFIX = ".token";
const USED_SUFFIX = ".used";
const LAST_USED_THROTTLE_MS = 60_000;

export interface HostTokenInfo {
  host: string;
  createdAt: string;
  lastUsedAt?: string;
}

export function tokensDir(dataDir?: string): string {
  return path.join(getDataDir(dataDir), "tokens");
}

function assertHost(host: string): string {
  if (!HOST_NAME_PATTERN.test(host)) {
    throw new Error(`宿主名不合法：${host}（只允许小写字母开头的 2-32 位 a-z0-9-）`);
  }
  return host;
}

function tokenPath(host: string, dataDir?: string): string {
  return path.join(tokensDir(dataDir), `${assertHost(host)}${TOKEN_SUFFIX}`);
}

/**
 * 确保 `<dataDir>/tokens/<host>.token` 存在，返回**文件路径**。
 *
 * 故意不返回 token 值：这个函数的调用方是 CLI 与看板，它们只该打印路径；
 * 值一旦经过日志/终端记录就等于泄漏了编辑部钥匙。
 */
export function ensureHostToken(host: string, dataDir?: string): string {
  const file = tokenPath(host, dataDir);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (!existsSync(file)) {
    writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  }
  chmodSync(file, 0o600);
  return file;
}

export function listHostTokens(dataDir?: string): HostTokenInfo[] {
  const dir = tokensDir(dataDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const tokens: HostTokenInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(TOKEN_SUFFIX)) continue;
    const host = entry.slice(0, -TOKEN_SUFFIX.length);
    if (!HOST_NAME_PATTERN.test(host)) continue;
    const createdAt = new Date(statSync(path.join(dir, entry)).mtimeMs).toISOString();
    const lastUsedAt = readLastUsed(dir, host);
    tokens.push(lastUsedAt ? { host, createdAt, lastUsedAt } : { host, createdAt });
  }
  return tokens.sort((a, b) => a.host.localeCompare(b.host));
}

/** 撤销 = 删文件。返回是否真的删掉了一个（没有就是本来没有）。 */
export function revokeHostToken(host: string, dataDir?: string): boolean {
  const file = tokenPath(host, dataDir);
  const existed = existsSync(file);
  rmSync(file, { force: true });
  rmSync(path.join(tokensDir(dataDir), `${host}${USED_SUFFIX}`), { force: true });
  return existed;
}

function readLastUsed(dir: string, host: string): string | undefined {
  try {
    return new Date(statSync(path.join(dir, `${host}${USED_SUFFIX}`)).mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

/** 节流到每分钟一次：MCP 宿主一轮对话能打几十个 tools/call，没必要每发都写盘。 */
function touchLastUsed(dir: string, host: string, now: number): void {
  const marker = path.join(dir, `${host}${USED_SUFFIX}`);
  try {
    if (now - statSync(marker).mtimeMs < LAST_USED_THROTTLE_MS) return;
    utimesSync(marker, new Date(now), new Date(now));
  } catch {
    try {
      writeFileSync(marker, "", { mode: 0o600 });
      utimesSync(marker, new Date(now), new Date(now));
    } catch {
      /* 只读盘等：最后调用时间丢了不该阻断认证 */
    }
  }
}

/**
 * 拿一个 bearer token 反查宿主名；命中就顺手记一次「最后调用时间」。
 *
 * 逐个常数时间比对——目录里就三五个文件，为省这点比对而先按长度筛，等于把长度
 * 泄漏出去，不划算。
 */
export function lookupHostToken(token: string, dataDir?: string, now: number = Date.now()): string | null {
  const dir = tokensDir(dataDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith(TOKEN_SUFFIX)) continue;
    const host = entry.slice(0, -TOKEN_SUFFIX.length);
    if (!HOST_NAME_PATTERN.test(host)) continue;
    let stored: string;
    try {
      stored = readFileSync(path.join(dir, entry), "utf-8").trim();
    } catch {
      continue;
    }
    if (!stored || !constantTimeEqual(stored, token)) continue;
    touchLastUsed(dir, host, now);
    return host;
  }
  return null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
