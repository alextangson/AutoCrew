/**
 * 「交给 {默认 AI} 写 / 看」+ 旁边一个小下拉「换一个」（spec 2026-10-15 §B4）：顶栏、对话栏、看板卡「重新交给」共用。
 * 写稿阶段 = 交给它写（记交出时刻）；其他阶段 = 交给它看（只读查看那句话）。换一个只管这一次，不改默认。
 * 一个 AI 都没接：按钮照样能点，点了说「先接一个 AI」，不假装交出去。
 */
import { useState } from "react";
import { handOffContent } from "./board-api";
import { settle, useWriters, WRITER_LABEL } from "./hand-off";
import type { HostId } from "./onboarding/connect-api";

export function HandOffButton(p: { contentId: string; mode: "write" | "look"; className?: string; label?: (who: string) => string; onDone?: () => void;
  /** 主按钮交给谁（「重新交给」原来那个）；不给 = 默认写稿 AI */
  primary?: HostId }) {
  const w = useWriters();
  const [busy, setBusy] = useState(false);
  const main = p.primary ?? w?.defaultHost ?? null;
  const others = (w?.writers ?? []).filter((h) => h !== main);
  const run = async (host: HostId | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await settle(await handOffContent(p.contentId, p.mode, host), p.mode, (alt) => run(alt));
      p.onDone?.();
    } finally { setBusy(false); }
  };
  const who = main ? WRITER_LABEL[main] : "AI";
  const text = p.label ? p.label(who) : `交给 ${who} ${p.mode === "write" ? "写" : "看"}`;
  return <span className="handoff">
    <button className={p.className} disabled={busy} title={p.mode === "write" ? "把开工指令交给这个 AI，它接手接着写" : "让这个 AI 看看这篇到哪一步，先不改"} onClick={() => void run(p.primary ?? null)}>{busy ? "正在交…" : text}</button>
    {others.length > 0 && <select className="handoff-other" aria-label="换一个 AI" value="" disabled={busy} onChange={(e) => { const h = e.target.value as HostId; if (h) void run(h); }}>
      <option value="">换一个</option>
      {others.map((h) => <option key={h} value={h}>{`交给 ${WRITER_LABEL[h]} ${p.mode === "write" ? "写" : "看"}`}</option>)}
    </select>}
  </span>;
}
