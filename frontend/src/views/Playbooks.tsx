/**
 * 写作手册（spec 2026-10-13 §5、§6.3）：「AI 照着什么干活」的总入口，两个标签——
 * 体裁手册：5 本的当前全文、版本历史、每版统计、待批提案（改前改后）、回滚；
 * 团队技能：skills/ 下每份 SKILL.md（原日志页的标签）。
 * 不做在线编辑框：改手册只走对话和提案。批 / 回滚只走浏览器会话路由 /api/playbooks。
 */
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import { authedFetch } from "../transport";
import { openDialog, toast } from "../ui";
import { dateLabel } from "../time-format";
import { TeamSkills } from "./TeamSkills";
import {
  newRequestId, publishLine, roundsLine, statsFor, updatedAt, versionLabel,
  type DiffHunk, type PlaybooksData, type PlaybookProposalView, type PlaybookVersion, type PlaybookView,
} from "./playbooks-lib";

type Json = { ok: boolean; error?: string; code?: string } & Record<string, unknown>;

async function call(path: string, body?: unknown): Promise<Json> {
  try {
    const r = await authedFetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as Json;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function Playbooks() {
  const [tab, setTab] = useState<"playbooks" | "skills">("playbooks");
  return (
    <div className="logs">
      <div className="board-bar">
        <span className="board-title serif">写作手册</span>
        <button className={tab === "playbooks" ? "nav-on" : ""} onClick={() => setTab("playbooks")}>体裁手册</button>
        <button className={tab === "skills" ? "nav-on" : ""} onClick={() => setTab("skills")}>团队技能</button>
      </div>
      {tab === "playbooks" ? <PlaybookTab /> : <TeamSkills />}
    </div>
  );
}

function PlaybookTab() {
  const [data, setData] = useState<PlaybooksData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const load = async () => {
    const r = await call("/api/playbooks");
    if (!r.ok) return setError(r.error ?? "手册读不了");
    setError(null);
    setData(r as unknown as PlaybooksData);
  };
  useEffect(() => { void load(); }, []);
  if (error) return <p className="log-bad">手册读不了：{error}</p>;
  if (!data) return <p className="muted">读取中…</p>;
  const open = data.playbooks.find((p) => p.id === openId) ?? null;
  return (
    <>
      <p className="muted">写稿时选立意就选体裁，AI 按那本手册写。改手册只走对话里的提案，批了才生成新版本；回滚也是生成新版本，历史不删。{data.stats.unattributed ? `另有 ${data.stats.unattributed} 篇稿没记手册版本（未归版本），不进统计。` : ""}</p>
      {data.playbooks.map((p) => (
        <div key={p.id} className="row" onClick={() => setOpenId(openId === p.id ? null : p.id)}>
          <span className="row-title">{p.name}</span>
          <span className="mono muted">第 {p.current} 版 · {dateLabel(updatedAt(p))}</span>
          <span className={p.proposals.length ? "mono pri" : "mono muted"}>{p.proposals.length ? `${p.proposals.length} 条待批` : "无待批"}</span>
        </div>
      ))}
      {open && <PlaybookDetail key={open.id} book={open} data={data} reload={load} />}
    </>
  );
}

function PlaybookDetail(props: { book: PlaybookView; data: PlaybooksData; reload: () => Promise<void> }) {
  const { book } = props;
  return (
    <div className="ed-section">
      <h3 className="serif">{book.name} · 第 {book.current} 版</h3>
      {book.proposals.map((p) => <ProposalCard key={p.id} book={book} proposal={p} reload={props.reload} />)}
      <h4>版本历史</h4>
      {[...book.versions].reverse().map((v) => <VersionRow key={v.version} book={book} v={v} data={props.data} reload={props.reload} />)}
      <h4>当前全文</h4>
      <div className="md-preview skill-doc-md"><ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{book.text}</ReactMarkdown></div>
    </div>
  );
}

/** 两种对比共用：提案对它的 based_on 版本、选中的一版对当前版本 */
export function DiffView(props: { hunks: DiffHunk[]; beforeLabel: string; afterLabel: string }) {
  if (!props.hunks.length) return <p className="muted">没有改动</p>;
  return (
    <div>
      {props.hunks.map((h, i) => (
        <div key={i} className="log-step">
          <div className="mono muted">{props.beforeLabel}</div>
          {h.before.length ? h.before.map((t, j) => <pre key={j} className="log-pre">{t}</pre>) : <p className="muted">（无，新增）</p>}
          <div className="mono muted">{props.afterLabel}</div>
          {h.after.length ? h.after.map((t, j) => <pre key={j} className="log-pre">{t}</pre>) : <p className="muted">（删掉）</p>}
        </div>
      ))}
    </div>
  );
}

function ProposalCard(props: { book: PlaybookView; proposal: PlaybookProposalView; reload: () => Promise<void> }) {
  const { proposal: p } = props;
  const [busy, setBusy] = useState(false);
  const decide = async (op: "approve" | "reject") => {
    setBusy(true);
    const r = await call("/api/playbooks", { op, id: props.book.id, proposal_id: p.id, gen: p.gen, event_id: newRequestId() });
    setBusy(false);
    if (!r.ok) toast(r.code === "stale" ? `这份提案过期了：${r.error ?? ""}` : (r.error ?? "没批成"));
    else toast(op === "approve" ? `已批准，手册更新到第 ${String(r.version)} 版` : "已否决，同一段以后不再提");
    await props.reload();
  };
  return (
    <div className="log-run">
      <p><b>待批提案</b> · 基于第 {p.based_on} 版 · {p.kind === "lesson" ? "写稿意见补充" : "整本修订"}{p.origin ? ` · 来自稿件 ${p.origin.content_id} 第 ${p.origin.version} 版` : ""}</p>
      {p.reason && <p className="muted">理由：{p.reason}</p>}
      {p.founder_words && <p className="muted">你的原话：「{p.founder_words}」</p>}
      <DiffView hunks={p.diff} beforeLabel={`改前（第 ${p.based_on} 版）`} afterLabel="改后" />
      <button disabled={busy} onClick={() => void decide("approve")}>批准</button>
      <button disabled={busy} onClick={() => void decide("reject")}>不要</button>
    </div>
  );
}

function VersionRow(props: { book: PlaybookView; v: PlaybookVersion; data: PlaybooksData; reload: () => Promise<void> }) {
  const { book, v } = props;
  const [diff, setDiff] = useState<DiffHunk[] | null>(null);
  const stats = statsFor(props.data, book.id, v.version);
  const compare = async () => {
    if (diff) return setDiff(null);
    const r = await call(`/api/playbooks/version?id=${encodeURIComponent(book.id)}&version=${v.version}`);
    if (!r.ok) return toast(r.error ?? "读不了这一版");
    setDiff(r.diff as DiffHunk[]);
  };
  const rollback = async () => {
    const got = await openDialog({ title: `回滚到第 ${v.version} 版？`, body: "会把这一版的内容存成新版本，历史都保留；之后新出的立意用它，已经在写的稿不换。挂在当前版本上的待批提案会作废。",
      fields: [{ key: "words", label: "为什么回滚（会记下来，可不填）", placeholder: "比如：新版本改稿轮数更多" }], confirmLabel: "回滚" });
    if (!got) return;
    const r = await call("/api/playbooks", { op: "rollback", id: book.id, to_version: v.version, expected_current_version: book.current, request_id: newRequestId(), founder_words: got.words?.trim() || undefined });
    toast(r.ok ? `已回滚，生成第 ${String(r.version)} 版` : r.code === "stale" ? `手册刚变过，刷新后再看：${r.error ?? ""}` : (r.error ?? "没回滚成"));
    await props.reload();
  };
  return (
    <div className="log-step">
      <div className="row">
        <span className="row-title">{versionLabel(v)}{v.version === book.current ? "（当前）" : ""}</span>
        <span className="mono muted">{dateLabel(v.at)}</span>
        {v.version !== book.current && <button onClick={() => void compare()}>{diff ? "收起对比" : "和当前版对比"}</button>}
        {v.version !== book.current && <button onClick={() => void rollback()}>回滚到这一版</button>}
      </div>
      {(v.founder_words || v.reason) && <p className="muted">{v.founder_words ? `原话：「${v.founder_words}」` : ""}{v.reason ? ` 理由：${v.reason}` : ""}</p>}
      <p className="muted">{roundsLine(stats)}</p>
      <p className="muted">{publishLine(stats)}</p>
      {diff && <DiffView hunks={diff} beforeLabel={`第 ${v.version} 版`} afterLabel={`当前（第 ${book.current} 版）`} />}
    </div>
  );
}
