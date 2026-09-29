/**
 * 当前对话（或新对话）的模型 / 强度 / 权限模式（v1.1）。已有对话以服务端为准（meta.agentSettings +
 * 「本对话都允许」内存态）；新对话先记在本地，随第一条消息一起发。
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import { DEFAULT_SETTINGS, settingsFromServer, settingsPayload, type ConvSettings } from "./conv-settings";

export function useConvSettings(conversationId: string | undefined, conversationAllow: boolean) {
  const [settings, setSettings] = useState<ConvSettings>(DEFAULT_SETTINGS);
  const metaRef = useRef<unknown>(undefined);
  const ref = useRef(settings);
  ref.current = settings;
  useEffect(() => {
    if (conversationId) setSettings(settingsFromServer(metaRef.current, conversationAllow));
  }, [conversationId, conversationAllow]);
  return {
    settings,
    ref,
    /** 打开一段对话：用它 meta 里的设置 */
    fromMeta(meta: unknown) {
      metaRef.current = meta;
      setSettings(settingsFromServer(meta, false));
    },
    /** 新对话首轮成功：设置已随首轮落盘，沿用本地这份 */
    keepForNew() {
      const cur = ref.current;
      metaRef.current = { model: cur.model, effort: cur.effort, permissionMode: cur.permissionMode === "bypass" ? "bypass" : "ask" };
    },
    reset() {
      metaRef.current = undefined;
      setSettings(DEFAULT_SETTINGS);
    },
    async change(next: ConvSettings) {
      setSettings(next);
      if (!conversationId) return;
      const r = await invoke("agent:settings", { conversation_id: conversationId, ...settingsPayload(next) });
      if (!r.ok) toast(r.error ?? "设置没保存上");
    },
  };
}
