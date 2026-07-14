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
import { confirmDialog, toast } from "../ui";
import { ChatCard, type ChatCardShape } from "./cards";
import { parseChatTurnResponse } from "./response";

interface Msg {
  role: "user" | "assistant";
  text: string;
  cards?: ChatCardShape[];
}

interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export interface ChatDispatchReceipt {
  ok: boolean;
  actionId?: string;
  error?: string;
}

let sendImpl: (msg: string) => Promise<ChatDispatchReceipt> = async () => ({
  ok: false,
  error: "总编辑还没准备好，请刷新页面后重试",
});

/** 视图层拿到"派活进对话"的入口(dock 挂载后生效) */
export function useChatSend(): (msg: string) => Promise<ChatDispatchReceipt> {
  return (msg) => sendImpl(msg);
}

export function ChatDock(props: { contentContext?: { contentId: string } }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>();
  const [contextTitle, setContextTitle] = useState("");

  useEffect(() => {
    const id = props.contentContext?.contentId;
    if (!id) {
      setContextTitle("");
      return;
    }
    let active = true;
    void invoke("content:get", { id }).then((result) => {
      if (!active) return;
      const content = (result as unknown as { content?: { title?: string } }).content;
      setContextTitle(result.ok ? (content?.title ?? id) : id);
    });
    return () => { active = false; };
  }, [props.contentContext?.contentId]);

  const listConversations = async (): Promise<ConversationSummary[]> => {
    const r = await invoke("conversations:list");
    if (!r.ok) return [];
    return (r as unknown as { data: { conversations: ConversationSummary[] } }).data.conversations ?? [];
  };

  // 会话延续(D 期前缺口):启动加载最近会话(含卡片回放),历史可切换
  const loadConversation = async (id: string) => {
    const r = await invoke("conversations:get", { id });
    if (!r.ok) return;
    const d = (r as unknown as { data: { messages: Array<{ role: "user" | "assistant"; content: string; cards?: ChatCardShape[] }> } }).data;
    setActiveConversationId(id);
    setMsgs(
      d.messages
        .map((m) => ({ role: m.role, text: m.content, cards: m.cards ?? [] }))
        .filter((m) => m.text.trim() || (m.cards?.length ?? 0) > 0),
    );
  };
  useEffect(() => {
    void listConversations().then(async (list) => {
      setConvs(list);
      if (list.length > 0) await loadConversation(list[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async (text: string): Promise<ChatDispatchReceipt> => {
    const message = text.trim();
    if (!message) return { ok: false, error: "消息不能为空" };
    if (busy) return { ok: false, error: "总编辑正在处理上一项任务，请等它受理后再派" };
    setMsgs((m) => [...m, { role: "user", text: message }]);
    setInput("");
    setBusy(true);
    setProgress([]);
    const r = await invoke("chat:turn", {
      message,
      ...(activeConversationId ? { conversation_id: activeConversationId } : {}),
      ...(props.contentContext ? { context: { content_id: props.contentContext.contentId } } : {}),
    });
    setBusy(false);
    setProgress([]);
    if (!r.ok) {
      setMsgs((m) => [...m, { role: "assistant", text: "出错了：" + (r.error ?? "未知错误") }]);
      return { ok: false, error: r.error ?? "未知错误" };
    }
    const parsed = parseChatTurnResponse(r);
    if (parsed.conversationId) {
      setActiveConversationId(parsed.conversationId);
    }
    setMsgs((m) => [...m, { role: "assistant", text: parsed.reply, cards: parsed.cards }]);
    void listConversations().then(setConvs);
    return { ok: true, ...(parsed.actionId ? { actionId: parsed.actionId } : {}) };
  };

  const deleteActiveConversation = async () => {
    if (!activeConversationId || busy) return;
    const current = convs.find((c) => c.id === activeConversationId);
    const yes = await confirmDialog({
      title: "删除这段会话？",
      body: `“${current?.title ?? "当前会话"}”的聊天记录会从本机删除，稿件和选题不会受影响。`,
      confirmLabel: "删除会话",
      danger: true,
    });
    if (!yes) return;
    const r = await invoke("conversations:delete", { id: activeConversationId });
    if (!r.ok) return toast(r.error ?? "删除失败");
    const list = await listConversations();
    setConvs(list);
    if (list.length > 0) await loadConversation(list[0].id);
    else {
      setActiveConversationId(undefined);
      setMsgs([]);
    }
    toast("会话已删除；稿件和选题仍保留");
  };

  useEffect(() => {
    sendImpl = (msg) => send(msg);
    return () => {
      sendImpl = async () => ({ ok: false, error: "总编辑当前不可用" });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, activeConversationId, props.contentContext?.contentId]);

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
              aria-label="切换会话"
              value={activeConversationId ?? ""}
              disabled={busy}
              onChange={(e) => {
                if (e.target.value) void loadConversation(e.target.value);
              }}
            >
              {!activeConversationId && <option value="">新会话（尚未保存）</option>}
              {convs.map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
            </select>
          )}
          {activeConversationId && (
            <button title="删除当前会话" disabled={busy} onClick={() => void deleteActiveConversation()}>
              删除
            </button>
          )}
          <button
            title="开新会话"
            disabled={busy}
            onClick={() => {
              setActiveConversationId(undefined);
              setMsgs([]);
            }}
          >
            ＋新会话
          </button>
        </span>
      </div>
      {props.contentContext && (
        <div className="chat-context" title={props.contentContext.contentId}>
          当前稿件：{contextTitle || "正在读取…"} · 修改建议会保存为新版本
        </div>
      )}
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
          placeholder={props.contentContext
            ? "说修改要求，如：开头更直接，删掉第三段（Enter 发送）"
            : "跟总编辑说…修改某篇稿前请先在看板打开它"}
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
