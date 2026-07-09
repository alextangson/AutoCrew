/**
 * 总编辑常驻右栏（A 期,可用版）:发消息 → chat:turn;工具进度经 SSE chat 事件实时滚动;
 * 回复带卡片(cards.tsx 精选渲染)。conversation_id 延续同一会话。
 * useChatSend:任意视图把 brief 派进对话(与 vanilla sendChat 同语义)。
 */
import { useEffect, useRef, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { ChatCard, type ChatCardShape } from "./cards";

interface Msg {
  role: "user" | "assistant";
  text: string;
  cards?: ChatCardShape[];
}

let sendImpl: (msg: string) => void = () => {
  /* dock 未挂载时丢弃并提示 */
};

/** 视图层拿到"派活进对话"的入口(dock 挂载后生效) */
export function useChatSend(): (msg: string) => void {
  return (msg) => sendImpl(msg);
}

export function ChatDock() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const convRef = useRef<string | undefined>(undefined);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setMsgs((m) => [...m, { role: "user", text: message }]);
    setInput("");
    setBusy(true);
    setProgress([]);
    const r = await invoke("chat:turn", {
      message,
      ...(convRef.current ? { conversation_id: convRef.current } : {}),
    });
    setBusy(false);
    setProgress([]);
    if (!r.ok) {
      setMsgs((m) => [...m, { role: "assistant", text: "出错了：" + (r.error ?? "未知错误") }]);
      return;
    }
    const conv = r.conversation_id ?? (r as { data?: { conversation_id?: string } }).data?.conversation_id;
    if (typeof conv === "string") convRef.current = conv;
    const reply = typeof r.reply === "string" ? r.reply : "";
    const cards = Array.isArray(r.cards) ? (r.cards as ChatCardShape[]) : [];
    setMsgs((m) => [...m, { role: "assistant", text: reply, cards }]);
  };

  useEffect(() => {
    sendImpl = (msg) => void send(msg);
    return () => {
      sendImpl = () => {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // 工具进度(chat SSE):in-flight 时滚动展示「侦察员正在扫热榜…」
  useEffect(
    () =>
      subscribeEvents((e) => {
        if (e.kind !== "chat") return;
        const label = typeof e.data.label === "string" ? e.data.label : "";
        const phase = e.data.phase;
        if (phase === "start" && label) setProgress((p) => [...p.slice(-2), label]);
      }),
    [],
  );

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [msgs, progress]);

  return (
    <div className="chat">
      <div className="chat-head mono">总编辑</div>
      <div className="chat-body" ref={bodyRef}>
        {msgs.length === 0 && (
          <p className="muted">
            跟总编辑说话就是派活：「找选题」「校准受众画像」「搜一下 XX」「用《…》写一篇公众号」。
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "msg msg-user" : "msg"}>
            {m.text && <p>{m.text}</p>}
            {(m.cards ?? []).map((c, j) => (
              <ChatCard key={j} card={c} />
            ))}
          </div>
        ))}
        {busy && (
          <div className="msg">
            {progress.length === 0 ? (
              <p className="muted">总编辑在想…</p>
            ) : (
              progress.map((p, i) => (
                <p key={i} className="muted run-line">
                  … {p}
                </p>
              ))
            )}
          </div>
        )}
      </div>
      <div className="chat-input-row">
        <textarea
          value={input}
          rows={2}
          placeholder="跟总编辑说…(Enter 发送,Shift+Enter 换行)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <button className="primary" disabled={busy} onClick={() => void send(input)}>
          发送
        </button>
      </div>
    </div>
  );
}
