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
import { buildTurnContext, type ViewSnapshot } from "./view-context";
import type { Route } from "../App";
import { parseChatTurnResponse } from "./response";
import {
  decideRecovery,
  readPendingTurn,
  writePendingTurn,
  clearPendingTurn,
  randomId,
  type TurnStatusView,
} from "./turn-recovery";
import { EMPTY_STREAM, applyDelta, clearStream, parseDeltaFrame, startStream } from "./delta-stream";
import {
  DEFAULT_CHAT_MODEL,
  groupModelOptions,
  modelOptionLabel,
  parseModelOptions,
  readModelChoice,
  writeModelChoice,
  type ChatModelOption,
} from "./model-choice";
import { useRevisionFocus, getFocus, setProposal, clearFocus } from "../revision";

interface Msg {
  role: "user" | "assistant";
  text: string;
  cards?: ChatCardShape[];
  /** 气泡下面的一行灰字（中止提示等），不进模型上下文 */
  note?: string;
}

/**
 * 每标签页一个 clientId（模块级随机，会话期驻内存）——turn 归属的命名空间：
 * 别的标签页拿到 turnId 也停不了本页的轮（对话控制面设计 §Phase 3）。
 */
const CLIENT_ID = randomId();

/** 中止 ≠ 取消：已投递的后台任务（封面、配图、深调研、成片）继续跑，文案不许暗示它们停了 */
const ABORT_NOTE = "已停。已投递的后台任务会继续跑，进度看对应卡片。";

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

