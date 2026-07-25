/**
 * 灵感收件箱(收件箱设计 §4):手机转发进来的链接/文字在这里排队消化,每一步失败可见。
 *
 * 三个可见性约定:
 * 1. 顶部状态条永远说实话——未配置就直接给配对引导(建 bot → 填 token → 转发测试),
 *    工作区丢了就指路重选;绝不用一个空列表冒充「一切正常」。
 * 2. 分组按状态语义拆开(等外部条件 ≠ 失败 ≠ 被拒),每条都带人话原因与可做的动作。
 * 3. 移除只是从视图隐藏——台账是永久的(查重与追溯还靠它),所以给了「已移除」抽屉可恢复。
 */
import { useCallback, useEffect, useState } from "react";
import type { Route } from "../App";
import { invoke, subscribeEvents } from "../transport";
import { toast } from "../ui";
import { PatternCards } from "./PatternCards";

export type InboxStatus = "pending" | "fetching" | "digested" | "failed" | "blocked" | "rejected";

export interface InboxItem {
  id: string;
  url?: string;
  text?: string;
  note?: string;
  source: string;
  receivedAt: string;
  status: InboxStatus;
  verdict?: string;
  targetIds?: string[];
  errorCode?: string;
  failReason?: string;
  attempts: number;
  receiptStatus?: string;
  hiddenAt?: string;
}

interface RuntimeStatus {
  state: "not_configured" | "workspace_missing" | "running" | "stopped";
  targetWorkspaceId?: string;
  dataDir?: string;
  detail?: string;
  poller?: { state: string; lastPollOkAt?: string; lastUpdateId?: number; lastError?: string };
}

const GROUPS: Array<{ key: string; label: string; hint: string; statuses: InboxStatus[] }> = [
  { key: "active", label: "处理中", hint: "排队与正在消化的", statuses: ["pending", "fetching"] },
  { key: "blocked", label: "等外部条件", hint: "缺 key 或引擎——条件补上会自动重试,不计失败次数", statuses: ["blocked"] },
  { key: "failed", label: "失败", hint: "网络/超时类故障,可以重试", statuses: ["failed"] },
  { key: "rejected", label: "已拒绝", hint: "判定为不可用;确实想要就重试或重新消化", statuses: ["rejected"] },
  { key: "digested", label: "已消化", hint: "已落进灵感库或拆解卡", statuses: ["digested"] },
];

const STATE_LABEL: Record<RuntimeStatus["state"], string> = {
  running: "运行中",
  stopped: "已停止",
  not_configured: "未配置",
  workspace_missing: "目标工作区丢了",
};

const POLLER_LABEL: Record<string, string> = {
  polling: "长轮询中",
  stopped: "已停",
  blocked_auth: "token 失效(401)",
  conflict: "同一个 bot 另有消费者(409)",
};

const SOURCE_LABEL: Record<string, string> = { telegram: "TG", extension: "扩展" };

const fmtTime = (iso: string): string => (iso.length >= 16 ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso);

/** 一条 item 的人话标题:链接优先,纯文字笔记取首行 */
function itemTitle(it: InboxItem): string {
  if (it.url) return it.url;
  const text = (it.text ?? "").trim().replace(/\s+/g, " ");
  return text ? (text.length > 80 ? `${text.slice(0, 80)}…` : text) : "(空内容)";
}

/** 落点人话化:pat-* 是拆解卡,其余是灵感库选题 */
function targetLabel(id: string): string {
  return id.startsWith("pat-") ? `拆解卡 ${id}` : `灵感库 ${id}`;
}

