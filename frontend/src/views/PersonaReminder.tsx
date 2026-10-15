/**
 * 看板上的「补全画像」提醒（onboarding-connect O18）：引导里跳过了画像（或还没有档案）时出现，不拦任何操作。
 * 点开就地填（和引导「你是谁」同一张表），存好就消失。读不到状态时照实说，不装作没事。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { PersonaStep } from "./onboarding/PersonaStep";

export function PersonaReminder() {
  const [state, setState] = useState<"loading" | "complete" | "missing" | { error: string }>("loading");
  const [open, setOpen] = useState(false);
  const load = async () => {
    const r = await invoke("onboarding:status");
    if (!r.ok) { setState({ error: r.error ?? "原因没写" }); return; }
    // 引导里跳过了、或压根没建过档案才提醒；老用户档案缺一两项不打扰（校准页里能改）
    const d = r.data as { personaComplete?: boolean; personaSkipped?: boolean; onboarded?: boolean } | undefined;
    setState(!d?.personaComplete && (d?.personaSkipped || !d?.onboarded) ? "missing" : "complete");
  };
  useEffect(() => { void load(); }, []);
  if (state === "loading" || state === "complete") return null;
  if (typeof state === "object") return <div className="pref-banner" role="status"><span className="muted">读不到画像状态：{state.error}</span></div>;
  return <div className="pref-banner persona-reminder" role="status">
    {open
      ? <div className="persona-reminder-form"><PersonaStep onNext={() => { setOpen(false); void load(); }} /></div>
      : <div className="pref-banner-row">
          <span>补全画像：AI 写稿时还不知道你是做什么的、给谁看、想要什么口吻。不填也能写，填了写得更像你。</span>
          <button className="primary" onClick={() => setOpen(true)}>补全画像</button>
        </div>}
  </div>;
}