export function ChatDock(props: {
  contentContext?: { contentId: string };
  /** 用户正看着哪（壳给的路由/选中态）——随本轮 chat:turn 上报 */
  view?: ViewSnapshot;
  /** 卡片「在工作区打开」的落点（壳的 setRoute） */
  nav?: (route: Route) => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  // view 每次 App 渲染都是新对象:用 ref 拿最新值，别把它塞进 sendImpl 的依赖里反复重注册
  const viewRef = useRef(props.view);
  viewRef.current = props.view;
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  /** 已发出 chat:abort、等本轮 invoke 返回才解锁（服务端注册表也 busy 到 settle） */
  const [stopping, setStopping] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState("");
  const turnIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [progress, setProgress] = useState<string[]>([]);
  /** 流式正文（SSE chat_delta）：只是「正在生成的样子」，invoke 返回后一律被响应全量覆盖 */
  const [stream, setStream] = useState(EMPTY_STREAM);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | undefined>();
  const [contextTitle, setContextTitle] = useState("");
  /** 可选模型档位（服务端给的真实清单）与当前选择；只有 >1 档时才显示切换器 */
  const [modelOptions, setModelOptions] = useState<ChatModelOption[]>([]);
  const [modelChoice, setModelChoice] = useState<string>(DEFAULT_CHAT_MODEL);
  // sendImpl 的闭包不随 modelChoice 重注册——用 ref 读最新值（与 viewRef 同一手法）
  const modelChoiceRef = useRef(modelChoice);
  modelChoiceRef.current = modelChoice;
  const focus = useRevisionFocus();

  useEffect(() => {
    void invoke("chat:model_options").then((r) => {
      if (!r.ok) return; // 拉不到就当没有可切的（切换器隐藏），对话照常走缺省档
      const options = parseModelOptions(r);
      setModelOptions(options);
      setModelChoice(readModelChoice(options));
    });
  }, []);

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
        .map((m) => ({ role: m.role, text: m.content, cards: (m.cards ?? []).filter((c) => c.type !== "revision_proposal") }))
        .filter((m) => m.text.trim() || (m.cards?.length ?? 0) > 0),
    );
  };
  /**
   * 断线恢复（设计 §Phase 3）：挂载/SSE 重连时先重载会话，再看本地有没有记着一轮没收尾的 turn。
   * 三态各有明确出口，绝不假装「还在跑」——服务端重启后 turn_status 就是 unknown。
   */
  const recoverPendingTurn = async () => {
    // turnIdRef 有值 = 本标签页正跑着一轮，那一轮由 invoke 返回收尾，不归恢复管
    const pending = readPendingTurn();
    if (!pending || turnIdRef.current) return;
    const r = await invoke("chat:turn_status", { turn_id: pending.turnId });
    if (!r.ok) return; // 查不动就保留 pending，下次重连再查
    const view = ((r as unknown as { data?: TurnStatusView }).data ?? { status: "unknown" }) as TurnStatusView;
    const decision = decideRecovery(pending, view);
    if (pollRef.current) clearTimeout(pollRef.current);
    if (decision.action === "reload") {
      clearPendingTurn();
      setRecoveryNotice("");
      if (decision.conversationId) await loadConversation(decision.conversationId);
      void listConversations().then(setConvs);
      return;
    }
    if (decision.action === "lost") clearPendingTurn();
    else {
      // 还在跑：本页不是发起方，拿不到 invoke 返回——只能轮询到它收尾，
      // 否则「上一轮还在跑」会一直挂在那里，用户永远等不到结果
      pollRef.current = setTimeout(() => void recoverPendingTurn(), 3000);
    }
    setRecoveryNotice(decision.notice);
  };

  useEffect(() => () => {
    if (pollRef.current) clearTimeout(pollRef.current);
  }, []);

  useEffect(() => {
    void listConversations().then(async (list) => {
      setConvs(list);
      if (list.length > 0) await loadConversation(list[0].id);
      await recoverPendingTurn();
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
    setStopping(false);
    setRecoveryNotice("");
    if (pollRef.current) clearTimeout(pollRef.current); // 新一轮接管，恢复轮询让位
    setProgress([]);
    // turnId 客户端生成:中止靠它寻址,断线后也靠它认领本轮结果
    const turnId = randomId();
    turnIdRef.current = turnId;
    setStream(startStream(turnId)); // 本轮之后到达的 chat_delta 才收，别的 turn 一律丢弃
    writePendingTurn({ turnId, ...(activeConversationId ? { conversationId: activeConversationId } : {}) });
    // 视图上下文（设计 §Phase 3）:稿件/修改焦点 + 用户正看着哪一页——服务端还会过一道白名单
    const focusNow = getFocus();
    const ctx = buildTurnContext({
      ...(viewRef.current ? { view: viewRef.current } : {}),
      ...(props.contentContext ? { contentId: props.contentContext.contentId } : {}),
      ...(focusNow ? { focus: focusNow } : {}),
    });
    // 缺省档不带 model_choice：默认路径的 payload 与切换器上线前逐字一致
    const choice = modelChoiceRef.current;
    const r = await invoke("chat:turn", {
      message,
      turn_id: turnId,
      client_id: CLIENT_ID,
      ...(activeConversationId ? { conversation_id: activeConversationId } : {}),
      ...(ctx ? { context: ctx } : {}),
      ...(choice && choice !== DEFAULT_CHAT_MODEL ? { model_choice: choice } : {}),
    });
    // invoke 返回 = 本轮真的 settle 了（服务端注册表同刻解锁）——停止按钮与输入框在这里一起解锁
    setBusy(false);
    setStopping(false);
    turnIdRef.current = null;
    clearPendingTurn();
    setProgress([]);
    // 事实源规则：响应到达 = 流式气泡下岗，回复以下面 setMsgs 的完整内容为准（全量覆盖）
    setStream(clearStream());
    if (!r.ok) {
      setMsgs((m) => [...m, { role: "assistant", text: "出错了：" + (r.error ?? "未知错误") }]);
      return { ok: false, error: r.error ?? "未知错误" };
    }
    const parsed = parseChatTurnResponse(r);
    if (parsed.conversationId) {
      setActiveConversationId(parsed.conversationId);
    }
    const proposalCard = parsed.cards.find((c) => c.type === "revision_proposal");
    if (proposalCard) {
      const pd = proposalCard.data as unknown as {
        contentId: string;
        scope: "selection" | "draft";
        feedback?: string;
        title?: string;
        body?: string;
        span?: string;
      };
      const f = getFocus();
      setProposal({
        contentId: pd.contentId,
        scope: pd.scope,
        ...(pd.feedback ? { feedback: pd.feedback } : {}),
        ...(pd.title !== undefined ? { title: pd.title } : {}),
        ...(pd.body !== undefined ? { body: pd.body } : {}),
        ...(pd.span !== undefined ? { span: pd.span } : {}),
        ...(f?.selection ? { selection: f.selection } : {}),
      });
    }
    // 总编辑自己退出了修改模式（clear_revision_focus）——store 跟着退，否则焦点会一直劫持后续对话
    if (parsed.cards.some((c) => c.type === "focus_cleared")) clearFocus();
    const visibleCards = parsed.cards.filter((c) => c.type !== "revision_proposal");
    setMsgs((m) => [
      ...m,
      {
        role: "assistant",
        text: parsed.reply,
        cards: visibleCards,
        ...(parsed.stopReason === "aborted" ? { note: ABORT_NOTE } : {}),
      },
    ]);
    void listConversations().then(setConvs);
    return { ok: true, ...(parsed.actionId ? { actionId: parsed.actionId } : {}) };
  };

  /** 停止：只停对话编排，不取消已投递的后台任务。以本轮 invoke 返回解锁。 */
  const stopTurn = async () => {
    const turnId = turnIdRef.current;
    if (!turnId || stopping) return;
    setStopping(true);
    const r = await invoke("chat:abort", { turn_id: turnId, client_id: CLIENT_ID });
    // 已经停完/没找到都是幂等成功；真失败（如归属不符）要说出来，并把按钮放回去
    if (!r.ok) {
      setStopping(false);
      toast(r.error ?? "停止失败");
    }
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
  // reconnect 是断线重连的合成事件:断线那几秒的结果不会补发,按恢复契约查一次 turn_status
  useEffect(
    () =>
      subscribeEvents((e) => {
        if (e.kind === "reconnect") {
          void recoverPendingTurn();
          return;
        }
        // 正文增量：turnId 过滤与 seq 去重都在 delta-stream 里判（本页只管渲染）
        if (e.kind === "chat_delta") {
          const frame = parseDeltaFrame(e.data);
          if (frame) setStream((s) => applyDelta(s, frame));
          return;
        }
        if (e.kind !== "chat") return;
        const label = typeof e.data.label === "string" ? e.data.label : "";
        const phase = e.data.phase;
        if (phase === "start" && label) setProgress((p) => [...p.slice(-2), label]);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [msgs, progress, stream.text]);

  // 四档置顶 + 自定义端点按端点名 optgroup（清单本身低频变化，随渲染算即可）
  const modelGroups = groupModelOptions(modelOptions);

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
      {focus ? (
        <div className="chat-context revision-focus" title={focus.contentId}>
          <span>正在改：{focus.scope === "selection" ? "选中这段" : "整篇"} · 说怎么改,不清楚我会反问,改完在编辑器收下</span>
          <button className="focus-x" title="退出修改" onClick={() => clearFocus()}>×</button>
        </div>
      ) : (
        props.contentContext && (
          <div className="chat-context" title={props.contentContext.contentId}>
            当前稿件：{contextTitle || "正在读取…"} · 修改建议会保存为新版本
          </div>
        )
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
              <ChatCard key={j} card={c} {...(props.nav ? { nav: props.nav } : {})} />
            ))}
            {m.note && <p className="muted">{m.note}</p>}
          </div>
        ))}
        {recoveryNotice && <p className="muted run-line">{recoveryNotice}</p>}
        {/* 流式气泡：视觉与最终回复一致（同一套 markdown 渲染），不做打字机动画 */}
        {busy && stream.text && (
          <div className="msg">
            <div className="chat-md">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{stream.text}</ReactMarkdown>
            </div>
          </div>
        )}
        {busy && (
          <div className="msg">
            {stopping ? (
              <p className="muted">正在停…（已投递的后台任务会继续跑）</p>
            ) : stream.done ? (
              <p className="muted">整理回复中…</p>
            ) : progress.length === 0 ? (
              <p className="muted">{stream.text ? "总编辑正在说…" : "总编辑在想…"}</p>
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
      <div className="chat-compose">
        {/* 只有一档（或引擎没配）时不出现——没得选就不该占一行 */}
        {modelOptions.length > 1 && (
          <div className="chat-model-row mono">
            <span className="muted">模型</span>
            <select
              aria-label="切换模型"
              title="这一轮对话用哪个模型（只影响总编辑对话，不改写稿/调研的模型）"
              value={modelChoice}
              disabled={busy}
              onChange={(e) => {
                setModelChoice(e.target.value);
                writeModelChoice(e.target.value);
              }}
            >
              {modelGroups.plain.map((o) => (
                <option key={o.id} value={o.id}>{modelOptionLabel(o)}</option>
              ))}
              {modelGroups.groups.map((g) => (
                <optgroup key={g.name} label={g.name}>
                  {g.options.map((o) => (
                    <option key={o.id} value={o.id}>{modelOptionLabel(o)}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        )}
        <div className="chat-input-row">
          <textarea
            value={input}
            rows={2}
            placeholder={props.contentContext
              ? "说修改要求，如：开头更直接，删掉第三段（Enter 发送）"
              : "跟总编辑说…修改某篇稿前请先在看板打开它"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // 输入法合成中(拼音未上屏)时回车只上屏候选,不发送——isComposing 拦住。
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(input);
              }
            }}
          />
          {busy ? (
            <button
              title="停止这一轮（已投递的后台任务会继续跑）"
              disabled={stopping || !turnIdRef.current}
              onClick={() => void stopTurn()}
            >
              {stopping ? "正在停…" : "停止"}
            </button>
          ) : (
            <button className="primary" onClick={() => void send(input)}>
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
