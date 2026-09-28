/**
 * 数据页右栏（数据页规格 §G.44 / §G.45）：复盘列表 +「生成本月复盘」，在验证的写法一句话一条。
 * 生成要调模型：线路坏了按钮旁写明，生成失败把错误留在原地，不静默。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { platformLabel } from "../lib";
import { Button } from "../components/Button";
import { useEngineHealth } from "./EngineBanner";
import { engineBannerLines } from "./engine-lib";
import { HYPOTHESIS_STATUS_LABELS, METRIC_FOCUS_LABELS, evidenceSummary, type HypothesisView } from "../pull-lib";

export interface RetroItem { file: string; mode: string; date: string }

function useRetros() {
  const [retros, setRetros] = useState<RetroItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => void invoke("retro:list").then((r) => {
    if (!r.ok) return setErr(r.error ?? "复盘列表读不出来");
    setErr(null);
    setRetros((r as unknown as { data: { retros: RetroItem[] } }).data.retros);
  });
  useEffect(load, []);
  return { retros, err, reload: load };
}

function GenerateRetro(props: { onDone: (file: string) => void }) {
  const { health } = useEngineHealth();
  const down = engineBannerLines(health, Date.now()).length > 0;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    const r = await invoke("retro:generate", { mode: "monthly" });
    setBusy(false);
    if (!r.ok) return setErr(r.error ?? "原因不明");
    props.onDone((r as unknown as { data: { file: string } }).data.file);
  };
  return (
    <div className="data-gen">
      <Button size="sm" disabled={busy || down} onClick={() => void run()}>{busy ? "生成中…（要几分钟）" : "生成本月复盘"}</Button>
      {down && !busy && <span className="data-warn">线路异常，暂时生成不了</span>}
      {err && <p className="data-err">生成失败：{err}</p>}
    </div>
  );
}

export function RetroPanel(props: { open: string | null; onOpen: (file: string | null) => void }) {
  const { retros, err, reload } = useRetros();
  return (
    <section className="data-side-block">
      <div className="data-side-title">复盘</div>
      {err && <p className="data-err">复盘列表读不出来：{err}</p>}
      {!err && retros === null && <p className="muted">载入中…</p>}
      {retros?.length === 0 && <p className="muted">还没有复盘。</p>}
      {retros?.slice(0, 6).map((r) => (
        <button key={r.file} className={"data-side-row" + (props.open === r.file ? " is-on" : "")} onClick={() => props.onOpen(props.open === r.file ? null : r.file)}>
          <span>{r.date} {r.mode === "weekly" ? "周复盘" : "月度深盘"}</span>
          <span className="muted">{props.open === r.file ? "收起" : "打开"}</span>
        </button>
      ))}
      <GenerateRetro onDone={(file) => { reload(); props.onOpen(file); }} />
    </section>
  );
}

function HypothesisLine({ h }: { h: HypothesisView }) {
  const [open, setOpen] = useState(false);
  const metric = METRIC_FOCUS_LABELS[h.metricFocus] ?? h.metricFocus;
  const scope = h.scope.platform ? platformLabel(h.scope.platform) : "";
  const evidence = evidenceSummary(h.evidence);
  return (
    <div className="data-hyp">
      <button className="data-side-row data-hyp-head" onClick={() => setOpen(!open)} title={h.statement}>
        <span className="data-hyp-text">{h.statement}</span>
        <span className="muted">看{scope}{metric} · {HYPOTHESIS_STATUS_LABELS[h.status] ?? h.status}</span>
      </button>
      {open && (
        <div className="data-hyp-more muted">
          <p>{h.direction === "up" ? "预期高于基线" : "预期低于基线"}</p>
          {evidence && <p>证据：{evidence}</p>}
          {h.evidence?.reason && <p>判据：{h.evidence.reason}</p>}
          {h.evidence?.note && <p>口径：{h.evidence.note}</p>}
          {h.nextAction && <p>下一步：{h.nextAction}</p>}
        </div>
      )}
    </div>
  );
}

export function HypothesesList() {
  const [data, setData] = useState<HypothesisView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void invoke("flywheel:hypotheses_list").then((r) => {
      if (!r.ok) return setErr(r.error ?? "读不出来");
      const d = (r as unknown as { data: { open: HypothesisView[]; judged: HypothesisView[] } }).data;
      setData([...d.open, ...d.judged]);
    });
  }, []);
  return (
    <section className="data-side-block">
      <div className="data-side-title">在验证的写法{data ? ` · ${data.length}` : ""}</div>
      {err && <p className="data-err">写法台账读不出来：{err}</p>}
      {!err && data === null && <p className="muted">载入中…</p>}
      {data?.length === 0 && <p className="muted">还没有。生成一次复盘，分析师会提出要验证的写法。</p>}
      {data?.map((h) => <HypothesisLine key={h.id} h={h} />)}
    </section>
  );
}
