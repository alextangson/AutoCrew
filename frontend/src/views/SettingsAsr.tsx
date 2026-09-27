/** 语音转写模型（FunASR）：认稿按开头转写、自动剪辑都靠它。首次约 1GB，预热在后台跑，这里轮状态。 */
import { useEffect, useRef, useState } from "react";
import { toast } from "../ui";
import { videoAsrStatus, videoAsrWarmup } from "../lib";
import { Section } from "./settings-kit";

const LABEL: Record<string, string> = { absent: "未下载", warming: "预热中", ready: "已就绪", failed: "预热失败" };

export function SettingsAsr() {
  const [status, setStatus] = useState<{ status: string; detail?: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const load = async () => {
    const r = await videoAsrStatus();
    if (!r.ok || !r.data) return setError(r.error || "读不了语音模型状态");
    setError("");
    setStatus(r.data);
  };
  useEffect(() => { void load(); return () => window.clearInterval(timer.current); }, []);
  useEffect(() => {
    window.clearInterval(timer.current);
    if (status?.status === "warming") timer.current = window.setInterval(() => void load(), 3000);
  }, [status?.status]);
  const warmup = async () => {
    setBusy(true);
    try {
      const r = await videoAsrWarmup();
      if (!r.ok) return toast(r.error || "预热没有启动");
      toast("已开始预热，可以先干别的");
      await load();
    } finally { setBusy(false); }
  };
  const state = status?.status ?? "";
  return <Section title="语音转写模型" on={state === "ready"} status={LABEL[state] ?? ""}>
    <p>Codex 认原片时按开头转写对稿，剪辑线转写口播也用它。首次要下载约 1GB，下完之后本机所有资料库共用。</p>
    {error && <p role="alert">{error}</p>}
    {status?.detail && <p className="muted">{status.detail}</p>}
    <button className="primary" disabled={busy || state === "warming" || state === "ready"} onClick={() => void warmup()}>
      {state === "warming" ? "预热中…" : "预热 ASR 模型"}
    </button>
  </Section>;
}
