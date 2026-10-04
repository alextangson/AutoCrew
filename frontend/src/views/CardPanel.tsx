/**
 * 卡片面板（spec 2026-09-29 §10 一期最小面板）：阶段、还差什么、候选（是这条 / 不是这条）、A-roll 挂载（贴路径）、
 * 我发了 / 纠正、登记核对清单、重开文稿。等你拍板 2a：卡片只留整条稿的动作（下一步、原片行、挂原片、重开文稿、已经发出去了）；
 * 逐件的决定（候选、待核的发布、闪帧、成片、封面）只给「去『等你拍板』处理」，不重复放按钮。
 * 每个按钮都是创始人决定，走浏览器会话的 /api/board/decision。
 * 2026-10-04：看板不再弹面板（点卡直接进稿件页），这块内容整块搬进稿件页，作为可折叠的「这条视频的进度」区；
 * 只对按本体走的稿显示。
 */
import { useCallback, useEffect, useState } from "react";
import { confirmDialog, toast } from "../ui";
import { CardArolls } from "./CardArolls";
import { CardNext } from "./CardNext";
import { nextStep } from "./card-next";

/** 屏幕上不出现「A-roll」（1b 验收）：内部字段照旧，显示时说「原片」 */
const onScreen = (s: string) => s.replace(/A-roll/g, "原片");
import { CardCandidates } from "./CardCandidates";
import { chooseFile, decide, loadCard, openStoryboard, reopenScript, type CardPanelData, type SliverPanel, type StoryboardPanel } from "./board-api";
import { RevealLink, when } from "./board-parts";
import { inboxHref } from "./review/review-api";

const KIND_LABEL: Record<string, string> = { aroll: "原片", cut: "成片", srt: "字幕", cover: "封面", publish: "发布回执", chatcut_project: "ChatCut 工程" };
import { UNDO } from "./board-columns";
import { platformName } from "./board-columns";

/** 有正在核对的时候面板多久重读一次 */
const POLL_MS = 5000;

type Props = { contentId: string; reload?: () => Promise<void>; open?: boolean };

export function CardPanel(p: Props) {
  const [data, setData] = useState<CardPanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [arollPath, setArollPath] = useState("");
  const refresh = useCallback(async () => {
    const r = await loadCard(p.contentId);
    if (r.ok) { setData(r.data); setError(null); } else setError(r.error);
  }, [p.contentId]);
  useEffect(() => { void refresh(); }, [refresh]);
  // 有正在核对的（pending_match / 挂载核对 checking）就每 5 秒重读，结果或失败出来就停；面板关了也停（Codex 审 segB6 P2）
  const checking = Boolean(data && ((data.candidate_rows ?? []).some((c) => c.state === "pending_match") || (data.arolls ?? []).some((r) => r.check?.status === "checking")));
  useEffect(() => {
    if (!checking) return;
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [checking, refresh]);

  const act = async (action: string, params: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      const r = await decide(p.contentId, action, params);
      toast(r.ok ? done : r.error);
      await Promise.all([refresh(), p.reload?.()]);
      return r;
    } finally { setBusy(false); }
  };
  /** 原片归别条稿（重开前那一轮的）：说清归谁，创始人确认后带 reassign 改挂到这条 */
  const actOrReassign = async (action: string, params: Record<string, unknown>, done: string) => {
    const r = await act(action, params, done);
    const body = r.ok ? null : r.body;
    // 别条稿正在核对这个原片（1b §3-7）：先说是哪条，确认后取消那边的核对再挂
    if (body?.code === "aroll_pending_elsewhere") {
      if (!(await confirmDialog({ title: "还是挂到这条？", body: String(body.error ?? ""), confirmLabel: "挂到这条", danger: true }))) return r;
      return act(action, { ...params, cancel_pending: true }, done);
    }
    if (body?.code !== "aroll_conflict" || body.reassignable !== true) return r;
    const owner = String(body.owner_title ?? body.owner_id ?? "另一条稿");
    if (!(await confirmDialog({ title: "改挂到这条？", body: reassignText(owner), confirmLabel: "改挂到这条", danger: true }))) return r;
    return act(action, { ...params, reassign: true }, "已改挂到这条");
  };
  const attach = async (file: string) => {
    const r = await actOrReassign("attach_aroll", { path: file.trim() }, "A-roll 已挂上、挪进项目");
    if (!r.ok && r.error.includes("更像《")) {
      if (await confirmDialog({ title: "确定挂到这条？", body: r.error, confirmLabel: "挂到这条" })) await actOrReassign("attach_aroll", { path: file.trim(), confirm_other: true }, "A-roll 已挂上、挪进项目");
    }
  };
  /** 「选择文件…」：服务端在这台 Mac 上弹访达选择窗；取消 / 弹不出都明说，贴路径留作退路 */
  const pick = async () => {
    setBusy(true);
    let chosen: string | null = null;
    try {
      const r = await chooseFile();
      if (r.ok) chosen = r.data.path;
      else toast(r.error);
    } finally { setBusy(false); }
    if (chosen) { setArollPath(chosen); await attach(chosen); }
  };
  const reopen = async () => {
    const undo = data?.published_now ? UNDO.reopen_published : UNDO.reopen;
    if (!(await confirmDialog({ title: undo.title, body: undo.body, confirmLabel: "重开文稿", danger: true }))) return;
    const r = await reopenScript(p.contentId, data?.round ?? 1);
    toast(r.ok ? "已重开文稿" : r.error);
    await Promise.all([refresh(), p.reload?.()]);
  };

  // 没按本体走的稿（旧流程 / 图文）不显示这块；读失败要说出来，不装作没有
  if (data && !data.active) return null;
  return <details className="card-panel card-panel-inline" id="card-progress" aria-label="这条视频的进度" open={p.open ?? true}>
    <summary className="card-panel-head"><h2>这条视频的进度{data ? ` · ${data.title}` : ""}</h2></summary>
    {error && <p className="board2-stale" role="alert">进度读不出来：{error} <button className="bcard-link" onClick={() => void refresh()}>重试</button></p>}
    {!data && !error && <p className="card-panel-note">读取中</p>}
    {data && <PanelBody goInbox={() => { window.location.hash = inboxHref(p.contentId); }} data={data} busy={busy} act={act} actOrReassign={actOrReassign} arollPath={arollPath} setArollPath={setArollPath} attach={() => attach(arollPath)} pick={pick} reopen={reopen} refresh={async () => { await Promise.all([refresh(), p.reload?.()]); }} />}
  </details>;
}

