/**
 * `autocrew_content {action:"en_edition", content_id, edition:{op, …}}` —— 由审过的中文成片派生的英文版（全媒体 spec §3.1 / §3.3、Phase 3）。
 *
 * op：derive（从审过的视频派生，幂等）/ source（成片字幕的时间槽）/ set_script（逐段中英对照 + 换例）/ verify_quote（替换例的事实出处）/
 * status（中英对照审阅页 + 还差什么）/ dub（按批过的脚本 ElevenLabs 配音 + 排时清单）/ captions（字幕分条）/ chapters（YouTube 章节时间）/
 * set_thumbnail（16:9 缩略图登记）。认稿（批脚本）不在这里：走 autocrew_review_inbox 的认稿那件，批的是 status 给的同一份脚本。
 * 参数按 AGENTS.md 归一：edition / segments / swaps 可以是 JSON 字符串。
 */
import { getContent, getDataDir, transitionStatus, updateContent, normalizeLegacyStatus } from "../storage/local-store.js";
import { deriveSibling } from "../modules/lineage/lineage.js";
import { isFrozen, readProductionDoc, ScriptFrozenError } from "../storage/production-store.js";
import { escapeStrayQuotes } from "../modules/video/tool-args.js";
import { verifyQuote } from "../modules/draft/verify-quote.js";
import { enSource } from "../modules/en-edition/source.js";
import { buildSegments } from "../modules/en-edition/script-input.js";
import { readEnScript, scriptBody, scriptHash, segmentBudget, withEnLock, writeEnScript } from "../modules/en-edition/script.js";
import { enApprovalText, enReviewState, isEnEdition, renderEnReviewPage } from "../modules/en-edition/review.js";
import { captionsOp, chaptersOp, dubOp, mediaStatus, packageStatusOp, thumbnailOp } from "./en-edition-media.js";
import { enFinalCheck } from "../modules/en-edition/publish-out.js";
import { rebindEnEditionLocked } from "../modules/en-edition/rebind.js";
import { staleReason } from "../modules/lineage/lineage.js";

type Result = Record<string, unknown>;
const OPS = ["derive", "rebind", "source", "set_script", "verify_quote", "status", "dub", "captions", "chapters", "set_thumbnail", "package_status", "final_check"] as const;
type Op = (typeof OPS)[number];
const fail = (code: string, error: string): Result => ({ ok: false, code, error });
const str = (v: unknown) => (typeof v === "string" ? v.trim().replace(/^"+|"+$/g, "").trim() : "");

export const EN_EDITION_ACTION_DOC =
  "'en_edition' 审过的中文成片派生英文版（YouTube / X），content_id + edition{op, …}，op: derive{content_id:源视频} / rebind（源视频成片换版后绑到新成片：没变的段留着、变了的标出来，批准撤掉重审） / source（字幕时间槽） / set_script{segments:[{cues:\"1-2\",en,swaps?:[{from,to,reason,factual?,evidence_id?}],keyword?}]} / verify_quote{url,quote,claim?} / status（中英对照审阅页） / dub（脚本批过后配音） / captions / chapters / set_thumbnail{path} / package_status（英文发布包审阅页） / final_check{platform}（点安排 / 发帖前必调）";

async function derive(params: Result, dataDir: string): Promise<Result> {
  const r = await deriveSibling(str(params.content_id ?? params.id), "en_edition", dataDir);
  if (!r.ok) return { ok: false, code: r.code, error: r.error };
  // 已有的那条是按旧成片做的：不另建，指路 rebind
  const stale = r.created ? null : await staleReason(r.content, dataDir);
  if (stale) return { ok: true, created: false, content_id: r.content.id, title: r.content.title, platform: r.content.platform, stale, next_action: { tool: "autocrew_content", params: { action: "en_edition", content_id: r.content.id, edition: { op: "rebind" } } } };
  return {
    ok: true, created: r.created, content_id: r.content.id, title: r.content.title, platform: r.content.platform,
    next_action: { tool: "autocrew_content", params: { action: "en_edition", content_id: r.content.id, edition: { op: "source" } }, message: "读成片字幕的时间槽，按 §3.3 写逐段英文（轻本地化、每段守时间预算），再 set_script" },
    note: "缩略图同时开做：派 Codex 按 cover-generator 的「英文版 16:9 缩略图」出图，出好后 set_thumbnail 登记",
  };
}

