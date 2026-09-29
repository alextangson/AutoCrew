/**
 * 当前对话（或新对话）的模型 / 强度 / 权限模式（v1.1）。已有对话以服务端为准（meta.agentSettings +
 * 「本对话都允许」内存态）；新对话先记在本地，随第一条消息一起发。
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { changedSinceSend, DEFAULT_SETTINGS, enteringNewConversation, settingsFromServer, settingsPayload, snapshotFromSave, type ConvSettings } from "./conv-settings";

export function useConvSettings(conversationId: string | undefined, conversationAllow: boolean) {
  const [settings, setSettings] = useState<ConvSettings>(DEFAULT_SETTINGS);
  const metaRef = useRef<unknown>(undefined);
  const allowRef = useRef(conversationAllow);
  const ref = useRef(settings);
  ref.current = settings;
  /** 新对话首轮发出去时带走的那份（拿到 id 后与当前比，变了就补存） */
  const sentRef = useRef<ConvSettings | null>(null);
  const prevConv = useRef(conversationId);

  useEffect(() => {
    // 任何进入新对话的入口都重置（评审 v1.1 P1-2）
    if (enteringNewConversation(prevConv.current, conversationId)) {
      metaRef.current = undefined;
      sentRef.current = null;
      setSettings(DEFAULT_SETTINGS);
    }
    prevConv.current = conversationId;
  }, [conversationId]);
  useEffect(() => {
    allowRef.current = conversationAllow;
    if (conversationId) setSettings(settingsFromServer(metaRef.current, conversationAllow));
  }, [conversationId, conversationAllow]);

  const save = async (id: string, next: ConvSettings) => {
    const r = await invoke("agent:settings", { conversation_id: id, ...settingsPayload(next) });
    const snap = snapshotFromSave(r);
    if (!snap) return toast(r.error ?? "设置没保存上");
    metaRef.current = snap.meta; // 评审 v1.1 P2-4：快照跟着保存结果走
    allowRef.current = snap.conversationAllow;
  };

  return {
    settings,
    ref,
    /** 打开一段对话：用它 meta 里的设置 */
    fromMeta(meta: unknown) {
      metaRef.current = meta;
      setSettings(settingsFromServer(meta, false));
    },
    /** 新对话首轮发出：记下带走的那份 */
    markSent() {
      sentRef.current = { ...ref.current };
    },
    /** 新对话首轮成功拿到 id：首轮带走的已落盘；之后又改过就补存（评审 v1.1 P2-5） */
    keepForNew(id: string) {
      const cur = ref.current;
      const sent = sentRef.current;
      metaRef.current = sent ? { model: sent.model, effort: sent.effort, permissionMode: sent.permissionMode === "bypass" ? "bypass" : "ask" } : undefined;
      sentRef.current = null;
      if (changedSinceSend(sent, cur)) void save(id, cur);
    },
    reset() {
      metaRef.current = undefined;
      sentRef.current = null;
      setSettings(DEFAULT_SETTINGS);
    },
    async change(next: ConvSettings) {
      setSettings(next);
      if (conversationId) await save(conversationId, next);
    },
  };
}
