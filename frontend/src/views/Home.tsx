/**
 * 首页「今天」（管线重规划 §1、§5，第 3 期）：账号 → 刚发那条 + 要你做的 → 让 AI 看看 → 管线一览。
 * 视觉照 home-mock-v2/home.html：发丝线分隔不画框，焦点 = 刚发那条，强调色只给「要你做的」。
 * 账号格 = 回流健康 + 账号快照（粉丝、较昨天、昨天播放/阅读、7 天小折线）；数字都从现有接口来，不编。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, subscribeEvents } from "../transport";
import { confirmDialog, toast } from "../ui";
import { platformLabel } from "../lib";
import { requestDockCollapsed } from "../chat/dock-prefs";
import type { PullPlatformStatus } from "../pull-lib";
import { askAI, loadDataPage, loadPipeline, type AskKind } from "./board-api";
import { CHIEF_PREFILL_EVENT, SETTINGS_HREF, useWriters } from "./hand-off";
import { ReviewInbox } from "./review/ReviewInbox";
import { UpdateBanner } from "./update/UpdateBanner";
import { OntologyBanner } from "./OntologyBanner";
import { PersonaReminder } from "./PersonaReminder";
import { LegacyTwitterReminder } from "./LegacyTwitterReminder";
import { PullLoginReminder, retryMessage } from "./PullLoginReminder";
import { openInEgo } from "../ego-open";
import { PGlyph, StagePie } from "./pipeline-glyphs";
import { COLUMN_PROGRESS, type PipelineData } from "./pipeline-model";
import type { DataPageData } from "./data-lib";
import { fmtViews } from "./data-lib";
import {
  accountCells, accountNumbers, askBlocked, askOutcome, dateEyebrow, enabledPlatforms, glanceOf, latestOf, shortTime, sparkPoints,
  type AccountCell, type AccountTileData, type AskOutcome, type Latest, type PerfLine,
} from "./home-model";
import "./pipeline.css";
import "./home.css";

type Load<T> = { data: T | null; error: string | null };
interface HomeData {
  platforms: Load<string[]>;
  pull: Load<{ dailyPullHour?: number; platforms: PullPlatformStatus[] }>;
  report: Load<DataPageData>;
  pipeline: Load<PipelineData>;
}
const EMPTY: HomeData = { platforms: { data: null, error: null }, pull: { data: null, error: null }, report: { data: null, error: null }, pipeline: { data: null, error: null } };

const fromInvoke = <T,>(r: { ok: boolean; error?: string } & Record<string, unknown>, pick: (r: Record<string, unknown>) => T): Load<T> =>
  r.ok ? { data: pick(r), error: null } : { data: null, error: r.error ?? "读取失败" };

/** 四路并行读；任何一路失败只影响它自己那一段，并且照实写出来 */
function useHome() {
  const [d, setD] = useState<HomeData>(EMPTY);
  // 事件 / 聚焦 / 轮询会叠着刷新：只认最后发出的那一次，慢回来的旧结果丢掉，不覆盖新状态
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    const [prof, pull, report, pipeline] = await Promise.all([invoke("onboarding:status"), invoke("flywheel:pull_status"), loadDataPage(), loadPipeline()]);
    if (mine !== seq.current) return;
    setD({
      platforms: fromInvoke(prof as never, (r) => ((r.platforms ?? (r.data as { platforms?: string[] } | undefined)?.platforms) as string[] | undefined) ?? []),
      pull: fromInvoke(pull as never, (r) => r.data as { dailyPullHour?: number; platforms: PullPlatformStatus[] }),
      report: report.ok ? { data: report.data, error: null } : { data: null, error: report.error },
      pipeline: pipeline.ok ? { data: pipeline.data, error: null } : { data: null, error: pipeline.error },
    });
  }, []);
  useEffect(() => {
    void reload();
    const off = subscribeEvents((e) => { if (e.kind === "reconnect" || e.kind === "engine") void reload(); });
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    const t = window.setInterval(() => { if (!document.hidden) void reload(); }, 30_000);
    return () => { off(); window.removeEventListener("focus", onFocus); window.clearInterval(t); };
  }, [reload]);
  return { d, reload };
}

