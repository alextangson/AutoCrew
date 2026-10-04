/**
 * 选题会闸口（创始人 2026-10-04 规则）：一个选题要开出第一篇真稿，必须先开过选题会——
 * 多路调研出 3–4 张立意卡，由创始人用原话选定一张（或给出自己的角度）。
 *
 * 「新稿」= 这次 AI/模型发起的调用会让一个还没有真稿的选题拥有第一份正文。
 * 真稿 = 未删、未归档、存下的正文（当前 body 或任一版本）不是占位。不看 status：
 * status 能被 transition/update 改，靠它判断等于把闸口交给一次状态改写。
 * 已有真稿的选题（存量、改稿、真稿的平台变体）和人手录入 / manual_import 不经过这里。
 *
 * 读稿件或选题失败 → 明确拒绝（angle_gate_read_failed），既不放行，也不当成「没定角度」。
 */
import {
  getContentStrict, getDataDir, getTopicStrict, listContentsStrict, updateTopic,
  type Content, type Topic,
} from "../../storage/local-store.js";
import { activeAngleCard } from "./angle-cards.js";
import { FirstBodyRefusedError, isRealDraft, type WriteRequest } from "../../storage/first-body-guard.js";
import { resolveEffectiveBriefStrict } from "./brief-snapshot.js";
import { topicHashOf } from "./research-job-store.js";

/** 用户可见文案集中在这里（创始人过目） */
export const ANGLE_GATE_COPY = {
  noChoice: "这条还没开选题会：先让几路调研把立意卡摆出来，你挑一张（或说出你自己的角度），定下来再开写。",
  notFounderChoice: "这张卡不是你亲口定的。选题会的最后一步要你本人拍板：说一句你选哪张、为什么，再开写。",
  noTopic: "开新稿要先有选题并开过选题会。给一句灵感也行，先建选题、出立意卡，你定了再写。",
  readFailed: "稿件或选题记录读不出来，没法确认这条是不是已经定过角度，先不开写。",
  decisionChanged: "你后来改了角度，这份写作请求还是按之前的定的。按你最新定的角度重新领包 / 重新生成再写。",
  staleChoice: "你之前定的那张卡已经过期了（选题改过或调研重跑过）。看一眼新的立意卡，再定一次。",
  needFounderWords: "选哪张卡要附上创始人的原话（founder_words），不能由助手代选。",
  bareDirection: "自定角度要附上创始人的原话：用 select_angle 传 direction + founder_words，不能直接拿 direction 跳过选题会。",
  skipRemoved: "跳过调研、跳过选卡的通道已关闭。创作者自带材料用 research_mode:\"provided\" 带进来，仍要出立意卡、由创始人定。",
} as const;

export interface AngleRefusal {
  ok: false;
  code: "needs_founder_angle" | "angle_gate_read_failed" | "skip_removed";
  error: string;
  next_action: Record<string, unknown>;
  [key: string]: unknown;
}

function meetingNext(topicId?: string): Record<string, unknown> {
  return {
    skill: "topic-meeting",
    tool: "autocrew_workflow",
    params: topicId ? { action: "prepare", topic_id: topicId } : { action: "prepare", inspiration: "<创作者的一句灵感>" },
    note: "按 topic-meeting 技能开选题会：并行调研出 3–4 张立意卡，让创始人选（select_angle 带 founder_words 原话），再回来开写。不要绕过。",
  };
}

export { isRealDraft };

/** 该选题是否已有真稿。严格读：任何一条稿件记录（或核验占位要读的选题）读不出就抛 */
export async function topicHasDraft(topicId: string, dataDir?: string): Promise<boolean> {
  for (const c of await listContentsStrict(dataDir)) {
    if (c.topicId === topicId && await isRealDraft(c, dataDir)) return true;
  }
  return false;
}

/** 创始人亲口定的角度：带原话选的卡，或带原话、选题文本没改过的自定角度 */
export function founderChoiceOf(topic: Topic): { kind: "card" | "authored"; words: string } | null {
  const sel = topic.selectedAngle;
  if (sel?.chosenBy === "founder" && sel.founderWords?.trim()) return { kind: "card", words: sel.founderWords };
  const own = topic.founderAngle;
  if (own?.founderWords.trim() && own.direction.trim() && own.topicHash === topicHashOf(topic.title, topic.description ?? "")) {
    return { kind: "authored", words: own.founderWords };
  }
  return null;
}

