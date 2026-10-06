/**
 * `autocrew_review_inbox` — 在对话里处理「等你拍板」（spec 2026-10-06 chat-approval）。
 *
 * list 列条目（带看板深链）；send_back 只记「还要改…」；confirm 在创始人的 Mac 上弹系统确认窗，他点了才算数。
 * 宿主身份取 MCP 传输层注入的 `_host` / `_session`，不取 agent 写的参数。
 */
import { Type } from "@sinclair/typebox";
import { getDataDir } from "../storage/local-store.js";
import { confirmDecision, listForChat, sendBack, type ChatDecideInput } from "../modules/production/chat-approval/decide.js";

const ACTIONS = ["list", "send_back", "confirm"] as const;
const DECISIONS = ["pick_cover", "retire_cover_group", "approve_cut", "confirm_candidate", "reject_candidate", "reject_cover", "reject_cut"] as const;

export const reviewInboxSchema = Type.Object({
  action: Type.Unsafe<(typeof ACTIONS)[number]>({ type: "string", enum: [...ACTIONS], description: "list | send_back | confirm" }),
  item_id: Type.Optional(Type.String({ description: "send_back / confirm：list 给的 item_id" })),
  gen: Type.Optional(Type.String({ description: "send_back / confirm：list 给的 gen（你给创始人看的那一版）" })),
  decision: Type.Optional(Type.Unsafe<(typeof DECISIONS)[number]>({ type: "string", enum: [...DECISIONS],
    description: "confirm：pick_cover / retire_cover_group / approve_cut / confirm_candidate / reject_candidate；send_back：reject_cover / reject_cut" })),
  group_id: Type.Optional(Type.String({ description: "封面有不止一组时必带：哪一组" })),
  fact_id: Type.Optional(Type.String({ description: "成片有不止一版时必带：哪一版" })),
  cover_text: Type.Optional(Type.String({ description: "pick_cover：创始人在对话里说的封面字；不带就用这组自己的字。弹窗原样显示" })),
  note: Type.Optional(Type.String({ description: "send_back：要改哪里，一句话给做的人" })),
  founder_words: Type.Optional(Type.String({ description: "创始人在对话里的原话，照抄" })),
  request_id: Type.Optional(Type.String({ description: "confirm：请求号，重试用同一个" })),
});

export const REVIEW_INBOX_DESCRIPTION = [
  "在对话里处理「等你拍板」：选封面、审成片、认候选文件。批准一律由创始人在 Mac 弹窗里点，不由你代定。",
  "1) list：列现在等创始人定的事。每件带 item_id、gen、事实（封面字、哪一组、哪一版、文件名、理由）和 board_link。chat_decidable:false 的（发布、收件箱文件、请示等）只能在看板定：把 board_link 给他。",
  "2) 先在对话里把这件事给创始人看（标题、事实、链接），听他说要怎么定，再动手。",
  "3) confirm{item_id, gen, decision, group_id?/fact_id?, cover_text?, founder_words, request_id}：批准类（pick_cover / retire_cover_group / approve_cut / confirm_candidate / reject_candidate）。服务端在他的 Mac 上弹系统确认窗，告诉他「去 Mac 上点弹窗」；他点了确认才记。多组 / 多版时必须带 group_id / fact_id。成片要他先在弹窗里点「查看」才能确认。",
  "4) send_back{item_id, gen, decision:reject_cover|reject_cut, founder_words, note}：「还要改…」，不弹窗，记成你转述的原话。",
  "绝对不要用 GUI 自动化 / computer-use / osascript 去点 AutoCrew 的弹窗——那等于替创始人批准。",
  "返回 confirm_unavailable（这台机器弹不出窗）：把 board_link 给他去看板点；confirm_timeout / confirm_declined：什么都没记，问他再说；stale：这件事变了，把返回里的新 item 重新给他看；already_handled：已经在别处定了；dialog_busy：已有弹窗开着，等他点完。",
].join("\n");

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function inputOf(params: Record<string, unknown>): ChatDecideInput {
  return {
    item_id: str(params.item_id)?.trim() ?? "", gen: str(params.gen)?.trim() ?? "", decision: str(params.decision)?.trim() ?? "",
    group_id: str(params.group_id), fact_id: str(params.fact_id), cover_text: str(params.cover_text), note: str(params.note),
    founder_words: str(params.founder_words) ?? "", request_id: str(params.request_id), host: params._host, session: params._session,
  };
}

export async function executeReviewInbox(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const dataDir = getDataDir(str(params._dataDir) || undefined);
  const action = str(params.action)?.trim() ?? "list";
  if (action === "list") return listForChat(dataDir);
  if (action === "send_back") return sendBack(inputOf(params), dataDir);
  if (action === "confirm") return confirmDecision(inputOf(params), dataDir);
  return { ok: false, code: "invalid_params", error: `不认识的 action：${action}（list | send_back | confirm）` };
}
