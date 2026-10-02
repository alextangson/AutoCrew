/**
 * conversations:rename —— 对话改名（v1.1 U6）：空名不保存、截 40 字、后写覆盖；走按会话串行队列。
 * 原来和总编辑本机 agent 的 IPC 放在一起；本机 agent 后端删掉后（onboarding-connect，2026-10-02）单独留下。
 */
import { renameConversation } from "../storage/conversation-store.js";
import { enqueueConversationWrite } from "./chat-persist.js";

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export async function conversationRenameHandler(payload: Json): Promise<Json> {
  const id = str(payload.id);
  const title = typeof payload.title === "string" ? payload.title : "";
  if (!id) return { ok: false, error: "需要 id" };
  if (!title.trim()) return { ok: false, error: "标题不能为空，已保留原名" };
  const meta = await enqueueConversationWrite(id, () => renameConversation(id, title, str(payload._dataDir) || undefined));
  return meta ? { ok: true, data: { meta } } : { ok: false, error: "会话不存在或已损坏" };
}
