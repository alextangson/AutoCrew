/**
 * server 访问 token 的持久化（两台电脑协作场景）——主机常开、笔记本远程连时,
 * token 每次重启都变会让远端书签失效。解析优先级:
 *   env AUTOCREW_TOKEN（想轮换/CI 固定）> <dataDir>/server-token（落盘,重启不变）> 新生成并落盘。
 * 落盘失败(只读盘等)退化为纯内存 token（重启会变,但不阻断启动）。
 * 文件 600 权限:能读到它 = 能长期访问本机 server,与访问 dataDir 同级敏感。
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { getHostStateDir } from "../storage/storage-roots.js";

const TOKEN_FILE = "server-token";

export function resolveServerToken(dataDir?: string): string {
  const fromEnv = process.env.AUTOCREW_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const dir = getHostStateDir(dataDir);
  const tokenPath = path.join(dir, TOKEN_FILE);
  try {
    const existing = readFileSync(tokenPath, "utf-8").trim();
    if (existing) return existing;
  } catch {
    /* 首次:落盘生成 */
  }

  const token = randomBytes(24).toString("hex");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
  } catch {
    /* 落盘失败:退化为内存 token(重启会变,但不阻断启动) */
  }
  return token;
}

const SESSION_SECRET_FILE = "session-secret";

/**
 * 浏览器会话签名密钥：与 server-token 分开存，任何自动化客户端（MCP 转发器、CLI）都不读它。
 * 持久化是为了重启后浏览器会话不掉；落盘失败退化为内存值（重启要重新打开启动链接）。
 */
export function resolveSessionSecret(dataDir?: string): string {
  const dir = getHostStateDir(dataDir);
  const file = path.join(dir, SESSION_SECRET_FILE);
  try {
    const existing = readFileSync(file, "utf-8").trim();
    if (existing) return existing;
  } catch {
    /* 首次生成 */
  }
  const secret = randomBytes(32).toString("hex");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, secret + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    /* 退化为内存密钥 */
  }
  return secret;
}