/** 创始人最近一次角度决定是哪一种 */
export function latestDecision(topic: Topic): "card" | "authored" | null {
  const card = topic.selectedAngle ? Date.parse(topic.selectedAngle.selectedAt) || 0 : -1;
  const own = topic.founderAngle ? Date.parse(topic.founderAngle.chosenAt) || 0 : -1;
  if (card < 0 && own < 0) return null;
  return own > card ? "authored" : "card";
}

/** 创始人选的卡在当前生效简报里还作数（同 writing-readiness 的 activeAngleCard 口径） */
async function selectedCardFresh(topic: Topic, dataDir?: string): Promise<boolean> {
  // 严格读：简报或台账读坏不能被当成「选择过期」，也不能让坏掉的最新行把旧选择复活；抛出去由调用方报读失败
  const snap = await resolveEffectiveBriefStrict(topic.id, getDataDir(dataDir));
  return Boolean(snap && activeAngleCard(topic.selectedAngle, snap.brief, topicHashOf(topic.title, topic.description ?? "")));
}

function refusal(code: AngleRefusal["code"], error: string, extra: Record<string, unknown> = {}): AngleRefusal {
  return { ok: false, code, error, next_action: meetingNext(typeof extra.topic_id === "string" ? extra.topic_id : undefined), ...extra };
}

function readFailure(err: unknown, topicId?: string): AngleRefusal {
  const raw = err instanceof Error ? err.message : String(err);
  return refusal("angle_gate_read_failed", `${ANGLE_GATE_COPY.readFailed}（${raw}）`, {
    ...(topicId ? { topic_id: topicId } : {}),
    next_action: { note: "把原始错误告诉创作者，修好稿件/选题记录再试；不要绕过。" },
  });
}

/**
 * 开新稿前的唯一判定。null = 放行；否则结构化拒绝（不抛异常）。
 * topicId 为空 = 没有选题的新稿，必然没开过选题会。
 */
export async function newDraftAngleRefusal(topicId: string | undefined, dataDir?: string): Promise<AngleRefusal | null> {
  const id = topicId?.trim();
  if (!id) return refusal("needs_founder_angle", ANGLE_GATE_COPY.noTopic);
  try {
    if (await topicHasDraft(id, dataDir)) return null;
    const topic = await getTopicStrict(id, dataDir);
    if (!topic || topic.deletedAt) return refusal("needs_founder_angle", ANGLE_GATE_COPY.noTopic, { topic_id: id });
    // 只认创始人最近一次决定（旧数据两样都在时按时间取新的）；选卡要核生效简报（选题文本或简报变了那张卡就过期）
    const latest = latestDecision(topic);
    if (latest === "authored" && founderChoiceOf({ ...topic, selectedAngle: undefined })) return null;
    const founderCard = latest === "card" ? founderChoiceOf({ ...topic, founderAngle: undefined }) : null;
    if (founderCard && await selectedCardFresh(topic, dataDir)) return null;
    if (founderCard) return refusal("needs_founder_angle", ANGLE_GATE_COPY.staleChoice, { topic_id: id });
    const legacy = Boolean(topic.selectedAngle);
    return refusal("needs_founder_angle", legacy ? ANGLE_GATE_COPY.notFounderChoice : ANGLE_GATE_COPY.noChoice, { topic_id: id });
  } catch (err) {
    return readFailure(err, id);
  }
}

/**
 * AI 要改写一篇已有稿件（重写/改稿/润色/平台改写的源稿）：这篇本身是真稿就放行；
 * 是占位（空白、选题描述垫的）就等于在给它的选题开第一篇，走开新稿判定。
 */
export async function aiContentWriteRefusal(contentId: string, dataDir?: string): Promise<AngleRefusal | null> {
  let content: Content | null;
  try { content = await getContentStrict(contentId, dataDir); } catch (err) { return readFailure(err); }
  if (!content) return null; // 找不到稿件由各入口自己报
  try { if (await isRealDraft(content, dataDir)) return null; } catch (err) { return readFailure(err, content.topicId); }
  return newDraftAngleRefusal(content.topicId, dataDir);
}

