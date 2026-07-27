/**
 * 选题卡的深调研区（deep-research spec §8「选题卡状态机」）:
 * 无 job → 「深调研」按钮(搜索 key 未配则禁用+指引);进行中 → 四视角逐项状态;
 * 有简报 → 「生成于 X · 重跑」(过期加标注、partial 点名缺席视角);失败 → 原因+重试。
 *
 * 两个可见性约定:
 * 1. 状态由 SSE `research` 流推着走(job 级落定 + 视角级进度同一个流),本组件只按
 *    topicId 过滤后重读 —— 绝不用一个静止的按钮冒充「没在跑」。
 * 2. 读不到简报就说读不到:指针在但文件坏了会原样报错,不静默降级成「还没调研」。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { toast } from "../ui";
import { loadResearchAssets, type ResearchAssetView as AssetView } from "./ResearchAssetPicker";

type JobStatus = "queued" | "running" | "succeeded" | "partial" | "failed";
type PerspectiveStatus = "pending" | "running" | "succeeded" | "failed";

interface PerspectiveState {
  name: string;
  status: PerspectiveStatus;
  errorCode?: string;
}

interface ResearchJob {
  topicId: string;
  status: JobStatus;
  startedAt: string;
  settledAt?: string;
  perspectives: PerspectiveState[];
  briefRevision?: number;
  errorCode?: string;
  failReason?: string;
}

interface BriefMeta {
  revision: number;
  generatedAt: string;
  stale: boolean;
}

interface StatusData {
  job: ResearchJob | null;
  searchConfigured: boolean;
  currentBrief: BriefMeta | null;
}

interface Brief {
  summary: string;
  tensions: string[];
  angleSuggestions: string[];
  evidence: Array<{ claim: string; quote: string; sourceUrl: string }>;
  gaps: string[];
  missingPerspectives: string[];
  revision: number;
}

/** 四视角固定序(与后端 PERSPECTIVE_NAMES 一致),别在别处重排 */
const PERSPECTIVES: Array<{ key: string; label: string }> = [
  { key: "audience", label: "受众痛点" },
  { key: "evidence", label: "证据数据" },
  { key: "counter", label: "反方视角" },
  { key: "benchmark", label: "对标拆解" },
];

const PERSPECTIVE_LABEL: Record<string, string> = Object.fromEntries(PERSPECTIVES.map((p) => [p.key, p.label]));

const STEP_ICON: Record<PerspectiveStatus, string> = {
  pending: "○",
  running: "◐",
  succeeded: "✓",
  failed: "✕",
};

const JOB_RUNNING: JobStatus[] = ["queued", "running"];

const fmtTime = (iso: string): string => (iso.length >= 16 ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso);

function domain(url: string): string {
  const m = url.match(/https?:\/\/([^/\s]+)/);
  return m ? m[1].replace(/^www\./, "") : url.slice(0, 30);
}

/**
 * 素材候选区（§7）。两类各说各的话：
 * - 已下载（stored）：缩略图 + 尺寸 + 来源域名 + caption，「授权需自查」常驻标注；
 * - 仅链接：把**为什么没下下来**摆出来，而不是让人对着一条秃链接猜。
 * 硬闸提醒也留着：素材永远不会自动进正文，得在配图那边手动选。
 */
