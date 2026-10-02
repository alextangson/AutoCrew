/**
 * 新引导（onboarding-connect §2）：两步 + 完成页。
 *   1. 你想让哪个 AI 来写稿？（本机 AI 卡片 / DeepSeek 钥匙 / 高级）
 *   2. 接上（每个选中的宿主一键接上，核对真连上）
 *   完成：去哪开工 + 哪几样暂时还要一把 DeepSeek 钥匙。
 * 「先不配」存本机目录（O1），刷新、重启都不再弹。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { loadConnect, skipOnboarding, type ConnectResult, type HostId, type HostStatus } from "./onboarding/connect-api";
import { PickStep } from "./onboarding/PickStep";
import { ConnectStep } from "./onboarding/ConnectStep";
import "./onboarding/onboarding.css";

type Step = "pick" | "connect" | "done";

export function DonePage(props: { connected: HostStatus[]; engineReady: boolean; onEnter: () => void; onOpenSettings: () => void }) {
  const first = props.connected[0];
  return (
    <>
      <h1 className="ob-title">{first ? "接好了" : props.engineReady ? "钥匙存好了" : "先进去看看"}</h1>
      <p className="ob-sub">
        {first
          ? `去 ${first.label} 里说「帮我写一条……」就能开工。`
          : props.engineReady ? "在右边的总编辑里说「帮我写一条……」就能开工。" : "之后在「设置 · 接入更多 · 宿主」里随时接上本机 AI。"}
      </p>
      {!props.engineReady && (
        <p className="ob-note">
          深调研、选题雷达、复盘、人设、每日摘要这几样要用你自己的模型钥匙（DeepSeek 最省事）。现在可以先跳过，以后在设置里补。{" "}
          <button className="btn-ghost ob-inline" onClick={props.onOpenSettings}>去设置里填钥匙</button>
        </p>
      )}
      <div className="ob-actions"><button className="primary" onClick={props.onEnter}>进入 AutoCrew</button></div>
    </>
  );
}

export function Onboarding(props: { onDone: () => void; onOpenSettings?: () => void }) {
  const [step, setStep] = useState<Step>("pick");
  const [hosts, setHosts] = useState<HostStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [picked, setPicked] = useState<HostId[]>([]);
  const [results, setResults] = useState<Partial<Record<HostId, ConnectResult>>>({});
  const [engineReady, setEngineReady] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);

  const load = async () => {
    const r = await loadConnect();
    if (!r.ok) { setLoadError(r.error); setHosts((h) => h ?? []); return; }
    setLoadError(undefined);
    setHosts(r.data.hosts);
    // 默认勾上找到且能用的 Claude（推荐）
    setPicked((p) => (p.length ? p : r.data.hosts.filter((h) => h.host === "claude" && h.found).map((h) => h.host)));
  };
  useEffect(() => { void load(); }, []);

  const engineSaved = async () => {
    const r = await invoke("settings:get");
    setEngineReady(Boolean(r.ok && (r.data as { configured?: boolean } | undefined)?.configured));
  };
  const skip = async () => {
    const r = await skipOnboarding();
    if (!r.ok) return setSkipError(`没记住「先不配」：${r.error}。这次先放你进去，下次打开可能还会看到这一页。`);
    props.onDone();
  };

  if (!hosts) return <div className="ob"><span className="ob-sub">正在看这台电脑上装了哪些 AI…</span></div>;
  const connected = hosts.filter((h) => results[h.host]?.verified);
  return (
    <div className="ob">
      <div className="ob-panel">
        <div className="ob-brand">AutoCrew</div>
        {step === "pick" && (
          <PickStep hosts={hosts} picked={picked} setPicked={setPicked} onRefresh={() => void load()} onNext={() => setStep("connect")}
            onSkip={() => void skip()} onEngineSaved={() => void engineSaved()} engineReady={engineReady} onFinish={() => setStep("done")}
            {...(loadError ? { loadError } : {})} />
        )}
        {step === "connect" && (
          <ConnectStep hosts={hosts} picked={picked} results={results} onResult={(r) => setResults((x) => ({ ...x, [r.host]: r }))}
            onBack={() => setStep("pick")} onNext={() => setStep("done")} />
        )}
        {step === "done" && <DonePage connected={connected} engineReady={engineReady} onEnter={props.onDone} onOpenSettings={props.onOpenSettings ?? props.onDone} />}
        {skipError && (
          <div className="ob-actions"><p className="ob-fail">{skipError}</p><button onClick={props.onDone}>进去</button></div>
        )}
      </div>
    </div>
  );
}