async function source(id: string, dataDir: string): Promise<Result> {
  const s = await enSource((await getContent(id, dataDir))!, dataDir);
  if (!s.ok) return { ok: false, code: s.code, error: s.error };
  return { ok: true, cues: s.source.cues.map((c) => ({ cue: c.index, start_s: c.startMs / 1000, end_s: c.endMs / 1000, zh: c.text })), ledger: s.source.ledger,
    rules: "每段对一组连续字幕（cues:\"起-止\"），按字幕顺序覆盖全部；英文比中文长 5–25%，写紧，守住每段时间槽；换掉的例子写进 swaps（原例 → 替换例 + 理由），替换例带事实就 factual:true 并先 verify_quote 拿 evidence_id；不编事实" };
}

async function setScript(id: string, params: Result, dataDir: string): Promise<Result> {
  const c = (await getContent(id, dataDir))!;
  const s = await enSource(c, dataDir);
  if (!s.ok) return { ok: false, code: s.code, error: s.error };
  const segments = buildSegments(params.segments, s.source.cues);
  if (typeof segments === "string") return fail("invalid_params", segments);
  const prev = await readEnScript(id, dataDir);
  const script = { sourceCutHash: c.derivedFrom!.sourceCutHash, segments, ...(prev?.approval ? { approval: prev.approval } : {}) };
  // 原样重交（重试 / 双击）：什么都不动，批准照旧
  if (prev && scriptHash(prev) === scriptHash(script) && scriptBody(script) === c.body) {
    return { ok: true, unchanged: true, segments: segments.length, script_hash: scriptHash(script), note: "脚本和现在这份一模一样：没有改动，批准和状态都不动" };
  }
  // 剪辑中正文冻结：先判，冻结时脚本和正文都不动（不留下脚本改了、正文没改的半截）
  if (scriptBody(script) !== c.body && isFrozen(await readProductionDoc(id, dataDir))) return fail("script_frozen", new ScriptFrozenError().message);
  // 先改正文（会被拒的写口在前），成功了再落脚本；英文脚本是模型把审过的中文成片改写成英文：来源按改写源视频记
  try { await updateContent(id, { _provenance: { kind: "model", derivedFrom: c.derivedFrom!.contentId }, body: scriptBody(script) }, dataDir); }
  catch (e) { return fail(e instanceof ScriptFrozenError ? "script_frozen" : "body_write_failed", `脚本没存（正文写不进去）：${e instanceof Error ? e.message : String(e)}`); }
  await writeEnScript(id, script, dataDir);
  const moved = await toReview(id, dataDir);
  const state = await enReviewState(id, dataDir);
  const problems = "error" in state ? [state.error] : state.problems;
  return { ok: true, segments: segments.length, script_hash: scriptHash(script), problems, ...(moved ? { status_warning: moved } : {}),
    over_budget: segments.filter((x) => segmentBudget(x).over).map((x) => ({ segment: x.index, ...segmentBudget(x) })),
    next_action: "op:\"status\" 拿中英对照审阅页；没有 problems 后 autocrew_review_inbox list 把认稿那件给创始人看" };
}

/** 交了脚本 = 等创始人看：放进「等你拍板」（已批过又改了也回到待看——批准已按指纹失效） */
async function toReview(id: string, dataDir: string): Promise<string | null> {
  const c = (await getContent(id, dataDir))!;
  const status = normalizeLegacyStatus(c.status);
  if (status === "draft_ready") return null;
  const r = await transitionStatus(id, "draft_ready", { force: true, expectedStatus: status }, dataDir);
  return r.ok ? null : `脚本已存，但没放进待认稿（${r.error}）：创始人暂时在「等你拍板」里看不到它`;
}

