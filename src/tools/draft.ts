/**
 * autocrew_draft：灵感 → 拍 A-roll 的薄工具（docs/2026-10-04-idea-to-aroll-replan.md 实现规格）。
 * 只做存稿、给数据、核事实；流程写在 write-script 技能里。只做抖音口播，其他平台走旧流程。
 */
import { Type } from "@sinclair/typebox";
import { draftArgs } from "./draft-args.js";
import { draftStart } from "./draft-start.js";
import { draftAngle, draftCite, draftRead, draftReview, draftSave } from "./draft-actions.js";
import { draftPrepareFinal } from "./draft-prepare.js";
import { BrokerQuotaError } from "../modules/research/research-broker.js";

const ACTIONS = ["start", "read", "cite", "angle", "save", "review", "prepare_final"] as const;

export const DRAFT_DESCRIPTION =
  "抖音口播从灵感写到定稿（write-script 技能按 6 步调用）。start{inspiration} 建稿或 start{content_id} 接手，返回档案、账号爆款、同系列主线与一手材料；" +
  "read{content_id,url} 抓网页原文拿 page_id；cite{content_id,page_id,quote} 逐字核引文进证据台账；" +
  "angle{content_id,main_line,for_whom,opening,why_viral,chain,founder_words} 记创始人选定的立意（可重调即改立意）；" +
  "save{content_id,body,title?,note?} 存一版，第一版后台排一次 Codex 审稿；review{content_id,rerun?} 查审稿；" +
  "prepare_final{content_id,citations} 出出处清单并推到等你认稿，「定了」只由创始人在工作台点。被占用时 takeover 只在闲置满 10 分钟且创始人同意后用。";

export const draftSchema = Type.Object({
  action: Type.Unsafe<(typeof ACTIONS)[number]>({ type: "string", enum: [...ACTIONS], description: "start / read / cite / angle / save / review / prepare_final" }),
  content_id: Type.Optional(Type.String({ description: "start 返回的稿件 id" })),
  inspiration: Type.Optional(Type.String({ description: "start：创始人的一句灵感原话" })),
  platform: Type.Optional(Type.String({ description: "只支持 douyin；别的平台走 autocrew_workflow" })),
  url: Type.Optional(Type.String({ description: "read：要抓的网页" })),
  page_id: Type.Optional(Type.String({ description: "cite：read 返回的 page_id" })),
  quote: Type.Optional(Type.String({ description: "cite：从 read 原文里逐字复制的一段" })),
  claim: Type.Optional(Type.String({ description: "cite：这段引文撑的是哪句话" })),
  main_line: Type.Optional(Type.String({ description: "angle：我们的判断，一句" })),
  for_whom: Type.Optional(Type.String({ description: "angle：给谁看" })),
  opening: Type.Optional(Type.String({ description: "angle：开头 15 秒原话" })),
  why_viral: Type.Optional(Type.String({ description: "angle：为什么可能爆（引真实数字）" })),
  chain: Type.Optional(Type.Array(Type.String(), { description: "angle：4–6 行论证链" })),
  founder_words: Type.Optional(Type.String({ description: "angle：创始人选立意时的原话，照抄" })),
  title: Type.Optional(Type.String({ description: "save：标题" })),
  body: Type.Optional(Type.String({ description: "save：全文（纯朗读正文）" })),
  note: Type.Optional(Type.String({ description: "save：这一版改了什么" })),
  rerun: Type.Optional(Type.Boolean({ description: "review：再审当前版" })),
  citations: Type.Optional(Type.Array(Type.Object({ text: Type.String(), evidence_ids: Type.Array(Type.String()) }), { description: "prepare_final：事实句 → 证据编号；对不上的给空数组" })),
  claim_token: Type.Optional(Type.String({ description: "只在回执给过 claim_token 时带上（没有会话的调用）" })),
  takeover: Type.Optional(Type.Boolean({ description: "被别的会话占着、闲置满 10 分钟且创始人同意时接管" })),
});

const HANDLERS: Record<string, (a: ReturnType<typeof draftArgs>) => Promise<Record<string, unknown>>> = {
  start: draftStart, read: draftRead, cite: draftCite, angle: draftAngle, save: draftSave, review: draftReview, prepare_final: draftPrepareFinal,
};

export async function executeDraft(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const a = draftArgs(params);
  const handler = HANDLERS[a.action];
  if (!handler) return { ok: false, code: "bad_param", error: `未知动作：${a.action || "（空）"}；可用 ${ACTIONS.join(" / ")}` };
  try {
    return await handler(a);
  } catch (err) {
    if (err instanceof BrokerQuotaError) return { ok: false, code: "quota", error: err.message };
    return { ok: false, code: "storage_error", error: `存盘或读取失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
