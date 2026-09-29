/**
 * 本机 agent 的 v1 卡片（总编辑接本机 agent spec §v1 卡片）：
 * 稿件结果卡（打开稿件）、任务状态、执行前审批卡、权限卡；其余工具结果是一行脱敏短文字。
 * 字段都来自服务端白名单（chief-editor/redact.ts），这里只渲染。
 */
import { useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import type { Route } from "../App";
import type { AskView } from "./agent-asks";

type CardData = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function BackgroundTag({ data }: { data: CardData }) {
  return data.background ? <span className="muted"> · 后台结果</span> : null;
}

export function AgentDraftCard({ data, nav, background }: { data: CardData; nav?: (r: Route) => void; background?: boolean }) {
  const id = str(data.contentId);
  return (
    <div className="ccard">
      <div className="mono muted card-kicker">稿件 · {str(data.tool)} {str(data.action)}{background ? " · 后台结果" : ""}</div>
      <div className="ccard-title">{str(data.title) || id}</div>
      {str(data.status) && <p className="muted">状态：{str(data.status)}</p>}
      {nav && id && (
        <div className="ccard-actions">
          <button className="ccard-open" onClick={() => nav({ view: "editor", id })}>打开稿件 →</button>
        </div>
      )}
    </div>
  );
}

export function AgentTaskCard({ data }: { data: CardData }) {
  return (
    <div className="ccard">
      <div className="mono muted card-kicker">任务 · {str(data.tool)} {str(data.action)}<BackgroundTag data={data} /></div>
      <p>{str(data.status) || "已受理"}</p>
    </div>
  );
}

export function AgentTextCard({ data }: { data: CardData }) {
  return (
    <p className={data.ok === false ? "run-line err" : "muted run-line"}>
      {str(data.tool)} {str(data.action)}：{str(data.text)}<BackgroundTag data={data} />
    </p>
  );
}

/** 审批卡 / 权限卡：只有「允许一次 / 拒绝」；应答单次消费，别的标签页先点了就提示 */
export function AgentAskCard({ ask }: { ask: AskView }) {
  const [sending, setSending] = useState(false);
  const answer = async (decision: "allow" | "deny" | "allow_conversation") => {
    setSending(true);
    const r = await invoke("agent:answer", { ask_id: ask.id, decision });
    setSending(false);
    if (!r.ok) toast(r.error ?? "处理失败");
  };
  const isApproval = ask.kind === "approval";
  return (
    <div className="ccard">
      <div className="mono muted card-kicker">{isApproval ? "执行前审批" : "权限请求"} · 10 分钟没人处理按拒绝</div>
      <div className="ccard-title">{ask.title}</div>
      <pre className="ccard-body">{ask.detail}</pre>
      <div className="ccard-actions">
        <button className="primary" disabled={sending} onClick={() => void answer("allow")}>{isApproval ? "批准" : "允许一次"}</button>
        {!isApproval && <button disabled={sending} title="这段对话里之后的命令、改文件都不再问（发布、删除仍每次审批）；换对话或重启后恢复每次问" onClick={() => void answer("allow_conversation")}>始终允许（本对话）</button>}
        <button disabled={sending} onClick={() => void answer("deny")}>拒绝</button>
      </div>
    </div>
  );
}