function PairingGuide({ nav }: { nav: (r: Route) => void }) {
  return (
    <div className="card inbox-guide">
      <div className="card-title">还没配对 Telegram bot——三步就通</div>
      <ol className="inbox-steps">
        <li>
          在 Telegram 里找 <span className="mono">@BotFather</span>,发 <span className="mono">/newbot</span> 建一个自己的
          bot,它会给你一串 token。
        </li>
        <li>
          把 token 和你自己的 Telegram user id(找 <span className="mono">@userinfobot</span> 要)填进
          <button className="link-btn" onClick={() => nav({ view: "settings" })}>
            设置页 · 灵感收件箱
          </button>
          ,顺便选好消息要落哪个工作区。
        </li>
        <li>给这个 bot 转发一条链接——几秒后它就会出现在下面的列表里,并回你一条「已收到,消化中」。</li>
      </ol>
      <p className="muted">白名单之外的人发消息不会有任何回应,也不会入队(防探测)。</p>
    </div>
  );
}

function RuntimeBar({ st, nav, onRefresh }: { st: RuntimeStatus | null; nav: (r: Route) => void; onRefresh: () => void }) {
  if (!st) return <p className="muted">读取收件箱状态…</p>;
  const poller = st.poller;
  const bad = st.state !== "running" || (poller && poller.state !== "polling");
  return (
    <div className={"inbox-bar" + (bad ? " inbox-bar-bad" : "")}>
      <span className={"chip" + (st.state === "running" ? " chip-pub" : "")}>{STATE_LABEL[st.state]}</span>
      <span className="muted mono">
        {poller ? POLLER_LABEL[poller.state] ?? poller.state : "poller 未启动"}
        {poller?.lastPollOkAt ? ` · 最近成功 ${fmtTime(poller.lastPollOkAt)}` : ""}
        {st.targetWorkspaceId ? ` · 目标工作区 ${st.targetWorkspaceId}` : ""}
      </span>
      {(st.detail || poller?.lastError) && <span className="inbox-bad">{poller?.lastError ?? st.detail}</span>}
      {st.state === "workspace_missing" && (
        <button className="link-btn" onClick={() => nav({ view: "settings" })}>
          去设置页重选工作区
        </button>
      )}
      <button style={{ marginLeft: "auto" }} onClick={onRefresh}>
        刷新
      </button>
    </div>
  );
}

function ItemRow(props: {
  it: InboxItem;
  nav: (r: Route) => void;
  act: (channel: string, payload: Record<string, unknown>, done: string) => void;
  openTarget: (targetId: string) => void;
}) {
  const { it, nav, act, openTarget } = props;
  const canRetry = it.status === "failed" || it.status === "rejected";
  const canReingest = it.status === "digested" || it.status === "rejected";
  return (
    <div className="inbox-item">
      <div className="inbox-item-head">
        <span className="mono pri">{SOURCE_LABEL[it.source] ?? it.source}</span>
        <span className="muted mono">{fmtTime(it.receivedAt)}</span>
        <span className="inbox-item-title" title={itemTitle(it)}>
          {itemTitle(it)}
        </span>
        <span className="row-actions">
          {canRetry && <button onClick={() => act("inbox:retry", { id: it.id }, "已排队重试")}>重试</button>}
          {canReingest && <button onClick={() => act("inbox:reingest", { id: it.id }, "已排队重新消化")}>重新消化</button>}
          {it.hiddenAt ? (
            <button onClick={() => act("inbox:delete", { id: it.id, restore: true }, "已恢复")}>恢复</button>
          ) : (
            <button onClick={() => act("inbox:delete", { id: it.id }, "已移除——在「已移除」里可恢复")}>移除</button>
          )}
        </span>
      </div>
      {it.note && <p className="muted inbox-note">备注:{it.note}</p>}
      {it.failReason && (
        <p className="inbox-bad">
          {it.failReason}
          {it.errorCode ? <span className="muted mono"> · {it.errorCode}</span> : null}
          {it.status === "failed" && it.attempts > 0 ? <span className="muted mono"> · 已试 {it.attempts} 次</span> : null}
        </p>
      )}
      {it.status === "blocked" && (
        <button className="link-btn" onClick={() => nav({ view: "settings" })}>
          去设置页补上缺的配置 →
        </button>
      )}
      {it.status === "digested" && (
        <p className="muted">
          落点:
          {(it.targetIds ?? []).length === 0
            ? "无(判定为不入库)"
            : (it.targetIds ?? []).map((tid) => (
                <button key={tid} className="link-btn" onClick={() => openTarget(tid)}>
                  {targetLabel(tid)}
                </button>
              ))}
          {it.verdict ? <span className="mono"> · 判定 {it.verdict}</span> : null}
        </p>
      )}
      {it.receiptStatus === "failed" && <p className="muted mono">回执没发出去(消化结果不受影响)</p>}
    </div>
  );
}

