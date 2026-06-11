/**
 * Conversation store — 对话持久化（S2.8）。
 *
 * 目录模式镜像 contents：~/.autocrew/conversations/<id>/
 *   meta.json      — ConversationMeta（列表只读此文件，廉价）
 *   messages.json  — ConversationMessage[]（回放全量）
 *
 * 与 local-store 的差异（有意为之）：写入一律 temp+rename 原子写——
 * 会话文件每轮整体重写，进程中断不能留半个 JSON。
 * id 经正则校验（renderer 可控输入，防路径穿越）。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { getDataDir } from "./local-store.js";

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  /** 仅 assistant：本轮工具产出的卡片，只做回放渲染，不进 LLM 上下文 */
  cards?: Record<string, unknown>[];
  ts: string;
}

export interface Conversation {
  meta: ConversationMeta;
  messages: ConversationMessage[];
}

const TITLE_MAX = 30;
const ID_RE = /^conv-\d+-[a-z0-9]+$/;

/** 标题 = 首条 user 消息（空白折叠）按码点截 30 字，CJK 安全；超长加 … */
export function makeTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim().replace(/\s+/g, " ");
  const chars = Array.from(trimmed);
  if (chars.length <= TITLE_MAX) return trimmed || "（空白会话）";
  return chars.slice(0, TITLE_MAX).join("") + "…";
}

async function conversationsRoot(dataDir?: string): Promise<string> {
  const root = path.join(getDataDir(dataDir), "conversations");
  await fs.mkdir(root, { recursive: true });
  return root;
}

/** temp + rename 原子写（同目录，rename 不跨设备） */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 6);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${rnd}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
    await fs.rename(tmp, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmp);
    } catch {
      // best-effort cleanup, ignore unlink errors
    }
    throw err;
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** 路径穿越守卫：仅当 id 合法时返回目录路径，否则返回 null */
function safeConvDir(root: string, id: string): string | null {
  if (!ID_RE.test(id)) return null;
  return path.join(root, id);
}

export async function createConversation(
  firstUserMessage: string,
  dataDir?: string,
): Promise<ConversationMeta> {
  const root = await conversationsRoot(dataDir);
  const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const meta: ConversationMeta = {
    id,
    title: makeTitle(firstUserMessage),
    createdAt: now,
    updatedAt: now,
    turns: 0,
  };
  const convDir = path.join(root, id);
  await fs.mkdir(convDir, { recursive: true });
  // messages.json 先写，meta.json 作提交记录——crash 期间不会出现有 meta 无 messages 的半残会话
  await writeJsonAtomic(path.join(convDir, "messages.json"), []);
  await writeJsonAtomic(path.join(convDir, "meta.json"), meta);
  return meta;
}

export async function getConversation(
  id: string,
  dataDir?: string,
): Promise<Conversation | null> {
  const root = await conversationsRoot(dataDir);
  const convDir = safeConvDir(root, id);
  if (!convDir) return null;
  const meta = await readJson<ConversationMeta>(path.join(convDir, "meta.json"));
  const messages = await readJson<ConversationMessage[]>(path.join(convDir, "messages.json"));
  if (!meta || typeof meta.id !== "string" || !Array.isArray(messages)) return null;
  return { meta, messages };
}

export async function appendTurn(
  id: string,
  user: { content: string },
  assistant: { content: string; cards?: Record<string, unknown>[] },
  dataDir?: string,
): Promise<ConversationMeta | null> {
  const existing = await getConversation(id, dataDir);
  if (!existing) return null;
  const root = await conversationsRoot(dataDir);
  const convDir = safeConvDir(root, id);
  if (!convDir) return null;
  const now = new Date().toISOString();
  const messages = existing.messages;
  messages.push({ role: "user", content: user.content, ts: now });
  messages.push({
    role: "assistant",
    content: assistant.content,
    ...(assistant.cards && assistant.cards.length > 0 ? { cards: assistant.cards } : {}),
    ts: now,
  });
  const meta: ConversationMeta = { ...existing.meta, turns: existing.meta.turns + 1, updatedAt: now };
  await writeJsonAtomic(path.join(convDir, "messages.json"), messages);
  await writeJsonAtomic(path.join(convDir, "meta.json"), meta);
  return meta;
}

export async function listConversations(dataDir?: string): Promise<ConversationMeta[]> {
  const root = await conversationsRoot(dataDir);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const metas: ConversationMeta[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = await readJson<ConversationMeta>(path.join(root, e.name, "meta.json"));
    if (!meta || typeof meta.id !== "string" || typeof meta.updatedAt !== "string") {
      console.warn(`[conversation-store] 跳过损坏会话：${e.name}`);
      continue;
    }
    metas.push(meta);
  }
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteConversation(id: string, dataDir?: string): Promise<boolean> {
  const root = await conversationsRoot(dataDir);
  const convDir = safeConvDir(root, id);
  if (!convDir) return false;
  try {
    await fs.access(convDir);
  } catch {
    return false;
  }
  await fs.rm(convDir, { recursive: true, force: true });
  return true;
}
