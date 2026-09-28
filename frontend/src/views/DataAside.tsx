/**
 * 数据页第四张问答卡「写法实验有没有效」（数据页规格 §H.52 + §G.44 / §G.45）：
 * 每条写法一句 + 看哪个指标 + 状态，长说明点开看；卡底是复盘入口和「生成本月复盘」。
 * 生成要调模型：线路坏了按钮旁写明，生成失败把错误留在原地，不静默。
 */
import { useEffect, useState } from "react";
import { invoke } from "../transport";
import { platformLabel } from "../lib";
import { Button } from "../components/Button";
import { useEngineHealth } from "./EngineBanner";
import { engineBannerLines } from "./engine-lib";
import { METRIC_FOCUS_LABELS, evidenceSummary, type HypothesisView } from "../pull-lib";
import { HYP_STATE_TEXT, hypAnswer, hypState } from "./data-answers";
import { QCard } from "./DataQuestions";

export interface RetroItem { file: string; mode: string; date: string }

export function useRetros() {
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
    <span className="data-gen">
      <Button size="sm" disabled={busy || down} onClick={() => void run()}>{busy ? "生成中…（要几分钟）" : "生成本月复盘"}</Button>
      {down && !busy && <span className="data-warn">线路异常，暂时生成不了</span>}
      {err && <span className="data-err">生成失败：{err}</span>}
    </span>
  );
}

const retroName = (r: RetroItem) => `${r.date.slice(5)} ${r.mode === "weekly" ? "周复盘" : "月度复盘"}`;

function RetroLinks(props: { open: string | null; onOpen: (file: string | null) => void; retros: ReturnType<typeof useRetros> }) {
  const { retros, err, reload } = props.retros;
  return (
    <div className="dq-retros">
      {err && <span className="data-err">复盘列表读不出来：{err}</span>}
      {retros?.length === 0 && <span>还没有复盘</span>}
      {retros?.slice(0, 3).map((r) => (
        <button key={r.file} className={"data-link" + (props.open === r.file ? " is-on" : "")} onClick={() => props.onOpen(props.open === r.file ? null : r.file)}>
          {props.open === r.file ? `收起 ${retroName(r)}` : `看 ${retroName(r)}`}
        </button>
      ))}
      <GenerateRetro onDone={(file) => { reload(); props.onOpen(file); }} />
    </div>
  );
}

function HypothesisLine({ h }: { h: HypothesisView }) {
  const [open, setOpen] = useState(false);
  const metric = METRIC_FOCUS_LABELS[h.metricFocus] ?? h.metricFocus;
  const scope = h.scope.platform ? platformLabel(h.scope.platform) : "";
  const evidence = evidenceSummary(h.evidence);
  return (
    <div className="dq-hyp">
      <button className="dq-hyp-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="dq-title">{h.statement}</span>
        <span className="dq-meta">看{scope}{metric} · {HYP_STATE_TEXT[hypState(h)]}</span>
      </button>
      {open && (
        <div className="dq-hyp-more">
          <p>{h.direction === "up" ? "预期高于基线" : "预期低于基线"} · 提出于 {h.proposedAt.slice(5, 10)}</p>
          {evidence && <p>证据：{evidence}</p>}
          {h.evidence?.reason && <p>判据：{h.evidence.reason}</p>}
          {h.evidence?.note && <p>口径：{h.evidence.note}</p>}
          {h.nextAction && <p>下一步：{h.nextAction}</p>}
        </div>
      )}
    </div>
  );
}

export function ExperimentsCard(props: { retro: string | null; onOpenRetro: (file: string | null) => void; retros: ReturnType<typeof useRetros> }) {
  const [data, setData] = useState<HypothesisView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void invoke("flywheel:hypotheses_list").then((r) => {
      if (!r.ok) return setErr(r.error ?? "读不出来");
      const d = (r as unknown as { data: { open: HypothesisView[]; judged: HypothesisView[] } }).data;
      setData([...d.open, ...d.judged]);
    });
  }, []);
  const q = "写法实验有没有效";
  const note = <RetroLinks open={props.retro} onOpen={props.onOpenRetro} retros={props.retros} />;
  if (err) return <QCard q={q} answer="写法台账读不出来" note={note}><p className="data-err">{err}</p></QCard>;
  if (!data) return <QCard q={q} answer="载入中…" note={note} />;
  return (
    <QCard q={q} answer={hypAnswer(data)} note={note}>
      {data.map((h) => <HypothesisLine key={h.id} h={h} />)}
    </QCard>
  );
}
