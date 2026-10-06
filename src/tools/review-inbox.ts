/**
 * `autocrew_review_inbox` — 在对话里处理「等你拍板」（spec 2026-10-06 chat-approval，修订：对话原话直接定）。
 *
 * list 列条目（带看板深链、成片路径）；decide 按创始人原话记决定；revoke 撤回刚才的批准。
 * 宿主身份取 MCP 传输层注入的 `_host` / `_session`，不取 agent 写的参数。
 */
import { Type } from "@sinclair/typebox";
import { getDataDir } from "../storage/local-store.js";
import { chatDecide, chatRevoke, type ChatDecideInput } from "../modules/production/chat-approval/decide.js";
import { listForChat, sweepDecided } from "../modules/production/chat-approval/present.js";

const ACTIONS = ["list", "decide", "revoke"] as const;
const DECISIONS = ["answer_ask", "ask_resend", "pick_cover", "retire_cover_group", "reject_cover", "approve_cut", "reject_cut", "confirm_candidate", "reject_candidate"] as const;

export const reviewInboxSchema = Type.Object({
  action: Type.Unsafe<(typeof ACTIONS)[number]>({ type: "string", enum: [...ACTIONS], description: "list | decide | revoke" }),
  item_id: Type.Optional(Type.String({ description: "decide：list 给的 item_id；list 带上就只看这一件" })),
  preview_dir: Type.Optional(Type.String({ description: "你这个会话的工作目录（绝对路径）：要看的文件放进它下面的 review-preview/" })),
  gen: Type.Optional(Type.String({ description: "decide：list 给的 gen（你给创始人看的那一版）" })),
  decision: Type.Optional(Type.Unsafe<(typeof DECISIONS)[number]>({ type: "string", enum: [...DECISIONS], description: "decide：要记的决定" })),
  group_id: Type.Optional(Type.String({ description: "封面有不止一组时必带：哪一组（list 带上 = 看这一组）" })),
  fact_id: Type.Optional(Type.String({ description: "成片有不止一版时必带：哪一版（list 带上 = 看这一版）" })),
  option_id: Type.Optional(Type.String({ description: "answer_ask：他选的选项 id" })),
  cover_text: Type.Optional(Type.String({ description: "pick_cover：创始人说的封面字；不带就用这组自己的字" })),
  note: Type.Optional(Type.String({ description: "reject_cover / reject_cut：要改哪里" })),
  founder_words: Type.Optional(Type.String({ description: "创始人在对话里的原话，照抄" })),
  request_id: Type.Optional(Type.String({ description: "请求号，重试用同一个" })),
  content_id: Type.Optional(Type.String({ description: "revoke：稿件 id；list 带上就只列这条稿的事" })),
  decision_id: Type.Optional(Type.String({ description: "revoke：decide 回执里的决定 id" })),
});

export const REVIEW_INBOX_DESCRIPTION = [
  "在对话里处理「等你拍板」：选封面、审成片、认候选文件、答 agent 的请示。创始人在对话里说的原话就是决定，所以你只记他明确说了的。",
  "1) list{preview_dir:你会话的工作目录, content_id?, item_id?}：列等创始人定的事。能在对话里定的每件带 brief（服务端写好的「要你判断」）、shown（这次给他看的那一组 / 一版）、preview（文件放进会话文件夹后的相对路径）。chat_decidable:false 的（发布、收件箱文件、请示、闪帧等）只能在看板定：给他 board_link。",
  "2) brief 原样转述，不要自己加判断标准；preview.files 的 path 写成 markdown 链接 [名字](path)；preview.opened / problems 照说给他。不止一件时按 number 列编号清单。他要看更早的一组 / 一版，list{item_id, group_id / fact_id, preview_dir}。",
  "3) decide{item_id, gen, decision, group_id?/fact_id?, cover_text?, note?, founder_words, request_id, preview_dir?}：founder_words 一字不改照抄他的原话。他的话能对上不止一件 / 一组 / 一种决定（比如只说「行」「第一个」）就先问清，别猜。多组 / 多版时必须带 group_id / fact_id（reject_cover 除外：它和看板一样打回所有还没定的组，不点名；他只想改其中一组就先问清，或请他去看板）。reject_cover / reject_cut 要带 note（改哪里）。",
  "请示：decide{decision:\"answer_ask\", option_id, note?}——他的话对得上唯一一个选项才定，多说的话放 note；只说「行」而选项不止一个、或对不上任何选项，就先问他，别猜。附件变过时只能 ask_resend（让它重发）。分镜请示提交时还会再核分镜，拒了就把原因照说。",
  "4) revoke{content_id, decision_id, founder_words, request_id}：他说「撤回刚才那个」时用，decision_id 取 decide 回执；只能撤成片 / 封面的批准。",
  "返回 stale：这件事变了，把返回的新 item 重新给他看；already_handled：已经在别处定了；selector_required：问他是哪一组 / 哪一版；file_changed：文件变过、什么都没记，把返回的新 item 重新给他看；stale_selector：你点名的那一组 / 一版已经不在了，把返回的 item 重新给他看；warnings：预览清理没成，照说（决定不受影响）。",
].join("\n");

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function inputOf(params: Record<string, unknown>): ChatDecideInput {
  return {
    item_id: str(params.item_id)?.trim() ?? "", gen: str(params.gen)?.trim() ?? "", decision: str(params.decision)?.trim() ?? "",
    group_id: str(params.group_id), fact_id: str(params.fact_id), option_id: str(params.option_id), cover_text: str(params.cover_text), note: str(params.note),
    content_id: str(params.content_id), decision_id: str(params.decision_id),
    founder_words: str(params.founder_words) ?? "", request_id: str(params.request_id), host: params._host, session: params._session,
  };
}

export async function executeReviewInbox(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const dataDir = getDataDir(str(params._dataDir) || undefined);
  const action = str(params.action)?.trim() ?? "list";
  const previewDir = str(params.preview_dir)?.trim() || undefined;
  if (action === "list") return listForChat(dataDir, { preview_dir: previewDir, content_id: str(params.content_id)?.trim() || undefined, item_id: str(params.item_id)?.trim() || undefined, group_id: str(params.group_id), fact_id: str(params.fact_id) });
  if (action === "decide") {
    const r = await chatDecide(inputOf(params), dataDir);
    // 定掉了：这件事放进会话文件夹的预览随手清掉；清不掉照说（决定已经记下，不受影响）
    const warnings = r.ok === true && previewDir ? await sweepDecided(dataDir, previewDir) : [];
    return warnings.length ? { ...r, warnings } : r;
  }
  if (action === "revoke") return chatRevoke(inputOf(params), dataDir);
  return { ok: false, code: "invalid_params", error: `不认识的 action：${action}（list | decide | revoke）` };
}
