/**
 * 看板上的「推特 ≠ X 英文视频」提示（全媒体 spec §9.3）：档案里只勾了旧的「推特」、没勾 X / YouTube 时出现一次。
 * 推特只管图文推；要发英文版视频得到「设置 → 运营平台」明确勾 X 或 YouTube。勾了就自动消失；「知道了」只记在这台浏览器（同引擎提醒的做法）。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";

const DISMISS_KEY = "legacy-twitter-prompt-dismissed";

export function LegacyTwitterReminder() {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; } });
  useEffect(() => {
    void invoke("onboarding:status").then((r) => {
      if (!r.ok) return setError(r.error ?? "原因没写");
      setText((r.data as { legacyTwitterPrompt?: string | null } | undefined)?.legacyTwitterPrompt ?? null);
    });
  }, []);
  if (dismissed) return null;
  if (error) return <div className="pref-banner" role="status"><span className="muted">读不到平台勾选：{error}</span></div>;
  if (!text) return null;
  const dismiss = () => { try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* 隐私模式：这次会话里关掉 */ } setDismissed(true); };
  return <div className="pref-banner" role="status">
    <div className="pref-banner-row">
      <span>{text}</span>
      <a className="button primary" href="#/settings?tab=platforms">去勾选</a>
      <button onClick={dismiss}>知道了</button>
    </div>
  </div>;
}
