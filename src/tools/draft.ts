/**
 * autocrew_draft：灵感 → 拍 A-roll 的薄工具（docs/2026-10-04-idea-to-aroll-replan.md 实现规格）。
 * 只做存稿、给数据、核事实；流程写在 write-script 技能里。只做抖音口播，其他平台走旧流程。
 */
import { Type } from "@sinclair/typebox";
import { draftArgs } from "./draft-args.js";
import { draftStart } from "./draft-start.js";
import { draftAngle, draftSave, draftVerifyQuote } from "./draft-actions.js";
import { draftPrepareFinal } from "./draft-prepare.js";

const ACTIONS = ["start", "angle", "save", "verify_quote", "prepare_final"] as const;

export const DRAFT_DESCRIPTION =
  "抖音口播从灵感写到定稿（write-script 技能按 6 步调用）。start{inspiration,topic_id?} 建稿（topic_id 复用已有选题）或 start{content_id} 接手，返回档案、账号爆款、同系列主线、一手材料和当前 version；" +
  "verify_quote{content_id,url,quote} 抓网页逐字核引文，过了进证据台账并回证据编号；" +
  "angle{content_id,base_version,main_line,for_whom,opening,why_viral,chain,founder_words,chosen_option?} 记创始人选定的立意（可重调即改立意）；" +
  "save{content_id,base_version,body,title?,note?,review_notes?} 存一版（review_notes 附 Codex 审稿意见）；" +
  "prepare_final{content_id,base_version,citations} 出出处清单并推到等你认稿，「定了」只由创始人在工作台点。base_version 对不上回 version_conflict 和最新正文差异。";

export const draftSchema = Type.Object({
  action: Type.Unsafe<(typeof ACTIONS)[number]>({ type: "string", enum: [...ACTIONS], description: "start / angle / save / verify_quote / prepare_final" }),
  content_id: Type.Optional(Type.String({ description: "start 返回的稿件 id" })),
  topic_id: Type.Optional(Type.String({ description: "start：复用的已有选题 id" })),
  base_version: Type.Optional(Type.Integer({ description: "你最后读到的版本号；save / angle / prepare_final 必带" })),
  inspiration: Type.Optional(Type.String({ description: "start：创始人的一句灵感原话" })),
  platform: Type.Optional(Type.String({ description: "只支持 douyin；别的平台走 autocrew_workflow" })),
  url: Type.Optional(Type.String({ description: "verify_quote：引文所在网页" })),
  quote: Type.Optional(Type.String({ description: "verify_quote：从原网页逐字复制的一段" })),
  claim: Type.Optional(Type.String({ description: "verify_quote：这段引文撑的是哪句话" })),
  main_line: Type.Optional(Type.String({ description: "angle：我们的判断，一句" })),
  for_whom: Type.Optional(Type.String({ description: "angle：给谁看" })),
  opening: Type.Optional(Type.String({ description: "angle：开头 15 秒原话" })),
  why_viral: Type.Optional(Type.String({ description: "angle：为什么可能爆（引真实数字）" })),
  chain: Type.Optional(Type.Array(Type.String(), { description: "angle：4–6 行论证链" })),
  founder_words: Type.Optional(Type.String({ description: "angle：创始人选立意时的原话，照抄" })),
  chosen_option: Type.Optional(Type.String({ description: "angle：选中选项的展示全文" })),
  title: Type.Optional(Type.String({ description: "save：标题" })),
  body: Type.Optional(Type.String({ description: "save：全文（纯朗读正文）" })),
  note: Type.Optional(Type.String({ description: "save：这一版改了什么" })),
  review_notes: Type.Optional(Type.Unknown({ description: "save：Codex 审稿结果原样（JSON 或文字），调不通就写原因" })),
  citations: Type.Optional(Type.Array(Type.Object({
    text: Type.String(),
    evidence_ids: Type.Array(Type.String()),
    kind: Type.Optional(Type.String({ enum: ["claim", "example", "judgment"] })),
  }), { description: "prepare_final：事实句 → 证据编号，对不上给空数组；kind example/judgment 不需出处" })),
});

const HANDLERS: Record<string, (a: ReturnType<typeof draftArgs>) => Promise<Record<string, unknown>>> = {
  start: draftStart, angle: draftAngle, save: draftSave, verify_quote: draftVerifyQuote, prepare_final: draftPrepareFinal,
};

export async function executeDraft(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const a = draftArgs(params);
  const handler = HANDLERS[a.action];
  if (!handler) return { ok: false, code: "bad_param", error: `未知动作：${a.action || "（空）"}；可用 ${ACTIONS.join(" / ")}` };
  try {
    return await handler(a);
  } catch (err) {
    return { ok: false, code: "storage_error", error: `存盘或读取失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
