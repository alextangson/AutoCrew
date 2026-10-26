/**
 * 稿件页顶部「现在轮到你 / AI 在做」卡（spec 2026-10-12 D），取代原来的状态下拉。
 * 卡里只有一个主按钮；往回退和其余合法流转收进右上角「更多」，都要二次确认。
 * 所有动作走同一个防重复执行器：点下变灰直到返回，失败原因常驻在卡里 + 重试。
 * 视频稿的进度单独刷新（key 随状态与存盘时刻变），不碰正在编辑的正文。
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "../transport";
import { confirmDialog, openDialog, toast } from "../ui";
import type { AllowedTransition } from "../lib";
import { decide, loadCard, reopenScript, type CardPanelData } from "./board-api";
import { decideItem, inboxHref } from "./review/review-api";
import { useGuardedAction, type ActionResult } from "./guarded-action";
import { derivedModel, legacyModel, type CardModel, type Confirm, type Run } from "./stage-card-model";
import { publishAsk, showChips, targetDecision, type PublishTarget, type TargetAction } from "./publish-targets";
import { PlatformChips } from "./PlatformChips";
import { useDesk } from "./use-desk";
import { RailLine } from "./ProgressRail";
import { withTopbarFinalize } from "./finalize-button";
import { isHttpUrl, platformLabel } from "../lib";

export interface StageCardProps {
  content: { id: string; title: string; status: string; platform: string; body: string; updatedAt: string };
  transitions: AllowedTransition[];
  isVideo: boolean;
  /** 有没保存的改动：认稿 / 推进要等存盘（认的必须是你看过并保存的那份） */
  dirty: boolean;
  reload: () => Promise<void>;
  /** 推导出的阶段（看板同一份 explain）：编辑器顶栏的小标签用它，不用原始 status */
  onStage?: (stage: string | null) => void;
  /** 写作台自己有标题输入框，卡上就不再重复标题 */
  showTitle?: boolean;
  /** 发布表模式（吸收 14）：平台标签只显示状态、不带动作，动作都在表的行里；卡上没事时写读模型给的一句 */
  deskMode?: boolean;
  /** 顶栏有「定稿」按钮：卡上的认稿主按钮让位，「更多」里给「撤回定稿」 */
  hideApprove?: boolean;
  /** 顶栏里留的位置：不用你操作时（AI 在做 / 没事），卡收成顶栏一行挂到这里；轮到你才出整张卡 */
  inlineSlot?: HTMLElement | null;
}

const OK: ActionResult = { ok: true };
const res = (r: { ok: boolean; error?: string }): ActionResult => (r.ok ? OK : { ok: false, error: r.error ?? "没成功，刷新再试" });

/** 正文的 sha256（十六进制），和服务端 bodyHash 同一算法 */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 本体视频稿在发布台读模型里已经有卡片数据（一个刷新协调器，吸收 8）；没有时自己读 */
function useCard(id: string, refreshKey: string, onStage?: (s: string | null) => void) {
  const ext = useDesk();
  const [data, setData] = useState<CardPanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const r = await loadCard(id);
    if (r.ok) { setData(r.data); setError(null); onStage?.(r.data.stage ?? r.data.column); } else setError(r.error);
  }, [id, onStage]);
  // 读模型读不出来时卡片退回自己读（卡片接口还在，主按钮照样能用）
  const own = !ext || (Boolean(ext.error) && !ext.data);
  useEffect(() => { if (own) void refresh(); }, [refresh, refreshKey, own]);
  const extCard = ext?.data?.card ?? null;
  useEffect(() => { if (extCard) onStage?.(extCard.stage ?? extCard.column); }, [extCard, onStage]);
  if (ext && !own) return { data: extCard, error: extCard ? null : ext.error, refresh: ext.refresh, desk: ext.data?.active ? ext.data.desk : null };
  return { data, error, refresh, desk: null };
}

