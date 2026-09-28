/** 用户确认的写作档案与反馈。原话、作用域、稿件指纹一起留存。 */
import fs from "node:fs/promises";
import path from "node:path";
import { draftHash } from "../storage/draft-hash.js";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getContent, getDataDir, updateContentIfDraftMatches, LOCAL_HOST, type Content } from "../storage/local-store.js";
import { gateClaimWrite } from "../storage/claims.js";
import { initProfile, loadProfile, saveProfile, addWritingRule, type CreatorProfile } from "../modules/profile/creator-profile.js";
import { appendWritingFeedback } from "../modules/writing/writing-feedback.js";
import { serializeWriterCall } from "./writer-pack.js";
import { cleanErrorMessage } from "../desktop/error-clean.js";
import { revisionNextAction } from "./writer-revision.js";
import { withTokenInNextAction } from "./claim-grant.js";

const text = Type.String({ minLength: 1, maxLength: 12000 });
const strings = Type.Array(text);
const tier = Type.Object({ name: text, age: Type.Optional(text), job: Type.Optional(text), coreAnxiety: Type.Optional(text), painPoints: Type.Optional(strings), scrollStopTriggers: Type.Optional(strings) }, { additionalProperties: false });
const profilePatch = Type.Object({
  industry: Type.Optional(Type.String()), expressionPersona: Type.Optional(Type.String()), platforms: Type.Optional(strings),
  contentFormat: Type.Optional(Type.Object({ videoLength: Type.Optional(Type.String()), contentDepth: Type.Optional(Type.String()), wordCount: Type.Optional(Type.String()) }, { additionalProperties: false })),
  audiencePersona: Type.Optional(Type.Union([Type.Null(), Type.Object({ core: tier, adjacent: Type.Optional(tier), surprise: Type.Optional(tier) }, { additionalProperties: false })])),
  styleBoundaries: Type.Optional(Type.Object({ never: strings, always: strings }, { additionalProperties: false })),
  voiceSamples: Type.Optional(Type.Array(text, { maxItems: 5 })),
}, { additionalProperties: false });
export const editorialSchema = Type.Object({
  action: Type.Union([Type.Literal("profile"), Type.Literal("update_profile"), Type.Literal("inspect"), Type.Literal("feedback")]),
  profile: Type.Optional(profilePatch),
  user_confirmed: Type.Optional(Type.Boolean({ description: "仅用户已明确表达/确认这些信息时为true，不得把模型建议当用户反馈。" })),
  confirm_audience: Type.Optional(Type.Boolean({ description: "用户明确认可本次提交的受众画像时设true；不传表示提案。" })),
  content_id: Type.Optional(text), draft_hash: Type.Optional(text),
  event_id: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]{1,100}$", description: "一次反馈的稳定标识，重试必须复用。" })),
  feedback: Type.Optional(text),
  selection: Type.Optional(Type.String({ minLength: 1, maxLength: 12000, description: "仅修改本稿一段时逐字传入原选区；只适用于scope=draft，不能把局部改法推广全文。" })),
  scope: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("platform"), Type.Literal("voice")], { description: "默认draft只影响这篇。只有用户明确长期偏好时用platform或voice，禁止自动推广局部改法。" })),
  platform: Type.Optional(text),
  verdict: Type.Optional(Type.Union([Type.Literal("adopted"), Type.Literal("light_edit"), Type.Literal("rewritten"), Type.Literal("rejected")], { description: "用户的实际采纳评价；AI审稿通过不算采纳。" })),
  claim_token: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "feedback：这篇有活认领时必须带（writer pack/submit 或 autocrew_desk claim 回的令牌），同宿主的另一个会话也一样；inspect/profile 只读不用带。" })),
}, { additionalProperties: false });
type Args = Static<typeof editorialSchema>;

export const EDITORIAL_DESCRIPTION = "Read/calibrate the writing profile and persist explicit user feedback. profile reads current style/audience; update_profile saves confirmed fields (confirm_audience only after user approval). inspect{content_id} returns draft_hash and feedback receipts. feedback{content_id,draft_hash,event_id,feedback,scope?,verdict?,claim_token?,user_confirmed:true} keeps exact words; it writes onto the draft, so a claimed draft needs the matching claim_token (same host included) or it returns claim_held, defaults to this draft, and records actual user adoption/rejection. Long-term rules require explicit platform/voice scope; no automatic generalization. Reuse event_id on retries. Feedback does not rewrite the draft: force a new writer pack to apply it.";

