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
import { writeJsonAtomic, readJson } from "./json-atomic.js";

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  /**
   * 会话归属的稿件（软绑定）。additive 扩展——旧会话没这个字段照常读，
   * 只是永远不会被「打开稿件自动切会话」命中，纯手动，这是预期。
   * 有意不做硬隔离：跨稿件聊（「借鉴抖音那篇的开头」）必须仍然可行。
   */
  contentId?: string;
  /**
   * 总编辑后端（总编辑接本机 agent spec §地基 12）：对话的后端以这里为准，localStorage 只作新对话默认值。
   * 缺席 = 内置引擎（旧会话）。additive 扩展。
   */
  backend?: string;
  /** 本机 agent 的 ACP session id：下一轮 session/load 续上它，续不上就新开并在回复里说一句 */
  acpSessionId?: string;
  /** 本机 agent 的对话级设置（模型 / 思考强度 / 全部放行），轮次开始时读一次 */
  agentSettings?: { model?: string; effort?: string; permissionMode?: "ask" | "bypass" };
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  /** 仅 assistant：本轮工具产出的卡片，只做回放渲染，不进 LLM 上下文 */
  cards?: Record<string, unknown>[];
  /**
   * 仅 assistant：本轮的 turnId（对话控制面设计 §Phase 3 断线恢复契约）。
   * additive 扩展——旧记录没有这个字段照常读。用途是「响应丢了但结果已落盘」时
   * 客户端能凭 turnId 认出自己那一轮。
   */
  turnId?: string;
  /**
   * 仅 user：这条不是人说的，是后台任务回来了（调研回流轮的【调研回报】）。
   * additive 扩展——旧记录没有这个字段照常读，缺席即「用户本人说的」。
   * 渲染层据此不画成用户气泡：把系统消息装成用户发言，回看时会误以为自己说过。
   */
  origin?: "system";
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

/** 路径穿越守卫：仅当 id 合法时返回目录路径，否则返回 null */
function safeConvDir(root: string, id: string): string | null {
  if (!ID_RE.test(id)) return null;
  return path.join(root, id);
}

export async function createConversation(
  firstUserMessage: string,
  dataDir?: string,
  contentId?: string,
  extra?: { backend?: string },
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
    // 空串不写：没绑定和绑了个空 id 在读取侧是两回事
    ...(contentId ? { contentId } : {}),
    ...(extra?.backend ? { backend: extra.backend } : {}),
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
  user: { content: string; origin?: "system" },
  assistant: { content: string; cards?: Record<string, unknown>[]; turnId?: string },
  dataDir?: string,
): Promise<ConversationMeta | null> {
  const existing = await getConversation(id, dataDir);
  if (!existing) return null;
  const root = await conversationsRoot(dataDir);
  const convDir = safeConvDir(root, id);
  if (!convDir) return null;
  const now = new Date().toISOString();
  const messages = existing.messages;
  messages.push({
    role: "user",
    content: user.content,
    ...(user.origin ? { origin: user.origin } : {}),
    ts: now,
  });
  messages.push({
    role: "assistant",
    content: assistant.content,
    ...(assistant.cards && assistant.cards.length > 0 ? { cards: assistant.cards } : {}),
    ...(assistant.turnId ? { turnId: assistant.turnId } : {}),
    ts: now,
  });
  const meta: ConversationMeta = { ...existing.meta, turns: existing.meta.turns + 1, updatedAt: now };
  await writeJsonAtomic(path.join(convDir, "messages.json"), messages);
  await writeJsonAtomic(path.join(convDir, "meta.json"), meta);
  return meta;
}

/** 只改 meta 里的后端绑定字段（ACP session id 拿到即落盘，不等本轮结束） */
export async function updateConversationAgent(
  id: string,
  patch: { acpSessionId?: string; agentSettings?: ConversationMeta["agentSettings"] },
  dataDir?: string,
): Promise<ConversationMeta | null> {
  const existing = await getConversation(id, dataDir);
  if (!existing) return null;
  const convDir = safeConvDir(await conversationsRoot(dataDir), id);
  if (!convDir) return null;
  const meta: ConversationMeta = { ...existing.meta, ...patch };
  await writeJsonAtomic(path.join(convDir, "meta.json"), meta);
  return meta;
}

export const TITLE_EDIT_MAX = 40;

/**
 * 改对话标题（v1.1 U6）：去空白后为空 → 不保存（返回 null，调用方保留原名）；按码点截到 40 字；
 * 两个标签页同时改就是后写覆盖，别处刷新后看到新名。
 */
export async function renameConversation(id: string, title: string, dataDir?: string): Promise<ConversationMeta | null> {
  const clean = title.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const existing = await getConversation(id, dataDir);
  if (!existing) return null;
  const convDir = safeConvDir(await conversationsRoot(dataDir), id);
  if (!convDir) return null;
  const meta: ConversationMeta = { ...existing.meta, title: Array.from(clean).slice(0, TITLE_EDIT_MAX).join("") };
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
