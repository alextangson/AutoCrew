/**
 * 稿件页「现在轮到你 / AI 在做」那张卡（spec 2026-10-12 D / 吸收 6、9、14），纯函数。
 *
 * 三种适配器：
 * - 本体启用的视频稿 → 推导的下一步（card-next，走「等你拍板」/ 决定，不推 status）；
 * - 影子 / 被排除的视频稿、文字稿 → 旧流转：主按钮 = 合法流转里最靠前的那个（stage-default），其余合法流转进「更多」。
 * 「更多」里的往回退逐个对应现有命令，每个都写清后果、要二次确认；不删任何现有恢复路径。
 */
import { platformLabel, VARIANT_STATUS, type AllowedTransition } from "../lib";
import type { CardPanelData } from "./board-api";
import { UNDO } from "./board-columns";
import { nextStep, type NextAction } from "./card-next";
import { defaultAdvanceTarget } from "./stage-default";
import { ACTION_LABEL, type PublishTarget, type TargetAction } from "./publish-targets";

const ACTION_LABELS: Record<string, string> = {
  topic_saved: "回到选题", drafting: "开始写作", needs_evidence: "补充证据", draft_ready: "回到文案", reviewing: "让 AI 再审一遍",
  revision: "返回修订", approved: "进入制作", cover_pending: "去封面", publish_ready: "准备发布", publishing: "标记发布中",
  published: "标记已发布", archived: "归档稿件",
};

export function actionFor(status: string, currentStatus: string, isVideo = false): string {
  if (status === "draft_ready" && ["topic_saved", "drafting", "needs_evidence"].includes(currentStatus)) return "完成初稿";
  if (status === "approved") return isVideo ? "稿子没问题，进入制作" : "稿子没问题";
  return ACTION_LABELS[status] ?? (VARIANT_STATUS[status] ?? status);
}

export type Run =
  | { kind: "transition"; status: string }
  | { kind: "next"; action: NextAction }
  | { kind: "target"; target: PublishTarget; action: TargetAction }
  | { kind: "decide"; action: string; params: Record<string, unknown> }
  | { kind: "reopen" };
export interface Confirm { title: string; body: string; danger?: boolean }
export interface Primary { label: string; run: Run; blockedReason?: string; confirm?: Confirm; note?: string }
export interface MoreItem { key: string; label: string; run: Run; blockedReason?: string; confirm?: Confirm }
export interface CardModel { tone: "you" | "ai" | "none"; head: string; text: string; primary: Primary | null; more: MoreItem[]; notes: string[] }

const RISKY: Record<string, Confirm> = {
  published: { title: "标记已发布？", body: "请确认这篇稿件已经在平台发布。此操作只记录发布状态。" },
  publishing: { title: "标记发布中？", body: "将稿件标记为发布中。平台发布仍需在发布工作台继续操作。" },
  archived: { title: "归档稿件？", body: "归档后这篇稿件会离开当前管线，内容与版本记录会保留。", danger: true },
  revision: { title: "返回修订？", body: "稿子回到修订，改完要重新走审稿和认稿。", danger: true },
};

const transitionItem = (t: AllowedTransition, current: string, isVideo: boolean): MoreItem => ({
  key: `t:${t.status}`, label: actionFor(t.status, current, isVideo), run: { kind: "transition", status: t.status },
  ...(t.blockedReason ? { blockedReason: t.blockedReason } : {}), ...(RISKY[t.status] ? { confirm: RISKY[t.status] } : {}),
});

/** 旧流转：主按钮 = 前进方向（写好 / 审过的稿默认认稿），其余合法流转全进「更多」 */
export function legacyModel(status: string, transitions: AllowedTransition[], isVideo: boolean): CardModel {
  const list = transitions.filter((t) => t.status !== "editing"); // 剪辑中只能由交接进入
  const approve = ["draft_ready", "reviewing"].includes(status) ? list.find((t) => t.status === "approved" && !t.blockedReason) : undefined;
  const target = approve?.status ?? defaultAdvanceTarget(status, list);
  const chosen = list.find((t) => t.status === target);
  const primary = chosen ? (({ key: _k, ...rest }) => rest)(transitionItem(chosen, status, isVideo)) : null;
  const more = list.filter((t) => t !== chosen).map((t) => transitionItem(t, status, isVideo));
  const text = primary ? `现在在「${VARIANT_STATUS[status] ?? status}」，下一步：${primary.label}` : "这一阶段没有可走的下一步";
  return { tone: primary ? "you" : "none", head: primary ? "现在轮到你" : "没有要你做的", text, primary, more, notes: [] };
}

/** 已发布 / 待发布之后各平台还剩的事：被驳回 > 待核 > 未发 */
function targetPrimary(targets: PublishTarget[]): Primary | null {
  for (const [state, action] of [["被驳回", "resubmit"], ["待核", "confirm_receipt"], ["未发", "i_published"]] as const) {
    const t = targets.find((x) => x.state === state && x.actions.includes(action));
    if (t) return { label: `${ACTION_LABEL[action]}：${platformLabel(t.platform)}`, run: { kind: "target", target: t, action } };
  }
  return null;
}

