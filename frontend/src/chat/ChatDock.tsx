/**
 * 总编辑常驻右栏（A 期,可用版）:发消息 → chat:turn;工具进度经 SSE chat 事件实时滚动;
 * 回复带卡片(cards.tsx 精选渲染)。conversation_id 延续同一会话。
 * useChatSend:任意视图把 brief 派进对话(与 vanilla sendChat 同语义)。
 */
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
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
  const [convs, setConvs] = useState<Array<{ id: string; title: string; updatedAt: string }>>([]);

  // 会话延续(D 期前缺口):启动加载最近会话(含卡片回放),历史可切换
  const loadConversation = async (id: string) => {
    const r = await invoke("conversations:get", { id });
    if (!r.ok) return;
    const d = (r as unknown as { data: { messages: Array<{ role: "user" | "assistant"; content: string; cards?: ChatCardShape[] }> } }).data;
    convRef.current = id;
    setMsgs(d.messages.map((m) => ({ role: m.role, text: m.content, cards: m.cards ?? [] })));
  };
  useEffect(() => {
    void invoke("conversations:list").then(async (r) => {
      if (!r.ok) return;
      const list = (r as unknown as { data: { conversations: Array<{ id: string; title: string; updatedAt: string }> } }).data.conversations ?? [];
      setConvs(list);
      if (list.length > 0) await loadConversation(list[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (typeof conv === "string") {
      const isNew = convRef.current !== conv;
      convRef.current = conv;
      if (isNew) {
        void invoke("conversations:list").then((lr) => {
          if (lr.ok) setConvs((lr as unknown as { data: { conversations: typeof convs } }).data.conversations ?? []);
        });
      }
    }
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
      <div className="chat-head mono">
        总编辑
        <span className="chat-head-actions">
          {convs.length > 0 && (
            <select
              value={convRef.current ?? ""}
              onChange={(e) => {
                if (e.target.value) void loadConversation(e.target.value);
              }}
            >
              {convs.map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
            </select>
          )}
          <button
            title="开新会话"
            onClick={() => {
              convRef.current = undefined;
              setMsgs([]);
            }}
          >
            ＋新会话
          </button>
        </span>
      </div>
      <div className="chat-body" ref={bodyRef}>
        {msgs.length === 0 && (
          <p className="muted">
            跟总编辑说话就是派活：「找选题」「校准受众画像」「搜一下 XX」「用《…》写一篇公众号」。
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "msg msg-user" : "msg"}>
            {m.text &&
              (m.role === "user" ? (
                <p>{m.text}</p>
              ) : (
                // 总编辑回复渲染 markdown(与编辑器预览同栈)——裸 ** 不再示人
                <div className="chat-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{m.text}</ReactMarkdown>
                </div>
              ))}
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