export function Home(props: { inbox?: string; inboxTypes?: string[]; openPipeline: () => void; openEditor: (id: string) => void; openData: () => void }) {
  const { d, reload } = useHome();
  // 同旧看板：首页默认收起总编辑（§28），离开回到偏好；交给总编辑时 App 会再展开
  useEffect(() => requestDockCollapsed(), []);
  const now = Date.now();
  const latest = latestOf(d.report.data, now);
  const shown = d.platforms.data ? enabledPlatforms(d.platforms.data) : null;
  const shownSet = new Set([...(shown?.main ?? []), ...(shown?.later ?? [])]);
  // 第 1 期的登录提醒：在账号格里就地说；没进账号格的平台（没勾运营但开着回流）仍用原来的提醒条
  // pullLogin 为 null = 回流状态读不了：原样交给提醒条，让它照实说，不当成没事
  const rawLogin = d.pipeline.data?.pullLogin;
  const strayLogin = rawLogin === null ? null : rawLogin?.filter((t) => !shownSet.has(t.platform));
  const noCells = Boolean(shown && !shown.main.length && !shown.later.length);
  const hour = d.pull.data?.dailyPullHour;
  return <div className="hm">
    <UpdateBanner />
    <PersonaReminder />
    <LegacyTwitterReminder />
    {d.pipeline.data && <OntologyBanner ontology={d.pipeline.data.ontology} reload={reload} />}
    {(strayLogin === null || (strayLogin && strayLogin.length > 0)) && <PullLoginReminder todos={strayLogin} reload={() => void reload()} />}
    {d.pull.error && noCells && <p className="hm-note hot" role="alert">数据回流状态读不出来：{d.pull.error} · <a href="#/settings?tab=data">去设置看回流</a></p>}
    <div className="hm-head">
      <div><div className="eyebrow">{dateEyebrow(new Date(now))}</div><h1>今天</h1></div>
      <div className="head-r">{hour !== undefined ? `数据回流每天 ${String(hour).padStart(2, "0")}:00 抓取` : ""}</div>
    </div>
    <Accounts shown={shown} d={d} reload={reload} />
    <div className="hm-row2">
      <LatestSection latest={latest} error={d.report.error} loading={!d.report.data && !d.report.error} upcoming={d.report.data?.upcoming ?? null} openData={props.openData} />
      <ReviewInbox variant="home" {...(props.inbox ? { focusContent: props.inbox } : {})} {...(props.inboxTypes ? { focusTypes: props.inboxTypes } : {})} />
    </div>
    <AskSection latest={latest} />
    <Glance data={d.pipeline.data} error={d.pipeline.error} open={props.openPipeline} />
  </div>;
}

// ── 账号 ───────────────────────────────────────────────────────────────────

function Accounts(p: { shown: { main: string[]; later: string[] } | null; d: HomeData; reload: () => Promise<void> }) {
  const head = <div className="sec-h"><h2>账号</h2><span className="sub">粉丝 · 较昨天 · 昨天的播放 / 阅读</span></div>;
  if (p.d.platforms.error) return <section>{head}<p className="hm-note hot" role="alert">读不出你勾了哪些运营平台：{p.d.platforms.error} · <a href="#/settings?tab=platforms">去设置看</a></p></section>;
  if (!p.shown) return <section>{head}<p className="hm-note">读取中</p></section>;
  if (!p.shown.main.length && !p.shown.later.length) return <section>{head}<p className="hm-note">还没勾运营平台，勾了才有账号格 · <a href="#/settings?tab=platforms">去设置勾平台 →</a></p></section>;
  const pull = p.d.pull.data?.platforms ?? null;
  const cells = accountCells(p.shown.main, pull, p.d.pull.error, platformLabel);
  const later = accountCells(p.shown.later, pull, p.d.pull.error, platformLabel);
  return <section>
    {head}
    {cells.length > 0 && <div className="acct" style={{ gridTemplateColumns: `repeat(${Math.max(cells.length, 3)}, 1fr)` }}>
      {cells.map((c) => <AccountCellView key={c.platform} c={c} account={pull?.find((x) => x.platform === c.platform)?.account} reload={p.reload} />)}
    </div>}
    {later.length > 0 && <div className="later">
      {later.map((c) => <span key={c.platform}><PGlyph id={c.platform} />{c.label}</span>)}
      <span>{later.every((c) => c.state.kind === "unsupported") ? "还不能自动回流" : "回流状态见设置"}</span>
    </div>}
  </section>;
}

