/**
 * autocrew_draft：灵感 → 拍 A-roll 的薄工具（docs/2026-10-04-idea-to-aroll-replan.md 实现规格）。
 * 只做存稿、给数据、核事实；流程写在 write-script 技能里。只做抖音口播，其他平台走旧流程。
 */
import { Type } from "@sinclair/typebox";
import { draftArgs } from "./draft-args.js";
import { draftStart } from "./draft-start.js";
import { draftSave, draftVerifyQuote } from "./draft-actions.js";
import { draftAngle, draftExemplars } from "./draft-angle.js";
import { draftOpening } from "./draft-opening.js";
import { draftFeedbackHistory, draftProposePromotion } from "./draft-learn.js";
import { draftPrepareFinal } from "./draft-prepare.js";

const ACTIONS = ["start", "exemplars", "angle", "opening", "save", "verify_quote", "prepare_final", "feedback_history", "propose_promotion"] as const;

export const DRAFT_DESCRIPTION =
  "抖音口播从灵感写到定稿（write-script 技能按步骤调用）。start{inspiration,topic_id?} 建稿或 start{content_id} 接手，返回档案、爆款、同系列、一手材料（firsthand）、口吻参考（voice_refs）、锁住的范文与写法和当前 version；" +
  "verify_quote{content_id,url,quote} 抓网页逐字核引文进证据台账；" +
  "exemplars{genre,content_id?} 出立意卡前按体裁预览范文全文（只读）；" +
  "angle{content_id,base_version,genre,exemplars,main_line,for_whom,opening,why_viral,chain,founder_words,chosen_option?} 记立意与体裁，锁住手册、卡上引用的范文和写法版本；" +
  "opening{content_id,base_version,candidates|opening+founder_words} 先磨开头：记一轮候选或他选中的开头，选了才收第一版全文；" +
  "save{content_id,base_version,body,title?,note?,test_read?,feedback?} 存一版（test_read 附观众试读；feedback 记创始人原话，正文没改也能记）；" +
  "prepare_final{content_id,base_version,citations} 出出处清单推到等你认稿，「定了」只由创始人在工作台点；" +
  "feedback_history{genre?} 跨稿读意见；propose_promotion{content_id,target,cites,text,note,genre?|exemplar_id?} 两篇不同稿都出现过的意见才提升级。base_version 对不上回 version_conflict。";

export const draftSchema = Type.Object({
  action: Type.Unsafe<(typeof ACTIONS)[number]>({ type: "string", enum: [...ACTIONS], description: "按 write-script 技能的步骤调用" }),
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
  opening: Type.Optional(Type.String({ description: "angle：开头 15 秒原话；opening：他选中（或改过）的开头全文" })),
  why_viral: Type.Optional(Type.String({ description: "angle：为什么可能爆（引真实数字）" })),
  chain: Type.Optional(Type.Array(Type.String(), { description: "angle：4–6 行论证链" })),
  founder_words: Type.Optional(Type.String({ description: "angle / opening：创始人的原话，照抄" })),
  chosen_option: Type.Optional(Type.String({ description: "angle：选中选项的展示全文" })),
  genre: Type.Optional(Type.String({ description: "exemplars / angle 必带：体裁（手册 id，见 start 的 playbooks_index）" })),
  exemplars: Type.Optional(Type.Unknown({ description: "angle：立意卡上实际引用的范文 [{id, version}]（exemplars 预览给的）；本体裁无范文传 []" })),
  candidates: Type.Optional(Type.Array(Type.String(), { description: "opening：这一轮 3 个不同写法的开头（前 15 秒原话）" })),
  test_read: Type.Optional(Type.Unknown({ description: "save：观众试读 {status: ok|failed|unsupported, notes: 试读原文或失败原因}，body 传它读的那一版正文" })),
  target: Type.Optional(Type.String({ description: "propose_promotion：playbook / exemplar / method" })),
  cites: Type.Optional(Type.Unknown({ description: "propose_promotion：至少两篇不同稿的意见出处 [{content_id, index}]（feedback_history 给的）" })),
  text: Type.Optional(Type.String({ description: "propose_promotion：改后的手册全文 / 范文批注 / 写法改动" })),
  exemplar_id: Type.Optional(Type.String({ description: "propose_promotion target=exemplar：哪篇范文" })),
  title: Type.Optional(Type.String({ description: "save：标题" })),
  body: Type.Optional(Type.String({ description: "save：全文（纯朗读正文）" })),
  note: Type.Optional(Type.String({ description: "save：这一版改了什么；propose_promotion：为什么升级" })),
  review_notes: Type.Optional(Type.Unknown({ description: "save：旧版 Codex 审稿结果（已由观众试读替代，旧会话照收）" })),
  feedback: Type.Optional(Type.Unknown({ description: "save：创始人这次的意见 {founder_words: 原话逐字, chosen_option?: 原话只是选项代号时带那个选项全文}；第一版不收，开头阶段的意见用 opening 记" })),
  citations: Type.Optional(Type.Array(Type.Object({
    text: Type.String(),
    evidence_ids: Type.Array(Type.String()),
    kind: Type.Optional(Type.String({ enum: ["claim", "example", "judgment"] })),
  }), { description: "prepare_final：事实句 → 证据编号，对不上给空数组；kind example/judgment 不需出处" })),
});

const HANDLERS: Record<string, (a: ReturnType<typeof draftArgs>) => Promise<Record<string, unknown>>> = {
  start: draftStart, exemplars: draftExemplars, angle: draftAngle, opening: draftOpening, save: draftSave, verify_quote: draftVerifyQuote,
  prepare_final: draftPrepareFinal, feedback_history: draftFeedbackHistory, propose_promotion: draftProposePromotion,
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