const queues = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(work);
  queues.set(key, next);
  try { return await next; } finally { if (queues.get(key) === next) queues.delete(key); }
}
/** 稿件指纹：算法在 storage/draft-hash（modules 层也要用，不能反向 import 本文件） */
export const editorialDraftHash = draftHash;
async function checkedProfile(dir: string): Promise<CreatorProfile | null> {
  // loadProfile 的容错 null 不能被这里解释成可覆盖已有损坏档案。
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, "creator-profile.json"), "utf8"));
    if (!raw || !Array.isArray(raw.writingRules) || !Array.isArray(raw.platforms)) throw new Error("档案结构不完整");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("写作档案无法读取，请先修复；未覆盖现有文件");
  }
  return loadProfile(dir);
}
function profileView(p: CreatorProfile | null) {
  if (!p) return null;
  const { industry, expressionPersona, platforms, contentFormat, audiencePersona, writingRules, styleBoundaries, voiceSamples, styleCalibrated, updatedAt } = p;
  return { industry, expressionPersona, platforms, contentFormat, audiencePersona, writingRules, styleBoundaries, voiceSamples, styleCalibrated, updatedAt };
}
interface Receipt {
  event_id: string; content_id: string; draft_hash: string; feedback: string; scope: "draft" | "platform" | "voice";
  platform?: string; selection?: string; verdict?: Args["verdict"]; at: string; state: "pending" | "applied";
}
async function writeReceipt(file: string, receipt: Receipt): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(receipt, null, 2));
  await fs.rename(`${file}.tmp`, file);
}
async function receipts(dir: string, id: string): Promise<Receipt[]> {
  const folder = path.join(dir, "editorial-feedback");
  let names: string[];
  try { names = await fs.readdir(folder); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const all = await Promise.all(names.filter(n => n.endsWith(".json")).map(async n => JSON.parse(await fs.readFile(path.join(folder, n), "utf8")) as Receipt));
  return all.filter(r => r.content_id === id).sort((a, b) => a.at.localeCompare(b.at));
}
async function capture(a: Args, dir: string, host: string): Promise<Record<string, unknown>> {
  if (!a.content_id || !a.draft_hash || !a.event_id || !a.feedback?.trim()) return { ok: false, error: "feedback需要content_id、inspect返回的draft_hash、event_id和用户原话feedback" };
  const scope = a.scope ?? "draft";
  if (scope === "platform" && !a.platform?.trim()) return { ok: false, error: "platform作用域必须指定platform" };
  if (a.selection && scope !== "draft") return { ok: false, error: "选区反馈仅适用于本稿，不能直接升格长期规则" };
  const event = { event_id: a.event_id, content_id: a.content_id, draft_hash: a.draft_hash, feedback: a.feedback, scope, ...(a.selection ? { selection: a.selection } : {}), ...(scope === "platform" ? { platform: a.platform } : {}), ...(a.verdict ? { verdict: a.verdict } : {}) };
  const file = path.join(dir, "editorial-feedback", `${a.event_id}.json`);
  let prior: Receipt | undefined;
  try { prior = JSON.parse(await fs.readFile(file, "utf8")) as Receipt; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (prior) {
    const saved = Object.fromEntries(Object.entries(prior).filter(([key]) => key !== "at" && key !== "state"));
    if (JSON.stringify(saved) !== JSON.stringify(event)) return { ok: false, error: "event_id已用于不同反馈，请勿改写原事件" };
    if (prior.state === "applied") {
      const content = await getContent(a.content_id, dir);
      return { ok: true, status: "recorded", replayed: true, receipt: prior, ...(content ? { next_action: await revisionNextAction(content, dir) } : {}) };
    }
  }
  return serializeWriterCall(a.content_id, async () => {
    const content = await getContent(a.content_id!, dir);
    if (!content) return { ok: false, error: "稿件不存在" };
    if (editorialDraftHash(content) !== a.draft_hash) return { ok: false, status: "stale_draft", error: "正文已变化，先inspect并核对用户评价的是哪一版；未把反馈套到新稿" };
    if (a.selection && !content.body.includes(a.selection)) return { ok: false, error: "selection必须逐字引用当前正文中的原选区" };
    const existingProfile = scope === "draft" ? null : await checkedProfile(dir);
    // 写门（P6 §3.8）：核对完才过门，免得一次作废的反馈也把稿认领走；工作台 local-user 越门记账
    const gate = await gateClaimWrite(content.id, { host, employee: "writer", token: a.claim_token?.trim() || undefined }, dir);
    if ("denied" in gate) return gate.denied;
    const receipt: Receipt = prior ?? { ...event, at: new Date().toISOString(), state: "pending" };
    await writeReceipt(file, receipt);
    const applied = await updateContentIfDraftMatches(content.id, content, (latest) => ({
      ...(scope === "draft" ? { writingFeedback: latest.writingFeedback?.some(f => f.at === receipt.at && f.instruction === a.feedback!.trim())
        ? latest.writingFeedback
        : appendWritingFeedback(latest.writingFeedback, a.feedback!, a.selection ? "selection" : "whole", { at: receipt.at, selection: a.selection }) } : {}),
      ...(a.verdict ? { adoption: { verdict: a.verdict, recordedAt: receipt.at, draftHash: a.draft_hash } } : {}),
    }), dir);
    if (!applied.ok) return { ok: false, status: "stale_draft", error: "保存反馈前正文已变化，反馈未套到新稿；先inspect核对版本", ...gate.grant };
    if (scope !== "draft") {
      const ruleScope = scope === "voice" ? "voice_core" : `platform:${a.platform}` as const;
      await addWritingRule({ rule: a.feedback!, scope: ruleScope, source: "user_explicit", confidence: 1,
        evidence: [`feedback:${content.id}:${a.draft_hash}:${a.feedback}`] }, dir);
    }
    receipt.state = "applied";
    await writeReceipt(file, receipt);
    return withTokenInNextAction({ ok: true, status: "recorded", receipt, next_action: await revisionNextAction(applied.content, dir), ...gate.grant });
  });
}
export async function executeEditorial(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { _dataDir, ...publicArgs } = params;
  // ToolRunner 还可注入其他私有字段，只检查公开契约。
  const args = Object.fromEntries(Object.entries(publicArgs).filter(([k]) => !k.startsWith("_")));
  if (!Value.Check(editorialSchema, args)) return { ok: false, error: "写作档案/反馈参数不符合工具契约" };
  const a = args as Args;
  const dir = getDataDir(typeof _dataDir === "string" ? _dataDir : undefined);
  const host = typeof params._host === "string" && params._host.trim() ? params._host.trim() : LOCAL_HOST;
  try {
    return await serialized(dir, async () => {
      if (a.action === "profile") return { ok: true, profile: profileView(await checkedProfile(dir)) };
      if (a.action === "inspect") {
        const content = a.content_id ? await getContent(a.content_id, dir) : null;
        if (!content) return { ok: false, error: "inspect需要有效content_id" };
        return { ok: true, content_id: content.id, title: content.title, platform: content.platform, draft_hash: editorialDraftHash(content), adoption: content.adoption, adoption_applies_to_current: Boolean(content.adoption?.draftHash && content.adoption.draftHash === editorialDraftHash(content)), feedback: await receipts(dir, content.id) };
      }
      if (a.user_confirmed !== true) return { ok: false, error: "只记录用户明确表达或确认的信息，不能把模型推测当成用户反馈" };
      if (a.action === "feedback") return capture(a, dir, host);
      if (!a.profile || !Object.keys(a.profile).length) return { ok: false, error: "update_profile需要profile字段" };
      if (a.confirm_audience && !a.profile.audiencePersona) return { ok: false, error: "confirm_audience需要本次提交用户认可的完整画像" };
      const profile = (await checkedProfile(dir)) ?? await initProfile(dir);
      const patch = { ...a.profile };
      if (patch.audiencePersona) {
        const unchanged = JSON.stringify(patch.audiencePersona) === JSON.stringify(profile.audiencePersona ? { core: profile.audiencePersona.core, ...(profile.audiencePersona.adjacent ? { adjacent: profile.audiencePersona.adjacent } : {}), ...(profile.audiencePersona.surprise ? { surprise: profile.audiencePersona.surprise } : {}) } : null);
        patch.audiencePersona = { ...patch.audiencePersona, ...(a.confirm_audience ? { calibratedAt: new Date().toISOString() } : unchanged && profile.audiencePersona?.calibratedAt ? { calibratedAt: profile.audiencePersona.calibratedAt } : {}) };
      }
      const updated = { ...profile, ...patch, ...(patch.contentFormat ? { contentFormat: { ...profile.contentFormat, ...patch.contentFormat } } : {}) };
      await saveProfile(updated, dir);
      return { ok: true, profile: profileView(updated), note: "已保存；已有写作包需force:true重领，正文未自动改写" };
    });
  } catch (err) { return { ok: false, error: cleanErrorMessage(err) }; }
}