/** 改挂确认的说法：原片现在归谁、改挂之后那条稿就不再拥有它 */
export function reassignText(owner: string): string {
  return `这个原片现在归《${owner}》（它重开文稿前那一轮用过）。改挂到这条之后，《${owner}》就不再拥有它。`;
}

function PanelBody(p: {
  data: CardPanelData; busy: boolean; act: (a: string, params: Record<string, unknown>, done: string) => Promise<unknown>;
  actOrReassign: (a: string, params: Record<string, unknown>, done: string) => Promise<unknown>;
  arollPath: string; setArollPath: (v: string) => void; attach: () => Promise<void>; pick: () => Promise<void>; reopen: () => Promise<void>;
  refresh: () => Promise<void>; goInbox: (types?: string[]) => void;
}) {
  const d = p.data;
  // 「下一步」已经说了的，下面不再重复（1b 验收）：原因句、「已有原片…」、「…自动挂上，不对就点…」（原片行里有来源和「不是」）
  const next = nextStep(d);
  const covered = (b: string) => Boolean(next) && (b === d.reason || b.startsWith("已有") || b.includes("自动挂上，不对就点"));
  return <>
    <CardNext d={d} busy={p.busy} act={p.act} openEditor={() => undefined} refresh={p.refresh} goInbox={p.goInbox} />
    {d.active && d.unreviewed && <UnreviewedCut u={d.unreviewed} busy={p.busy} act={p.act} goInbox={() => p.goInbox(["cut_review"])} />}
    <p className="card-panel-stage"><strong>{d.stage ?? d.column ?? "—"}</strong>{d.reason && !next ? ` · ${d.reason}` : ""}</p>
    {d.missing.length > 0 && <p className="card-panel-note">还差：{d.missing.map(onScreen).join("、")}</p>}
    {(d.alerts ?? []).map((a) => <p key={a} className="card-panel-alert" role="alert">{a}</p>)}
    {d.badges.filter((b) => b !== d.reason && !covered(b)).map((b) => <p key={b} className="card-panel-note">{onScreen(b)}</p>)}
    {d.active && <CardCandidates contentId={d.id} rows={d.candidate_rows ?? []} busy={p.busy} act={p.act} confirm={p.actOrReassign} inbox={() => p.goInbox(["candidate"])} />}
    {d.active && d.stray_covers && <StrayCovers n={d.stray_covers.count} busy={p.busy} act={p.act} />}
    {d.active && <CardArolls contentId={d.id} rows={d.arolls ?? []} busy={p.busy} act={p.act} />}
    {d.active && (d.column === "待录制" || d.missing.includes("A-roll")) && <section><h3>挂原片</h3>
      <div className="card-panel-row">
        <button className="primary" disabled={p.busy} onClick={() => void p.pick()}>选择文件…</button>
        <span className="card-panel-note">在访达里选原片，选好就挂到这条</span>
      </div>
      <details><summary className="card-panel-note">或者贴路径</summary>
        <div className="card-panel-row">
          <input value={p.arollPath} onChange={(e) => p.setArollPath(e.target.value)} placeholder="/Users/…/原片.mov" />
          <button disabled={p.busy || !p.arollPath.trim()} onClick={() => void p.attach()}>挂到这条</button>
        </div>
      </details>
    </section>}
    {d.active && (d.pending_receipts ?? []).length > 0 && <section><h3>待你确认的发布</h3>{d.pending_receipts!.map((r) => <div key={r.fact_id} className="card-panel-row">
      <span>{r.host} 说已发到 {platformName(r.platform ?? "")}{r.url ? `：${r.url}` : ""}，是吗？</span>
      <InboxLink go={() => p.goInbox(["publish_claim"])} />
    </div>)}</section>}
    {d.active && d.storyboard && <StoryboardSection contentId={d.id} s={d.storyboard} />}
    {d.active && d.slivers && d.slivers.blocked && <section><h3>画面检查</h3><div className="card-panel-row">
      <span>{d.slivers.status === "slivers" ? `画面有闪帧（${d.slivers.items.filter((x) => !x.waived).length} 处）` : d.slivers.missing ?? "画面检查还没有结果"}</span>
      {d.slivers.status !== "none" && <InboxLink go={() => p.goInbox(["sliver"])} />}</div></section>}
    {d.active && <PublishedSection d={d} busy={p.busy} act={p.act} />}
    {d.active && (d.past_receipts ?? []).length > 0 && <details><summary className="card-panel-note">以前几轮的发布（历史，不算本轮）</summary>
      {d.past_receipts!.map((r) => <p key={`${r.round}-${r.platform}`} className="card-panel-note">{platformName(r.platform)} · {r.label}{r.url ? `：${r.url}` : ""}</p>)}
    </details>}
    {d.active && d.checklist && <p className="bcol-note">实拍版核对清单：项目里的 {d.checklist}</p>}
    {d.active && d.can_reopen && <footer className="card-panel-actions">
      <button className="btn-ghost" disabled={p.busy} onClick={() => void p.reopen()}>重开文稿</button>
    </footer>}
  </>;
}