export function Inbox({ nav }: { nav: (r: Route) => void }) {
  const [tab, setTab] = useState<"items" | "patterns">("items");
  const [st, setSt] = useState<RuntimeStatus | null>(null);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [showHidden, setShowHidden] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [lr, sr] = await Promise.all([invoke("inbox:list", { include_hidden: true }), invoke("inbox:status")]);
    if (!lr.ok) return setErr(lr.error ?? "收件箱读取失败");
    setErr(null);
    const d = (lr as unknown as { data: { items: InboxItem[]; hidden: number } }).data;
    setItems(d.items);
    setHiddenCount(d.hidden);
    if (sr.ok) setSt((sr as unknown as { data: RuntimeStatus }).data);
  }, []);

  useEffect(() => {
    void load();
    // worker 每次写完台账推一条 inbox:updated —— 刷新整表比按 id 打补丁更不容易说谎
    return subscribeEvents((e) => {
      if (e.kind === "inbox") void load();
    });
  }, [load]);

  const act = (channel: string, payload: Record<string, unknown>, done: string) => {
    void invoke(channel, payload).then((r) => {
      if (!r.ok) return toast(r.error ?? "操作失败");
      const note = ((r as unknown as { data?: { note?: string } }).data ?? {}).note;
      toast(note ?? done);
      void load();
    });
  };

  /** 落点点进去要真到得了:拆解卡切本视图第二个 tab,选题去看板的灵感库列 */
  const openTarget = (targetId: string) => (targetId.startsWith("pat-") ? setTab("patterns") : nav({ view: "board" }));

  const visible = items.filter((it) => !it.hiddenAt);
  const hidden = items.filter((it) => it.hiddenAt);

  return (
    <div className="inbox">
      <div className="board-bar">
        <span className="board-title serif">灵感收件箱</span>
        <button className={tab === "items" ? "nav-on" : ""} onClick={() => setTab("items")}>
          收件箱({visible.length})
        </button>
        <button className={tab === "patterns" ? "nav-on" : ""} onClick={() => setTab("patterns")}>
          拆解卡
        </button>
      </div>

      {tab === "patterns" ? (
        <PatternCards />
      ) : (
        <>
          <RuntimeBar st={st} nav={nav} onRefresh={() => void load()} />
          {err && <p className="inbox-bad">{err}</p>}
          {st?.state === "not_configured" && <PairingGuide nav={nav} />}

          {GROUPS.map((g) => {
            const rows = visible.filter((it) => g.statuses.includes(it.status));
            if (rows.length === 0) return null;
            return (
              <div key={g.key} className="card inbox-group">
                <div className="card-head">
                  <span className="card-title">
                    {g.label}({rows.length})
                  </span>
                  <span className="muted mono">{g.hint}</span>
                </div>
                {rows.map((it) => (
                  <ItemRow key={it.id} it={it} nav={nav} act={act} openTarget={openTarget} />
                ))}
              </div>
            );
          })}

          {visible.length === 0 && st?.state !== "not_configured" && (
            <p className="muted">
              还没收到任何转发——在 Telegram 里给你的 bot 发一条链接试试,几秒后它会出现在这里。
            </p>
          )}

          {hiddenCount > 0 && (
            <div className="inbox-hidden">
              <button className="link-btn" onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? "收起" : `已移除 ${hiddenCount} 条(台账仍在,可恢复)`}
              </button>
              {showHidden &&
                hidden.map((it) => <ItemRow key={it.id} it={it} nav={nav} act={act} openTarget={openTarget} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
