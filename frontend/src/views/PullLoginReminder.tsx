/**
 * 看板上的「数据回流要重新登录」提醒（首页改版 spec §0 #7）：只列开着自动回流、上次判定登录失效的平台。
 * 入口跟设置 → 数据里的回流面板同一套：先在 ego lite 里登录后台，再点「登录好了，重抓」走 flywheel:pull_now。
 * 回流状态读不了（null）照实说，不当成都好着。
 */
import { useState } from "react";
import { invoke } from "../transport";
import { toast } from "../ui";
import type { PullLoginTodo } from "./board-columns";
import { attemptMessage, type PullAttemptView } from "../pull-lib";

export function pullLoginLine(t: PullLoginTodo): string {
  const since = t.lastSuccessAt ? `，上次成功 ${t.lastSuccessAt.slice(0, 10)}` : "";
  return `${t.label}数据回流要重新登录：${t.action}（${t.consoleUrl}）${since}`;
}

/** 重抓结果照实说（同设置页回流面板的 attemptMessage）：风控 / 浏览器没连 / 超时 / 还没登录各有各的下一步 */
export function retryMessage(label: string, r: { ok: boolean; error?: string; data?: unknown }): string {
  if (!r.ok) return r.error ?? `${label}抓取失败`;
  return attemptMessage(label, r.data as PullAttemptView);
}

export function PullLoginReminder({ todos, reload }: { todos: PullLoginTodo[] | null | undefined; reload: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (todos === undefined || (todos !== null && todos.length === 0)) return null;
  if (todos === null) return <div className="pref-banner" role="status"><span className="muted">数据回流状态读不了，判断不了平台登录有没有失效：去「设置 → 数据」看一下</span></div>;
  const retry = async (t: PullLoginTodo) => {
    setBusy(t.platform);
    const r = await invoke("flywheel:pull_now", { platform: t.platform });
    setBusy(null);
    reload();
    toast(retryMessage(t.label, r));
  };
  return <div className="pref-banner" role="status">
    {todos.map((t) => <div key={t.platform} className="pref-banner-row">
      <span>{pullLoginLine(t)}</span>
      <button className="primary" disabled={busy === t.platform} onClick={() => void retry(t)}>{busy === t.platform ? "抓取中…" : "登录好了，重抓"}</button>
      <a className="button" href="#/settings?tab=data">去设置看回流</a>
    </div>)}
  </div>;
}