/** 记一条创始人自定角度（select_angle 不带 angle_id、带 direction + founder_words） */
export async function recordFounderAngle(topic: Topic, direction: string, founderWords: string, dataDir?: string): Promise<Topic | null> {
  // 只认最新一次决定：自定角度取代之前选的卡
  return updateTopic(topic.id, {
    selectedAngle: undefined,
    founderAngle: { direction: direction.trim(), founderWords: founderWords.trim(), chosenAt: new Date().toISOString(), topicHash: topicHashOf(topic.title, topic.description ?? "") },
  }, dataDir);
}

/**
 * 后台写作任务的准入（生成 / 重写 / 改稿 / 平台改写开跑之前）：和存储层卡口同一判定，
 * 只是提前到调模型之前，免得白跑一轮模型再在落盘时被拒。拒绝就抛 FirstBodyRefusedError。
 */
export async function admitWritingJob(target: { topicId?: string; contentId?: string; request?: WriteRequest }, dataDir?: string): Promise<void> {
  let topicId = target.topicId;
  if (target.contentId) {
    let content: Content | null;
    try { content = await getContentStrict(target.contentId, dataDir); } catch (err) { throw new FirstBodyRefusedError(readFailure(err)); }
    if (!content) return; // 稿件不在：由调用方报「稿件不存在」，不在这里冒充成选题会问题
    try { if (await isRealDraft(content, dataDir)) return; } catch (err) { throw new FirstBodyRefusedError(readFailure(err)); }
    topicId = content.topicId ?? topicId;
  }
  const refused = await newDraftAngleRefusal(topicId, dataDir);
  if (refused) throw new FirstBodyRefusedError(refused);
  // 选题已有别的真稿 = 不是第一篇，请求不再对照；否则冻结 / 合并后的请求要对上创始人最新的决定
  let exempt: boolean;
  try { exempt = Boolean(topicId) && await topicHasDraft(topicId!, dataDir); } catch (err) { throw new FirstBodyRefusedError(readFailure(err)); }
  if (exempt) return;
  const mismatch = await decisionRequestRefusal(topicId, target.request, dataDir);
  if (mismatch) throw new FirstBodyRefusedError(mismatch);
}

/**
 * 冻结的写作请求对不对得上创始人「最新」的决定（第一篇稿专用；存量稿由调用方先豁免）。
 * 带跳过参数 → 拒；带 direction → 必须是最近一次自定的那句；没带 direction → 最近一次必须是选卡，
 * 给了 angleId 还得是同一张。没有请求（不依据角度的改写，如润色）→ 不对照。
 */
export async function decisionRequestRefusal(topicId: string | undefined, request: WriteRequest | undefined, dataDir?: string): Promise<AngleRefusal | null> {
  if (!request || !topicId) return null;
  if (request.skip) return refusal("skip_removed", ANGLE_GATE_COPY.skipRemoved, { topic_id: topicId });
  let topic: Topic | null;
  try { topic = await getTopicStrict(topicId, dataDir); } catch (err) { return readFailure(err, topicId); }
  if (!topic) return refusal("needs_founder_angle", ANGLE_GATE_COPY.noTopic, { topic_id: topicId });
  const latest = latestDecision(topic);
  const direction = request.direction?.trim();
  const ok = direction
    ? latest === "authored" && topic.founderAngle?.direction.trim() === direction
    : latest === "card" && (!request.angleId || topic.selectedAngle?.angleId === request.angleId);
  return ok ? null : refusal("needs_founder_angle", ANGLE_GATE_COPY.decisionChanged, { topic_id: topicId });
}

/** 创始人最近一次决定是自定角度时返回那句方向（开写入口没带方向时沿用它），否则 undefined */
export async function founderDirectionFor(topicId: string | undefined, dataDir?: string): Promise<string | undefined> {
  if (!topicId) return undefined;
  const topic = await getTopicStrict(topicId, dataDir).catch(() => null);
  return topic && latestDecision(topic) === "authored" ? topic.founderAngle?.direction : undefined;
}