function AssetPicks({ assets }: { assets: AssetView[] }) {
  if (assets.length === 0) return null;
  const stored = assets.filter((a) => a.stored);
  return (
    <div className="research-block">
      <strong>素材候选</strong>
      <span className="muted mono">
        {" "}· {stored.length}/{assets.length} 张已入库 · 授权需自查,不会自动进正文
      </span>
      <div className="research-assets">
        {assets.map((a, i) => (
          <figure key={a.assetId ?? i} className={a.stored ? "research-asset" : "research-asset research-asset-link"}>
            {a.stored ? (
              <img src={a.fileUrl} alt={a.caption} loading="lazy" />
            ) : (
              <div className="research-asset-ph muted mono">仅链接</div>
            )}
            <figcaption>
              <span className="research-asset-cap">{a.caption || "(未命名)"}</span>
              {a.stored ? (
                <span className="muted mono">{a.width}×{a.height} · 授权需自查</span>
              ) : (
                <span className="research-asset-err">{a.downloadError ?? "未下载"}</span>
              )}
              <a className="research-src mono" href={a.sourcePageUrl} target="_blank" rel="noreferrer">
                {domain(a.sourcePageUrl)} ↗
              </a>
              {!a.stored && (
                <a className="research-src mono" href={a.url} target="_blank" rel="noreferrer">
                  原图 ↗
                </a>
              )}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

function BriefView({ brief, assets }: { brief: Brief; assets: AssetView[] }) {
  return (
    <div className="research-brief">
      <p>{brief.summary}</p>
      {brief.tensions.length > 0 ? (
        <div className="research-block">
          <strong>跨视角张力点</strong>
          <ul>{brief.tensions.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      ) : (
        <p className="muted">未发现明确张力点。</p>
      )}
      {brief.angleSuggestions.length > 0 && (
        <div className="research-block">
          <strong>可写角度</strong>
          <ol>{brief.angleSuggestions.map((a, i) => <li key={i}>{a}</li>)}</ol>
        </div>
      )}
      {brief.evidence.length > 0 && (
        <div className="research-block">
          <strong>证据</strong>
          <ul>
            {brief.evidence.map((e, i) => (
              <li key={i}>
                {e.claim}
                <a className="research-src mono" href={e.sourceUrl} target="_blank" rel="noreferrer">
                  {domain(e.sourceUrl)} ↗
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      <AssetPicks assets={assets} />
      {brief.gaps.length > 0 && (
        <div className="research-block">
          <strong>材料缺口</strong>
          <ul>{brief.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function Progress({ job }: { job: ResearchJob }) {
  const byName = new Map(job.perspectives.map((p) => [p.name, p]));
  return (
    <div className="research-steps">
      {PERSPECTIVES.map((p) => {
        const state = byName.get(p.key);
        const status = state?.status ?? "pending";
        return (
          <span key={p.key} className={"research-step research-step-" + status}>
            <span className="mono">{STEP_ICON[status]}</span> {p.label}
            {status === "failed" && state?.errorCode ? <span className="muted mono"> · {state.errorCode}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

/** partial 时点名缺席的视角——「少了哪一路」比「部分成功」有用得多 */
function missingLabels(job: ResearchJob): string {
  return job.perspectives
    .filter((p) => p.status !== "succeeded")
    .map((p) => PERSPECTIVE_LABEL[p.name] ?? p.name)
    .join("、");
}

const isRunning = (job: ResearchJob | null): boolean => job !== null && JOB_RUNNING.includes(job.status);

/** 状态机的说明区(按钮在 head 里):每一态都必须说人话,没有一条路径是沉默的 */
function StateLines({ st }: { st: StatusData }) {
  const { job, currentBrief: meta } = st;
  if (!st.searchConfigured) {
    return <p className="muted">深调研要联网取证:先去设置页 · 搜索来源配好博查或 Tavily 的 key。</p>;
  }
  if (job === null) {
    return <p className="muted">还没调研过。跑一轮:四视角并行侦察 → 带跨视角张力点的简报,写这条选题时自动注入。</p>;
  }
  if (isRunning(job)) {
    return (
      <>
        <Progress job={job} />
        <p className="muted mono">{job.status === "queued" ? "排队中…" : "四视角并行侦察中,通常几分钟"}</p>
      </>
    );
  }
  if (job.status === "failed") {
    return (
      <>
        <p className="inbox-bad">
          上一轮失败:{job.failReason ?? "原因未记录"}
          {job.errorCode ? <span className="muted mono"> · {job.errorCode}</span> : null}
        </p>
        {meta && <p className="muted">旧简报(v{meta.revision})仍然有效,写稿照常注入。</p>}
      </>
    );
  }
  if (!meta) return <p className="inbox-bad">这一轮没留下可读简报——重跑一次。</p>;
  if (job.status === "partial") {
    return <p className="muted">部分视角缺席:{missingLabels(job)} —— 简报照常可用,重跑可能补齐。</p>;
  }
  return null;
}

export function ResearchPanel({ topicId }: { topicId: string }) {
  const [st, setSt] = useState<StatusData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [assets, setAssets] = useState<AssetView[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await invoke("research:status", { topic_id: topicId });
    if (!r.ok) return setErr(r.error ?? "调研状态读取失败");
    setErr(null);
    setSt((r as unknown as { data: StatusData }).data);
  }, [topicId]);

  useEffect(() => {
    void load();
    // 每次台账写完(含逐视角进度)推一条 research:updated —— 只认自己这条选题的
    return subscribeEvents((e) => {
      if (e.kind === "research" && e.data.topicId === topicId) void load();
    });
  }, [load, topicId]);

  const revision = st?.currentBrief?.revision ?? null;
  useEffect(() => {
    if (!open || revision === null) return setBrief(null);
    let alive = true;
    void invoke("research:brief_get", { topic_id: topicId }).then((r) => {
      if (!alive) return;
      if (!r.ok) {
        setBrief(null);
        return toast(r.error ?? "简报读取失败");
      }
      setBrief((r as unknown as { data: { brief: Brief } }).data.brief);
    });
    // 素材单独读:落盘态(stored/尺寸/取图地址)只有 list_assets 说了算,简报里存的是候选本身
    void loadResearchAssets(topicId).then((list) => {
      if (alive) setAssets(list);
    });
    return () => {
      alive = false;
    };
  }, [open, revision, topicId]);

  const dig = async () => {
    setBusy(true);
    try {
      const r = await invoke("research:deep_dive", { topic_id: topicId });
      if (!r.ok) return toast(r.error ?? "深调研派发失败");
      toast((r as unknown as { data?: { note?: string } }).data?.note ?? "已排队");
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (err) return <p className="inbox-bad research-panel">{err}</p>;
  if (!st) return <p className="muted research-panel">读取调研状态…</p>;

  const meta = st.currentBrief;
  const running = isRunning(st.job);
  const label = meta ? "重跑深调研" : st.job && !running ? "重试深调研" : "深调研";

  return (
    <div className="research-panel">
      <div className="research-head">
        <strong>深调研</strong>
        {meta && (
          <span className="muted mono">
            简报 v{meta.revision} · 生成于 {fmtTime(meta.generatedAt)}
          </span>
        )}
        {meta?.stale && <span className="chip research-stale">基于旧版选题,建议重跑</span>}
        <span className="row-actions">
          {meta && (
            <button onClick={() => setOpen((v) => !v)}>{open ? "收起简报" : "看简报"}</button>
          )}
          {!running && (
            <button disabled={busy || !st.searchConfigured} onClick={() => void dig()}>
              {busy ? "派发中…" : label}
            </button>
          )}
        </span>
      </div>

      <StateLines st={st} />
      {open && brief && <BriefView brief={brief} assets={assets} />}
    </div>
  );
}