const FLAT = <svg className="spark" viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="24" x2="120" y2="24" stroke="#D3CFC3" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" /></svg>;

/** 账号快照那几行：没有的数不编，只说为什么没有 */
function AccountNumbersView({ account }: { account: AccountTileData | { error: string } | null | undefined }) {
  const a = accountNumbers(account, Date.now());
  if (a.kind === "none") return <><div className="big ph">—<small>粉丝</small></div><div className="delta">{a.text}</div>{FLAT}</>;
  const pts = sparkPoints(a.series);
  return <>
    <div className={a.followers === null ? "big ph" : "big"}>{a.followers === null ? "—" : a.followers.toLocaleString("zh-CN")}<small>粉丝</small></div>
    <div className={`delta ${a.deltaTone}`}>{a.deltaText} · {a.viewsText}</div>
    {pts ? <svg className="spark" viewBox="0 0 120 32" preserveAspectRatio="none" role="img" aria-label={`近 ${a.series.length} 天的每天${a.viewsText.includes("阅读") ? "阅读" : "播放"}`}><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg> : FLAT}
    {a.staleText && <div className="y stale">{a.staleText}</div>}
  </>;
}

function AccountCellView({ c, account, reload }: { c: AccountCell; account: AccountTileData | { error: string } | null | undefined; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const name = <div className="p-name"><PGlyph id={c.platform} />{c.label}</div>;
  const s = c.state;
  if (s.kind === "login") {
    const retry = async () => {
      setBusy(true);
      try { const r = await invoke("flywheel:pull_now", { platform: c.platform }); toast(retryMessage(c.label, r)); } finally { setBusy(false); await reload(); }
    };
    return <div className="alert-cell">{name}
      <div className="big-msg"><i />要重新登录</div>
      <p>{s.hint}{s.lastSuccessAt ? ` 上次成功 ${shortTime(s.lastSuccessAt)}，之后的数据没抓到。` : ""}</p>
      <button className="go" disabled={busy} onClick={() => void retry()}>{busy ? "抓取中…" : "登录好了，重抓 →"}</button>
      {/* 在 ego lite 里开（回流用它的登录态），不开默认浏览器 */}
      <button className="go-2" onClick={() => void openInEgo(c.platform)}>在 ego lite 打开{c.label}后台</button>
    </div>;
  }
  if (s.kind === "problem") return <div className="alert-cell">{name}<div className="big-msg"><i />回流没抓成</div><p>{s.text}</p><a className="go-2" href="#/settings?tab=data">去设置看回流 →</a></div>;
  if (s.kind === "unknown") return <div className="alert-cell">{name}<div className="big-msg muted">回流状态读不出来</div><p>{s.error}</p></div>;
  const foot: Record<string, React.ReactNode> = {
    ok: <>回流正常{s.kind === "ok" && s.at ? <> · 上次 <b>{shortTime(s.at)}</b></> : ""}</>,
    off: <>自动回流没开 · <a href="#/settings?tab=data">去打开</a></>,
    never: <>回流已开，还没抓过</>,
    running: <>正在抓…</>,
    unsupported: <>还不能自动回流</>,
  };
  return <div>{name}<AccountNumbersView account={account} /><div className="y">{foot[s.kind]}</div></div>;
}

// ── 刚发那条 ───────────────────────────────────────────────────────────────

function LatestSection(p: { latest: Latest | null; error: string | null; loading: boolean; upcoming: DataPageData["upcoming"]; openData: () => void }) {
  const head = <div className="sec-h"><h2>刚发那条</h2><span className="sub">跟这个平台平时比</span></div>;
  if (p.error) return <section>{head}<p className="hm-note hot" role="alert">数据读不出来：{p.error}</p></section>;
  if (p.loading) return <section>{head}<p className="hm-note">读取中</p></section>;
  const next = p.upcoming ? `下一条：${p.upcoming.title}${p.upcoming.time ? ` · ${shortTime(p.upcoming.time)}` : ""}` : "";
  if (!p.latest) return <section>{head}<div className="lede-empty"><p>还没有发出去、回流到数据的作品。</p>{next && <p className="muted">{next}，公开后第 1、3、7 天自动对比。</p>}</div></section>;
  const l = p.latest;
  const pending = l.lines.filter((x) => x.kind === "pending");
  return <section>
    {head}
    <div className="lede-meta">{l.day ? `${l.day.slice(5)} 发出` : "发出日期不明"}{l.after !== null ? ` · 数据截至发布后第 ${l.after} 天` : ""}</div>
    <div className="lede-title">{l.title}</div>
    {l.lines.filter((x) => x.kind === "data").map((x) => <PerfRow key={x.platform} line={x} />)}
    {!l.lines.some((x) => x.kind === "data") && <p className="hm-note">各平台数据还没回来（发出不满 24 小时，或回流还没抓到），先不比。</p>}
    <div className="foot">
      <span>{pending.length ? `${pending.map((x) => platformLabel(x.platform)).join("、")}的数据还没回来` : basisNote(l.lines)}</span>
      <button className="lnk" onClick={p.openData}>全部作品 →</button>
    </div>
  </section>;
}

/** 「平时」的口径一句话说清：同龄比 / 全量中位数（同龄样本不够） */
function basisNote(lines: PerfLine[]): string {
  const data = lines.filter((x) => x.kind === "data");
  if (data.length && data.every((x) => x.basis === "same_age")) return "平时 = 别的作品发出同样时长时的播放中位数";
  if (data.some((x) => x.basis === "same_age")) return "能同龄比的按同龄比，其余按全部作品的播放中位数";
  return "平时 = 这个平台所有作品的播放中位数（同龄数据不够）";
}

function PerfRow({ line }: { line: PerfLine }) {
  const v = line.verdict!;
  return <div className="perf">
    <div className="p-name"><PGlyph id={line.platform} />{platformLabel(line.platform)}</div>
    <div>
      <div className="perf-top"><span className="perf-n">{fmtViews(line.views!)}</span><span className="perf-unit">播放</span>
        <span className={v.tone === "up" ? "ratio up" : v.tone === "down" ? "ratio-low" : "ratio-flat"}>{v.text}</span></div>
      <div className="bar"><i style={{ width: `${line.barPct}%` }} />{line.basePct != null && <b style={{ left: `${line.basePct}%` }}><em>平时</em></b>}</div>
      <div className="y"><span>{!line.baseline ? "平时样本不够 3 条" : line.basis === "same_age" ? `别的作品发出约 ${line.ageHours} 小时时约 ${fmtViews(line.baseline)}` : `平时约 ${fmtViews(line.baseline)}（同龄样本不够，按全部作品比）`}</span></div>
    </div>
  </div>;
}

// ── 让 AI 看看 ─────────────────────────────────────────────────────────────

const ASK: Array<{ kind: AskKind; title: string; desc: string; icon: React.ReactNode }> = [
  { kind: "insights", title: "账号洞察", desc: "近 30 天：哪类题在涨，哪类在掉", icon: <path d="M2 13.5h12M4 11V7M8 11V3.5M12 11V6" /> },
  { kind: "meeting", title: "开排期会", desc: "从选题和在写的稿里，排下周的片单", icon: <><rect x="2" y="3" width="12" height="11" rx="1.5" /><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" /></> },
  { kind: "retro", title: "复盘刚发那条", desc: "各平台跟平时比，好在哪、差在哪", icon: <><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.7 0 3.2.8 4.2 2" /><path d="M12.5 1.5v3h-3" /></> },
];

function AskSection({ latest }: { latest: Latest | null }) {
  const w = useWriters();
  const blocked = askBlocked(w);
  const [busy, setBusy] = useState<AskKind | null>(null);
  const [out, setOut] = useState<Partial<Record<AskKind, AskOutcome>>>({});
  const who = w?.defaultHost === "claude" ? "本机 Claude" : w?.defaultHost === "codex" ? "Codex" : w?.defaultHost === "workbuddy" ? "WorkBuddy" : w?.chief ? "右边的总编辑" : "本机 AI";
  const run = async (kind: AskKind) => {
    if (busy) return;
    if (blocked) { window.location.hash = SETTINGS_HREF; return; }
    setBusy(kind);
    try {
      const r = await askAI(kind, kind === "retro" ? latest?.contentId : null);
      if (!r.ok) {
        const go = r.body?.code === "no_writer";
        setOut((o) => ({ ...o, [kind]: { tone: "fail", text: go ? "没接本机 AI，也没配模型钥匙：先去设置接一个" : r.error } }));
        return;
      }
      const d = r.data;
      if (d.host === "chief") window.dispatchEvent(new CustomEvent(CHIEF_PREFILL_EVENT, { detail: { text: d.prompt } }));
      let copied = !d.paste;
      if (d.paste) { try { await navigator.clipboard.writeText(d.prompt); copied = true; } catch { copied = false; } }
      const o = askOutcome(d, copied);
      setOut((x) => ({ ...x, [kind]: o }));
      if (!copied) await confirmDialog({ title: "没能写进剪贴板", body: `请手动复制下面这段，发给 ${d.label}：\n\n${d.prompt}`, confirmLabel: "知道了" });
    } finally { setBusy(null); }
  };
  return <section className="ai">
    <div className="sec-h"><h2>让 AI 看看</h2><span className="sub">在{/[a-zA-Z]$/.test(who) ? `${who} ` : who}里开一个填好指令的新会话，分析不在网页里跑</span></div>
    {blocked && <p className="hm-note hot" role="status">{blocked} · <a href={SETTINGS_HREF}>去设置 →</a></p>}
    <div className="ai-grid">
      {ASK.map((a) => {
        const noLatest = a.kind === "retro" && !latest?.contentId;
        const o = out[a.kind];
        return <button key={a.kind} className="ai-card" disabled={busy !== null || noLatest} onClick={() => void run(a.kind)}>
          <span className="ic"><svg viewBox="0 0 16 16">{a.icon}</svg></span>
          <span className="t">{a.title}<span>{busy === a.kind ? "…" : "↗"}</span></span>
          <span className={"d" + (o ? ` out-${o.tone}` : "")} role={o ? "status" : undefined}>
            {noLatest ? (latest ? "刚发那条还没关联到稿件，复盘不了" : "还没有发出去的作品可复盘") : o ? o.text : a.desc}
          </span>
        </button>;
      })}
    </div>
  </section>;
}

// ── 管线一览 ───────────────────────────────────────────────────────────────

function Glance(p: { data: PipelineData | null; error: string | null; open: () => void }) {
  const head = <div className="sec-h"><h2>管线一览</h2><span className="sub">一个主题一张卡</span><button className="r hm-btn" onClick={p.open}>打开内容管线 →</button></div>;
  if (p.error) return <section className="pipe">{head}<p className="hm-note hot" role="alert">内容管线读不出来：{p.error}</p></section>;
  if (!p.data) return <section className="pipe">{head}<p className="hm-note">读取中</p></section>;
  return <section className="pipe">
    {head}
    <div className="stages">
      {glanceOf(p.data).map((g) => <button key={g.col} onClick={p.open}>
        <span className="st-l"><StagePie f={COLUMN_PROGRESS[g.col]} />{g.col}</span>
        <span className={"st-n" + (g.n ? "" : " zero")}>{g.n}</span>
        <span className={"st-w" + (g.hot ? "" : " q")}>{g.hint}</span>
      </button>)}
    </div>
  </section>;
}
