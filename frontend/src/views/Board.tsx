/**
 * 看板的动作（拖放落地、往回退、开始写、认稿）：旧看板页面已由内容管线（Pipeline.tsx）取代（管线重规划第 3 期），
 * 这些动作仍是拖动规则的落地实现，内容管线照旧调用。首页是 Home.tsx。
 */
import { toast, confirmDialog } from "../ui";
import { decide, loadCard, markPublished, reopenScript, startWriting, type StartReply } from "./board-api";
import { announce, explainFailure } from "./hand-off";
import type { HostId } from "./onboarding/connect-api";
import { decideItem } from "./review/review-api";
import { confirmBackMove, runTransition } from "./BoardCards";
import { FINAL_NOTE, HANDOFF_NOTE, platformName, type BoardItem, type DropAction, type UndoMove } from "./board-columns";
import "./board.css";

/** 拖放落地：认稿 / 标已发布走状态流转（force 只越状态图形状、越不过阶段门）；交剪辑、成片只打开工作台 */
export async function applyDrop(act: DropAction, item: BoardItem, openEditor: (id: string) => void, reload: () => Promise<void>): Promise<void> {
  switch (act.kind) {
    case "open": return openEditor(item.id);
    case "undo": return runUndo(act.undo, item, reload);
    case "approve": return approveDraft(item, reload);
    case "back": return confirmBackMove(item, act.move, reload);
    case "publish": {
      if (!item.platform) return toast("这条没定平台，在卡片上对应平台点「已经发出去了」");
      const yes = await confirmDialog({ title: "标记为已发布？", body: `记为你在${platformName(item.platform)}手动发了。不会推送到平台，只改状态。`, confirmLabel: "标记已发布" });
      if (!yes) return;
      try { const r = await markPublished(item.id, item.platform); toast(r.ok ? "已标记为已发布" : r.error); } finally { await reload(); }
      return;
    }
    case "open-handoff": toast(HANDOFF_NOTE); return openEditor(item.id);
    case "open-final": toast(FINAL_NOTE); return openEditor(item.id);
    default: return;
  }
}

/** 本体下往回拖（§10、E14）：先确认，再落对应的撤销决定 / 重开文稿 */
async function runUndo(undo: UndoMove, item: BoardItem, reload: () => Promise<void>): Promise<void> {
  const card = await loadCard(item.id);
  if (!card.ok) return toast(card.error);
  // 纠正发布：确认框里写明撤的是哪一条（最新那条），不让人猜
  const last = card.data.published?.[0];
  const which = undo.action === "correct_publish" && last ? `\n\n要撤的是：${platformName(last.platform ?? "")} · ${last.label}${last.url ? ` · ${last.url}` : ""}` : "";
  if (!(await confirmDialog({ title: undo.title, body: undo.body + which, confirmLabel: "确定", danger: true }))) return;
  try {
    if (undo.action === "unapprove") return await runTransition(item, "reviewing", "已撤回认稿", async () => undefined);
    if (undo.action === "reopen") { const r = await reopenScript(item.id, card.data.round ?? 1); toast(r.ok ? "已重开文稿" : r.error); return; }
    if (undo.action === "revoke_cut") {
      const id = card.data.approvals?.cut?.id;
      if (!id) return toast("这版成片没有有效的批准可撤");
      const r = await decide(item.id, "revoke_approval", { decision_id: id });
      return toast(r.ok ? "已撤销成片批准" : r.error);
    }
    if (!last) return toast("没有可纠正的发布记录");
    const r = await decide(item.id, "correct_publish", { target_id: last.id });
    toast(r.ok ? "已纠正发布记录" : r.error);
  } finally { await reload(); }
}

/**
 * 「开始写」的收尾（spec 2026-10-15 §B2）：已开写就打开那篇；交给默认写稿 AI（或这一次换的那个），
 * 按 AI 说清下一步（Claude 按发送 / Codex 粘贴 / WorkBuddy 粘过去）；没接 AI、默认的断了都明说，不假装开工。
 */
export async function runStart(topicId: string, openEditor: (id: string) => void, host?: HostId): Promise<void> {
  const r = await startWriting(topicId, host);
  if (!r.ok) return explainFailure(r, (alt) => runStart(topicId, openEditor, alt));
  if (!r.data.created) {
    toast("这条已经开写了，打开那篇");
    return openEditor(r.data.content_id);
  }
  const d = r.data as Required<Pick<StartReply, "host" | "label" | "prompt" | "opened" | "paste">> & StartReply;
  const angle = r.data.needs_angle ? "（这条还没定立意，它会先调研、给你立意卡选）" : "";
  await announce(d, "write", `已建稿${angle}。`);
}

/**
 * 拖「写稿中 → 待录制」= 认稿：走「等你拍板」的单一入口，带看板载入时那一版稿的代次；
 * 别的会话改过正文就拒「稿子刚改过，重新看一眼」（整分支审 4 P1）
 */
export async function approveDraft(item: BoardItem, reload: () => Promise<void>): Promise<void> {
  try {
    if (!item.draftRef) { toast("稿子刚改过，重新看一眼"); return; }
    const r = await decideItem({ content_id: item.id, item_id: item.draftRef.item_id, gen: item.draftRef.gen, action: "approve_script" });
    toast(r.ok ? "已认稿" : r.error);
  } finally { await reload(); }
}