function PublishedSection(p: { d: CardPanelData; busy: boolean; act: (a: string, params: Record<string, unknown>, done: string) => Promise<unknown> }) {
  const [url, setUrl] = useState("");
  const d = p.d;
  const correct = async (id: string) => {
    if (await confirmDialog({ title: UNDO.correct_publish.title, body: UNDO.correct_publish.body, confirmLabel: "纠正", danger: true })) await p.act("correct_publish", { target_id: id }, "已纠正发布记录");
  };
  if (d.column !== "待发布" && d.column !== "已发布") return null;
  const published = d.column === "已发布";
  // 用词按 §4.1：「我发了」→「已经发出去了」
  return <section><h3>发布</h3>
    {(d.published ?? []).map((x) => <div key={x.id} className="card-panel-row"><span>{platformName(x.platform ?? "")} · {x.label}{x.url ? ` · ${x.url}` : x.work ? ` · 作品 ${x.work}` : ""}</span>
      <button disabled={p.busy} onClick={() => void correct(x.id)}>纠正</button></div>)}
    {!published && <div className="card-panel-row">
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="作品链接（可不填）" />
      <button disabled={p.busy} onClick={() => void p.act("i_published", { platform: d.platform, ...(url.trim() ? { url: url.trim() } : {}) }, "已记为你发了")}>已经发出去了</button>
    </div>}
  </section>;
}

