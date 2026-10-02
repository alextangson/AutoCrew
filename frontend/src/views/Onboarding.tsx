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

/** 开工提示按能力查表，不按宿主名写死：能力来自服务端的 host-policy（canWrite），以后放开谁写稿不用改这里 */
const START_HINT = { write: "帮我写一条……", edit: "把这条视频的成片登记到 AutoCrew" } as const;

export function DonePage(props: { connected: HostStatus[]; engineReady: boolean; onEnter: () => void; onOpenSettings: () => void }) {
  const first = props.connected[0];
  const anyWriter = props.connected.some((h) => h.canWrite);
  return (
    <>
      <h1 className="ob-title">{first ? "接好了" : props.engineReady ? "钥匙存好了" : "先进去看看"}</h1>
      {first
        ? props.connected.map((h) => <p key={h.host} className="ob-sub">去 {h.label} 里说「{START_HINT[h.canWrite ? "write" : "edit"]}」{h.canWrite ? "就能开工。" : "。"}</p>)
        : <p className="ob-sub">{props.engineReady ? "在右边的总编辑里说「帮我写一条……」就能开工。" : "之后在「设置 · 接入更多 · 宿主」里随时接上本机 AI。"}</p>}
      {first && !anyWriter && !props.engineReady && (
        <p className="ob-sub">写稿要接 Claude Code 或 WorkBuddy，或者在 设置 → 模型 里填钥匙用内置引擎。</p>
      )}
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
  const [afterSkipError, setAfterSkipError] = useState<() => void>(() => props.onDone);

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
  /** 离开引导：没接上任何宿主、也没存钥匙，就记下「先不配」，刷新不再弹（O1，Codex 评审 P2-5） */
  const leave = async (then: () => void) => {
    const anyConnected = Object.values(results).some((r) => r?.verified);
    if (!anyConnected && !engineReady) {
      const r = await skipOnboarding();
      if (!r.ok) {
        setSkipError(`没记住「先不配」：${r.error}。这次先放你进去，下次打开可能还会看到这一页。`);
        setAfterSkipError(() => then);
        return;
      }
    }
    then();
  };
  const skip = () => leave(props.onDone);

  if (!hosts) return <div className="ob"><span className="ob-sub">正在看这台电脑上装了哪些 AI…</span></div>;
  const connected = hosts.filter((h) => results[h.host]?.verified);
  return (
    <div className="ob">
      <div className="ob-panel">
        <div className="ob-brand">AutoCrew</div>
        {step === "pick" && (
          <PickStep hosts={hosts} picked={picked} setPicked={setPicked} onRefresh={() => void load()} onHostUpdate={(host, patch) => setHosts((list) => list?.map((h) => (h.host === host ? { ...h, ...patch } : h)) ?? list)} onNext={() => setStep("connect")}
            onSkip={() => void skip()} onEngineSaved={() => void engineSaved()} engineReady={engineReady} onFinish={() => setStep("done")}
            {...(loadError ? { loadError } : {})} />
        )}
        {step === "connect" && (
          <ConnectStep hosts={hosts} picked={picked} results={results} onResult={(r) => setResults((x) => ({ ...x, [r.host]: r }))}
            onBack={() => setStep("pick")} onNext={() => setStep("done")} />
        )}
        {step === "done" && <DonePage connected={connected} engineReady={engineReady} onEnter={() => void leave(props.onDone)} onOpenSettings={() => void leave(props.onOpenSettings ?? props.onDone)} />}
        {skipError && (
          <div className="ob-actions"><p className="ob-fail">{skipError}</p><button onClick={afterSkipError}>进去</button></div>
        )}
      </div>
    </div>
  );
}
