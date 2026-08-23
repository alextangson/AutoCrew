/**
 * 自动回流状态区（回流 spec §4.4）——三平台一行：开关 / 状态徽标 / 最近成功 / 上次入账行数 /
 * 立即抓取。刷新走 SSE：调度每次抓完发 `metrics_pull` 引擎事件，这里收到就重拉状态。
 *
 * 两条纪律：
 * 1. 状态读不出来 → 说「不可用」，绝不显示成「三平台都没抓过」；
 * 2. 浏览器连不上 → 一条合并提示 + 启动指引，不逐平台重复报错。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { toast } from "../ui";
import {
  attemptMessage,
  browserUnreachable,
  formatPullTime,
  pullBadge,
  pullHint,
  type PullAttemptView,
  type PullPlatformStatus,
} from "../pull-lib";

const TONE_CLASS: Record<string, string> = { ok: "", warn: "pull-warn", bad: "pull-bad", idle: "muted" };

function PullRow(props: {
  row: PullPlatformStatus;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onPull: () => void;
}) {
  const { row, busy } = props;
  const badge = pullBadge(row);
  const hint = pullHint(row);
  return (
    <div>
      <div className="row" style={{ cursor: "default" }}>
        <input
          type="checkbox"
          checked={row.enabled}
          title="开启后每 12 小时自动抓一次"
          onChange={(e) => props.onToggle(e.target.checked)}
        />
        <span className={`mono pri ${TONE_CLASS[badge.tone]}`}>{badge.text}</span>
        <span className="row-title">{row.label}</span>
        <span className="muted mono">最近成功 {formatPullTime(row.lastSuccessAt)}</span>
        <span className="muted mono">上次入账 {row.lastRowCount ?? 0} 行</span>
        <button className="chip" disabled={busy || row.inFlight} onClick={props.onPull}>
          {busy || row.inFlight ? "抓取中…" : "立即抓取"}
        </button>
      </div>
      {hint && (
        <p className="muted pull-note">
          {hint}{" "}
          {row.lastStatus === "needs_login" && (
            <a href={row.consoleUrl} target="_blank" rel="noreferrer">
              去{row.label}后台扫码 ↗
            </a>
          )}
        </p>
      )}
      {row.platform === "wechat_video" && row.enabled && (
        // 如实告知,不承诺也不隐瞒(spec §4.4):视频号登录态短是社区经验,不是我们的承诺
        <p className="muted pull-note">视频号登录态较短，可能需要每天扫码。</p>
      )}
    </div>
  );
}

export function PullStatusPanel({ onImported }: { onImported: () => void }) {
  const [rows, setRows] = useState<PullPlatformStatus[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    void invoke("flywheel:pull_status").then((r) => {
      if (!r.ok) {
        setErr(r.error ?? "回流状态读取失败");
        setRows(null);
        return;
      }
      setErr(null);
      setRows((r as unknown as { data: { platforms: PullPlatformStatus[] } }).data.platforms);
    });
  }, []);

  useEffect(() => {
    load();
    // 调度是后台跑的：不订阅就只能看见打开页面那一刻的快照
    return subscribeEvents((e) => {
      if (e.kind === "reconnect") return load();
      if (e.kind === "engine" && (e.data as { kind?: string }).kind === "metrics_pull") load();
    });
  }, [load]);

  const toggle = (row: PullPlatformStatus, enabled: boolean) => {
    void invoke("flywheel:pull_toggle", { platform: row.platform, enabled }).then((r) => {
      if (!r.ok) return toast(r.error ?? "开关没保存上");
      toast(enabled ? `${row.label}自动回流已开启` : `${row.label}自动回流已关闭`);
      load();
    });
  };

  const pullNow = async (row: PullPlatformStatus) => {
    setBusy(row.platform);
    const r = await invoke("flywheel:pull_now", { platform: row.platform });
    setBusy(null);
    load();
    if (!r.ok) return toast(r.error ?? "抓取失败");
    const attempt = (r as unknown as { data: PullAttemptView }).data;
    toast(attemptMessage(row.label, attempt));
    if (attempt.status === "ok") onImported();
  };

  return (
    <div className="card report-card">
      <div className="card-head">
        <span className="card-title">自动回流</span>
        <span className="mono muted">浏览器登录态直调创作者后台 · 每 12 小时一次</span>
      </div>
      {err && (
        // 读不出状态 ≠ 没抓过:这里必须说实话,否则人会以为自动回流从没跑过
        <p className="pull-banner">回流状态不可用：{err}</p>
      )}
      {!err && rows === null && <p className="muted">载入中…</p>}
      {rows && browserUnreachable(rows) && (
        <p className="pull-banner">
          浏览器未连接：自动回流需要一个常驻 Chrome（chrome-cdp，默认 127.0.0.1:18792）带着你的平台登录态。
          启动它之后点任意一行的「立即抓取」重试——三平台会一起恢复。
        </p>
      )}
      {rows?.map((row) => (
        <PullRow
          key={row.platform}
          row={row}
          busy={busy === row.platform}
          onToggle={(enabled) => toggle(row, enabled)}
          onPull={() => void pullNow(row)}
        />
      ))}
      {rows && rows.every((r) => !r.enabled) && (
        <p className="muted pull-note">三个平台都还没开——打开开关，数据就会自己回来（抓不到会明说，不会假装成功）。</p>
      )}
    </div>
  );
}
