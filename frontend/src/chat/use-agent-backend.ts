/**
 * 总编辑右栏的「后端」状态（总编辑接本机 agent spec）：就绪清单、新对话默认后端、
 * 后台 agent 在跑哪个库、当前对话的待处理审批/权限卡（SSE + 重连重放）。
 * 判定都在 backend-choice.ts / agent-asks.ts 的纯函数里，这里只接线。
 */
import { useEffect, useRef, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { applyAgentEvent, mergeCards, parsePending, type AskView, type LiveCard, type RunningTurn } from "./agent-asks";
import { defaultBackend, parseBackends, rememberBackend, type BackendId, type BackendStatus, type RunningAgent } from "./backend-choice";

export interface AgentBackendState {
  backends: BackendStatus[];
  error: string;
  running: RunningAgent | null;
  /** 新对话用哪个后端（localStorage 只作这里的默认值） */
  newBackend: BackendId;
  setNewBackend: (id: BackendId) => void;
  asks: AskView[];
  /** 进行中这一轮已入账的卡片（SSE 实时 + 刷新快照，按 callId 合并）；轮次结束后以对话落盘为准 */
  liveCards: LiveCard[];
  /** 重拉就绪清单与待处理卡（挂载、换对话、重连、一轮结束时）。running.owner = 本标签页发起的 */
  refresh: () => Promise<{ running: RunningTurn | null }>;
}

export function useAgentBackend(
  conversationId: string | undefined,
  opts: { clientId: string; onBackground?: (conversationId: string) => void },
): AgentBackendState {
  const [backends, setBackends] = useState<BackendStatus[]>([]);
  const [error, setError] = useState("");
  const [running, setRunning] = useState<RunningAgent | null>(null);
  const [newBackend, setNew] = useState<BackendId>("builtin");
  const [asks, setAsks] = useState<AskView[]>([]);
  const [liveCards, setLiveCards] = useState<LiveCard[]>([]);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const seeded = useRef(false);
  const convRef = useRef(conversationId);
  convRef.current = conversationId;

  const refresh = async () => {
    const [b, p] = await Promise.all([invoke("agent:backends"), invoke("agent:pending", { client_id: optsRef.current.clientId, ...(convRef.current ? { conversation_id: convRef.current } : {}) })]);
    if (b.ok) {
      const parsed = parseBackends(b);
      setBackends(parsed.backends);
      setRunning(parsed.running);
      if (!seeded.current && parsed.backends.length) {
        seeded.current = true;
        setNew(defaultBackend(parsed.backends));
      }
      setError("");
    } else {
      setError(b.error ?? "后端清单读取失败");
    }
    const pending = p.ok ? parsePending(p) : { asks: [], running: null };
    setAsks(pending.asks);
    setLiveCards(pending.running?.cards ?? []);
    return { running: pending.running };
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(
    () =>
      subscribeEvents((e) => {
        if (e.kind === "reconnect") { void refresh(); return; }
        if (e.kind !== "agent") return;
        setAsks((list) => applyAgentEvent(list, e.data, convRef.current));
        const conv = typeof e.data.conversationId === "string" ? e.data.conversationId : "";
        const mine = !convRef.current || conv === convRef.current;
        if (e.data.type === "card" && mine) setLiveCards((list) => mergeCards(list, [e.data.card]));
        if (e.data.type === "background" && conv) optsRef.current.onBackground?.(conv);
        if (e.data.type === "turn" && e.data.status !== "running" && e.data.status !== "awaiting_approval" && mine) setLiveCards([]);
        if (e.data.type === "turn") void invoke("agent:backends").then((b) => { if (b.ok) setRunning(parseBackends(b).running); });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return {
    backends,
    error,
    running,
    newBackend,
    setNewBackend: (id) => { setNew(id); rememberBackend(id); },
    asks,
    liveCards,
    refresh,
  };
}
