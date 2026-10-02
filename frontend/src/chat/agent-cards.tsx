/**
 * 旧对话里的本机 agent 卡片（2026-10-02 前用本机 Claude / Codex 聊过的对话）：
 * 稿件结果卡（打开稿件）、任务状态、一行短文字。本机后端已删，这里只为让旧对话照常显示。
 */
import type { Route } from "../App";

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