function aiHead(claim: CardPanelData["claim"], idleHours: number | null): string {
  if (claim?.live) return `AI 在做 · ${claim.host}`;
  const h = claim?.idle_hours ?? idleHours;
  return h !== null && h >= 1 ? `AI 已 ${h} 小时没动静` : "AI 在做";
}

/** 本体视频稿：推导的下一步 + 平台剩下的事 + 「更多」里的往回退 */
export function derivedModel(d: CardPanelData, transitions: AllowedTransition[], idleHours: number | null): CardModel {
  const n = nextStep(d);
  const targets = d.targets ?? [];
  const col = d.stage ?? d.column;
  const notes = [...(d.no_script_approval ? ["没走认稿就发了（只提醒，不挡）"] : []), ...(d.alerts ?? [])];
  let primary: Primary | null = null;
  let text = n?.text ?? "";
  if (d.recovery) {
    // 恢复动作优先：文件不见了 / 登记没写成时，别的都发不了
    primary = d.recovery.kind === "files_missing"
      ? { label: "文件找回来了，重新核对", run: { kind: "decide", action: "recheck_files", params: {} } }
      : { label: "重试登记", run: { kind: "decide", action: "retry_registration", params: {} } };
    text = d.recovery.kind === "files_missing" ? "登记的文件不见了：放回原处后点这里重新核对" : `登记没写成：${d.recovery.reason}`;
  } else if (col === "待发布" || col === "已发布") {
    primary = targetPrimary(targets);
    const bad = targets.find((t) => t.state === "被驳回");
    if (bad) {
      text = `${platformLabel(bad.platform)}没过审${bad.reason ? `：${bad.reason}` : ""}`;
      // 同一句被驳回已经是卡的正文，红字里不再重复
      const dup = `${platformLabel(bad.platform)}被驳回`;
      for (let i = notes.length - 1; i >= 0; i--) if (notes[i].startsWith(dup)) notes.splice(i, 1);
    }
    else if (col === "待发布" && primary) text = "都通过了，可以发了；发完逐个平台标已发";
  } else if (n?.action) primary = { label: n.label ?? "下一步", run: { kind: "next", action: n.action }, ...(n.note ? { note: n.note } : {}) };
  const tone = primary ? "you" : col === "已发布" ? "none" : "ai";
  const head = tone === "you" ? "现在轮到你" : tone === "none" ? "没有要你做的" : aiHead(d.claim, idleHours);
  return { tone, head, text, primary, more: derivedMore(d, transitions), notes };
}

function derivedMore(d: CardPanelData, transitions: AllowedTransition[]): MoreItem[] {
  const out: MoreItem[] = [];
  const col = d.stage ?? d.column;
  const rev = transitions.find((t) => t.status === "revision");
  if (rev && (col === "写稿中" || col === "待录制")) out.push({ ...transitionItem(rev, d.status, true), label: "退回修订" });
  if (d.approvals?.cut) out.push({ key: "revoke-cut", label: "撤回成片批准", run: { kind: "decide", action: "revoke_approval", params: { decision_id: d.approvals.cut.id } }, confirm: { ...UNDO.revoke_cut, danger: true } });
  if (d.approvals?.cover) out.push({ key: "revoke-cover", label: "撤回封面批准", run: { kind: "decide", action: "revoke_approval", params: { decision_id: d.approvals.cover.id } }, confirm: { title: "撤回封面批准？", body: "这组封面的批准撤掉，已登记的发布包立刻不能发；要重新选封面。", danger: true } });
  for (const t of d.targets ?? []) {
    if (!t.actions.includes("correct_publish")) continue;
    out.push({ key: `correct:${t.platform}`, label: `纠正：${platformLabel(t.platform)}其实没发`, run: { kind: "target", target: t, action: "correct_publish" },
      confirm: { title: `纠正${platformLabel(t.platform)}的发布记录？`, body: `${UNDO.correct_publish.body}只动${platformLabel(t.platform)}这一个平台。`, danger: true } });
  }
  if (d.can_reopen) out.push({ key: "reopen", label: "重开这一条", run: { kind: "reopen" }, confirm: { ...(d.published_now ? UNDO.reopen_published : UNDO.reopen), danger: true } });
  // 其余合法流转照旧可点（服务端 preflight 照旧把关），不删恢复路径
  const used = new Set(out.map((m) => m.key));
  // 退回修订只在制作前（吸收 9）：进了制作要回头走「重开这一条」
  for (const t of transitions) if (t.status !== "editing" && t.status !== "revision" && !used.has(`t:${t.status}`)) out.push(transitionItem(t, d.status, true));
  return out;
}