async function quote(id: string, params: Result, dataDir: string): Promise<Result> {
  const url = str(params.url), q = typeof params.quote === "string" ? params.quote : "";
  if (!url || !q.trim()) return fail("bad_param", "verify_quote 要 url 和 quote（原网页里逐字复制的一段）");
  const r = await verifyQuote(id, url, q, typeof params.claim === "string" ? params.claim : undefined, dataDir);
  return r.ok ? { ...r, next_action: "把 evidence_id 填进对应 swap 的 evidence_id，重交 set_script" } : { ...r };
}

async function status(id: string, dataDir: string): Promise<Result> {
  const s = await enReviewState(id, dataDir);
  if ("error" in s) return fail(s.code, s.error);
  const page = await renderEnReviewPage(s, dataDir);
  return { ok: true, content_id: id, review_page: page, problems: s.problems, ready_to_approve: s.problems.length === 0, approval: enApprovalText(s), script_hash: s.hash, ...(await mediaStatus(id, s, dataDir)) };
}

/** 子参数收在 edition 对象里（可能是 JSON 字符串：解析，修引号再试）；顶层同名参数也认 */
export function editionArgs(params: Result): Result | string {
  const raw = params.edition;
  if (raw === undefined || raw === null || raw === "") return params;
  if (typeof raw === "object" && !Array.isArray(raw)) return { ...params, ...(raw as Result) };
  if (typeof raw !== "string") return `edition 必须是对象（或对象的 JSON 字符串），收到的是 ${typeof raw}`;
  for (const text of [raw, escapeStrayQuotes(raw)]) {
    try {
      const v = JSON.parse(text) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return { ...params, ...(v as Result) };
    } catch { /* 下一种修法 */ }
  }
  return "edition 解析不了：要一个对象，如 {\"op\":\"status\"}";
}

export async function executeEnEdition(raw: Result): Promise<Result> {
  const params = editionArgs(raw);
  if (typeof params === "string") return fail("invalid_params", params);
  const dataDir = getDataDir(typeof params._dataDir === "string" ? params._dataDir : undefined);
  const op = str(params.op) as Op;
  if (!OPS.includes(op)) return fail("invalid_params", `en_edition 的 op 只能是 ${OPS.join(" | ")}`);
  if (op === "derive") return derive(params, dataDir);
  const id = str(params.content_id ?? params.id);
  const c = id ? await getContent(id, dataDir).catch(() => null) : null;
  if (!c) return fail("not_found", `稿件不存在：${id || "(空)"}`);
  if (!isEnEdition(c)) return fail("not_en_edition", "这条不是由视频派生的英文版：先对源视频 en_edition derive");
  if (op === "source") return source(c.id, dataDir);
  if (op === "status") return status(c.id, dataDir);
  if (op === "chapters") return chaptersOp(c.id, dataDir);
  if (op === "package_status") return packageStatusOp(c.id, dataDir);
  if (op === "final_check") return enFinalCheck(c.id, str(params.platform), dataDir);
  if (op === "rebind") return rebindEnEditionLocked(c.id, dataDir);
  return withEnLock(c.id, () => mutate(op, c.id, params, dataDir));
}

function mutate(op: Op, id: string, params: Result, dataDir: string): Promise<Result> {
  switch (op) {
    case "set_script": return setScript(id, params, dataDir);
    case "verify_quote": return quote(id, params, dataDir);
    case "dub": return dubOp(id, dataDir);
    case "captions": return captionsOp(id, dataDir);
    case "set_thumbnail": return thumbnailOp(id, str(params.path), dataDir);
    default: return Promise.resolve(fail("invalid_params", `未知 op：${op}`));
  }
}