export function StageCard(p: StageCardProps) {
  const c = p.content;
  const { data, error, refresh, desk } = useCard(c.id, `${c.status}@${c.updatedAt}`, p.onStage);
  const g = useGuardedAction();
  if (p.isVideo && !data) return <section className="stage-card is-loading" aria-busy={!error}>
    {error ? <p className="stage-card-error" role="alert">进度读不出来：{error} <button className="bcard-link" onClick={() => void refresh()}>重试</button></p> : <p className="stage-card-head">读取中…</p>}
  </section>;
  const idle = Math.floor((Date.now() - Date.parse(c.updatedAt)) / 3600_000);
  const raw: CardModel = data?.active ? derivedModel(data, p.transitions, Number.isFinite(idle) ? idle : null) : legacyModel(c.status, p.transitions, p.isVideo);
  const base = p.hideApprove ? withTopbarFinalize(raw, data?.status ?? c.status) : raw;
  // 已发布、没事可做：「还有 N 天公开」/「公开第 N 天：比你抖音的中位数高 X%」（spec §2 / 吸收 1）
  const model: CardModel = p.deskMode && base.tone === "none" && desk?.summary ? { ...base, text: desk.summary } : base;
  const exec = (label: string, run: Run, confirm?: Confirm) => g.run(label, async () => {
    if (confirm && !(await confirmDialog({ ...confirm, confirmLabel: label }))) return OK;
    const r = await perform(run, p, data);
    if (r.ok) await Promise.all([refresh(), p.reload()]);
    return r;
  });
  const targetAct = (t: PublishTarget, a: TargetAction) => void exec(`${a}:${t.platform}`, { kind: "target", target: t, action: a });
  const pr = model.primary;
  const blocked = pr?.blockedReason ?? (p.dirty && pr && needsSaved(pr.run) ? "先保存修改，再进入下一阶段" : undefined);
  const stage = data?.stage ?? data?.column ?? null;
  const chips = Boolean(data && showChips(data.targets, data.stage ?? data.column));
  // 收成一行的条件：没有主按钮、没有要你确认的平台标签、没有失败原因要常驻
  const inline = p.inlineSlot && !p.deskMode && model.tone !== "you" && !pr && !chips && !g.error && !model.notes.length;
  if (inline) {
    const inlineText = model.text ? `${model.head}：${model.text}` : model.head;
    const line = <span className="stage-inline">
      <span className="stage-inline-head" title={inlineText}>{inlineText}</span>
      <MoreMenu model={model} busy={g.busy} dirty={p.dirty} exec={exec} />
    </span>;
    const rest = p.showTitle !== false || (desk && !p.deskMode);
    return <>
      {createPortal(line, p.inlineSlot!)}
      {rest && <div className="stage-card-wrap">
        {p.showTitle !== false && <h1 className="stage-card-title">{c.title || "无标题"}</h1>}
        {desk && <RailLine desk={desk} />}
      </div>}
    </>;
  }
  return <div className="stage-card-wrap">
    {!p.deskMode && <p className="stage-card-meta">{platformLabel(c.platform)}{stage ? ` · ${stage}` : ""}</p>}
    {p.showTitle !== false && <h1 className="stage-card-title">{c.title || "无标题"}</h1>}
    {desk && !p.deskMode && <RailLine desk={desk} />}
    <section className={`stage-card is-${model.tone}`} aria-label="下一步">
    <div className="stage-card-top">
      <span className="stage-card-head">{model.head}</span>
      <MoreMenu model={model} busy={g.busy} dirty={p.dirty} exec={exec} />
    </div>
    {model.text && <p className="stage-card-text">{model.text}</p>}
    {model.notes.map((n) => <p key={n} className="stage-card-note">{n}</p>)}
    {chips && data && <PlatformChips targets={data.targets!} busy={g.busy}
      onAction={data.active && !p.deskMode ? targetAct : undefined} only={["待发布", "已发布"].includes(data.stage ?? data.column ?? "") ? undefined : RECEIPT_ONLY} />}
    {pr && <div className="stage-card-row">
      <button className="primary" disabled={g.busy || Boolean(blocked)} onClick={() => void exec(pr.label, pr.run, pr.confirm)}>{g.busy ? "处理中…" : pr.label}</button>
      {(blocked ?? pr.note) && <span className="stage-card-why">{blocked ?? pr.note}</span>}
    </div>}
    {g.error && <p className="stage-card-error" role="alert">没做成：{g.error} <button className="bcard-link" disabled={g.busy} onClick={() => void g.retry()}>重试</button></p>}
  </section></div>;
}