/** 抽帧缝：每处时间码 + 前后条目 + 修法，逐处「这处是故意的」；检查没跑成时才有「这条不查了，放行」 */
export function SliverSection(p: { s: SliverPanel; busy: boolean; act: (a: string, params: Record<string, unknown>, done: string) => Promise<unknown> }) {
  const s = p.s;
  const waiveAll = async () => {
    if (await confirmDialog({ title: "这条不查抽帧缝了？", body: `抽帧检查没跑成（${s.reason ?? "原因不明"}）。放行后这版成片可以直接通过，缝要你自己看片把关。`, confirmLabel: "不查了，放行" })) {
      await p.act("waive_sliver_check", { cut_sha: s.cut_sha }, "这版成片不查抽帧缝了");
    }
  };
  return <section><h3>抽帧检查</h3>
    {s.status === "clean" && <p className="card-panel-note">没有抽帧缝</p>}
    {s.status === "none" && <p className="card-panel-note">{s.reason ?? "抽帧检查还没有结果"}</p>}
    {s.status === "unchecked" && <p className="card-panel-alert" role="alert">没跑成：{s.reason}</p>}
    {s.whole_waived && <p className="card-panel-note">你已放行：这版成片不查抽帧缝</p>}
    {s.items.map((x) => <div key={x.key} className="card-panel-row">
      <span>{x.start_tc} 露出真人 {x.frames} 帧（「{x.prev_name ?? "前一段"}」和「{x.next_name ?? "后一段"}」之间）{x.transition ? " · 转场处可能露出" : ""}{x.suggestion ? ` · 建议：${x.suggestion}` : ""}</span>
      {x.waived ? <span className="card-panel-note">已放行</span>
        : <button disabled={p.busy} onClick={() => void p.act("waive_sliver", { cut_sha: s.cut_sha, fingerprint: s.fingerprint, sliver_key: x.key }, "记下了：这处是故意的")}>这处是故意的</button>}
    </div>)}
    {s.whole_waivable && <div className="card-panel-row"><button disabled={p.busy} onClick={() => void waiveAll()}>这条不查了，放行</button></div>}
  </section>;
}

/** 分镜：最新一版「打开审阅页」+「在访达中显示」，旧版折叠；报上之后被改过就提示 */
export function StoryboardSection(p: { contentId: string; s: StoryboardPanel }) {
  const l = p.s.latest;
  const open = async (factId: string) => {
    const r = await openStoryboard(p.contentId, factId);
    if (!r.ok) toast(r.error);
    else if (r.data.opened === false) toast(`这台机器打不开浏览器，路径：${String(r.data.path ?? "")}`);
  };
  return <section><h3>分镜</h3>
    <div className="card-panel-row">
      <span>最新的分镜 · {when(l.at)} 报上</span>
      <button className="primary" disabled={l.missing} onClick={() => void open(l.fact_id)}>打开审阅页</button>
      <RevealLink contentId={p.contentId} target={l.sha256} />
    </div>
    {l.note && <p className="card-panel-alert" role="alert">{l.note}</p>}
    {p.s.older.length > 0 && <details><summary className="card-panel-note">以前的分镜（{p.s.older.length} 版）</summary>
      {p.s.older.map((o) => <div key={o.fact_id} className="card-panel-row">
        <span>{when(o.at)} 报上的分镜</span>
        <button onClick={() => void open(o.fact_id)}>打开审阅页</button>
      </div>)}
    </details>}
  </section>;
}

/** 「去『等你拍板』处理」：逐件的决定只在列表里做，卡片上不重复放按钮 */
function InboxLink(p: { go: () => void }) {
  return <button className="btn-ghost" onClick={p.go}>去『等你拍板』处理</button>;
}

/**
 * B7：agent 一直没标「可以审了」，创始人要审——「我现在就要审」= 创始人自己把最新一版标成可以审，
 * 之后「成片剪好了，看一遍」出现在「等你拍板」里。
 */
export function UnreviewedCut(p: { u: { count: number; editor_label: string }; busy: boolean; act: (a: string, params: Record<string, unknown>, done: string) => Promise<unknown>; goInbox: () => void }) {
  const now = async () => { await p.act("review_now", {}, "好，最新一版放进「等你拍板」了"); p.goInbox(); };
  return <section className="card-panel-row" aria-label="还没说可以审">
    <span className="card-panel-note">有 {p.u.count} 个导出，{p.u.editor_label}还没说可以审了</span>
    <button className="btn-ghost" disabled={p.busy} onClick={() => void now()}>我现在就要审</button>
  </section>;
}

/** 以前的封面文件（不在正式封面文件夹里）：收成一行，给「都不要」；它们不是要逐张拍板的事 */
export function StrayCovers(p: { n: number; busy: boolean; act: (a: string, params: Record<string, unknown>, done: string) => Promise<unknown> }) {
  return <section className="card-panel-row" aria-label="以前的封面文件">
    <span className="card-panel-note">以前的封面文件 {p.n} 张（不在正式封面文件夹里）</span>
    <button className="btn-ghost" disabled={p.busy} onClick={() => void p.act("reject_stray_covers", {}, "这些以前的封面文件都不要了")}>都不要</button>
  </section>;
}