/** 没到发布段：AI 报的发了（核不了）照样能在卡上确认（Codex 复审 P2）；纠正在「更多」 */
const RECEIPT_ONLY: ReadonlySet<TargetAction> = new Set(["confirm_receipt"]);

const needsSaved = (run: Run) => run.kind === "transition" || (run.kind === "next" && run.action === "approve_script");

function MoreMenu(p: { model: CardModel; busy: boolean; dirty: boolean; exec: (label: string, run: Run, confirm?: Confirm) => Promise<unknown> }) {
  if (!p.model.more.length) return null;
  return <details className="stage-card-more">
    <summary aria-label="更多操作">更多</summary>
    <div className="stage-card-menu">
      {p.model.more.map((m) => {
        const why = m.blockedReason ?? (p.dirty && needsSaved(m.run) ? "先保存修改" : undefined);
        return <button key={m.key} disabled={p.busy || Boolean(why)} onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); void p.exec(m.label, m.run, m.confirm); }}>
          <span>{m.label}</span>{why && <small>{why}</small>}
        </button>;
      })}
    </div>
  </details>;
}

async function perform(run: Run, p: StageCardProps, d: CardPanelData | null): Promise<ActionResult> {
  const c = p.content;
  if (run.kind === "transition") {
    if (p.dirty) return { ok: false, error: "先保存修改，再进入下一阶段" };
    const r = await invoke("content:transition", { id: c.id, target_status: run.status, from_status: c.status,
      ...(run.status === "approved" ? { expected_body_hash: await sha256Hex(c.body) } : {}) });
    return res(r);
  }
  if (run.kind === "next") {
    if (run.action === "open_cut" || run.action === "open_cover") { window.location.hash = inboxHref(c.id, run.action === "open_cut" ? ["cut_review", "sliver"] : ["cover_pick"]); return OK; }
    if (run.action === "approve_script") {
      if (p.dirty) return { ok: false, error: "先保存修改，再认稿" };
      if (!d?.draft_item) return { ok: false, error: "稿子刚改过，重新看一眼" };
      // 认的是编辑器里显示并保存的那份正文：别的会话在中间改过，服务端按哈希拒
      return res(await decideItem({ content_id: c.id, item_id: d.draft_item.item_id, gen: d.draft_item.gen, action: "approve_script", expected_body_hash: await sha256Hex(c.body) }));
    }
    return { ok: false, error: "这一步要按平台标：在下面的平台标签上点" };
  }
  if (run.kind === "decide") return res(await decide(c.id, run.action, { ...run.params, ...(d?.round ? { round: d.round } : {}) }));
  if (run.kind === "reopen") return res(await reopenScript(c.id, d?.round ?? 1));
  return performTarget(run.target, run.action, c, d?.round ?? 1);
}

export async function performTarget(t: PublishTarget, a: TargetAction, c: StageCardProps["content"], round: number): Promise<ActionResult> {
  if (a === "prepare_publish" || a === "resubmit") {
    try { await navigator.clipboard.writeText(publishAsk(c.id, c.title, t, a)); } catch { return { ok: false, error: "复制没成功：浏览器不让写剪贴板" }; }
    toast("已复制，贴给发布对话（Codex / Claude）");
    return OK;
  }
  const cmd = targetDecision(t, a, round);
  if (!cmd) return { ok: false, error: "这条回执刷新后再确认" };
  if (a === "i_published") {
    // 标已发布要明确确认（吸收 14）：说清是哪个平台，链接选填
    const v = await openDialog({ title: `在${platformLabel(t.platform)}发了？`, body: "记成你标的已发布。点错了可以在「更多」里纠正。", fields: [{ key: "url", label: "作品链接（选填）", placeholder: "https://…" }], confirmLabel: "记下" });
    if (!v) return OK;
    const url = v.url.trim();
    if (url && !isHttpUrl(url)) return { ok: false, error: "链接要是 http(s) 开头的地址" };
    if (url) cmd.params.url = url;
  }
  return res(await decide(c.id, cmd.action, cmd.params));
}
