/**
 * 派生公众号文章推草稿箱（Phase 2b）：只推批过的那一整包——选定标题、正文与配图（web 图带署名图说）、
 * 一张封面主图 + 两个裁切、设置里的署名、摘要。推之前核源视频没过期、批准仍有效（包指纹 = 批准时的指纹）。
 *
 * 幂等：同一个批准指纹已经有草稿 → 直接回那个 media_id，不再推第二份。
 * 包变了（重新批过）再推 → 旧草稿记为 superseded 并告诉创始人；草稿从不删除。
 * 已定时 / 等扫码 / 已发 → 不重推（先请创始人在后台取消再 record_absent）。结果不明 → 先核对。
 * 推送失败 → 原始报错照给，状态 failed；不退回复制粘贴。
 */
import { loadProfile } from "../profile/creator-profile.js";
import { lineStoppedReason } from "../profile/platform-lines.js";
import { publishWechatMpDraft, type WechatMpDraftResult } from "../publish/wechat-mp.js";
import { loadWechatMpConfig } from "../publish/wechat-config.js";
import { scanText } from "../filter/sensitive-words.js";
import { stagePackage, type Staged } from "./push-stage.js";
import { cropParam } from "./cover.js";
import { withArticleLock } from "./package.js";
import { reopenIfApprovalBroken } from "./approve.js";
import { getContent } from "../../storage/local-store.js";
import { articleReviewState, isDerivedArticle, type ArticleReviewState } from "./review.js";
import { COMMITTED, nextStep, readPublishState, withAttempt, writePublishState, type ArticlePublishState } from "./publish-state.js";

type Result = Record<string, unknown>;
export interface PushDeps { publishImpl?: typeof publishWechatMpDraft; now?: () => Date }

const fail = (code: string, error: string, extra: Result = {}): Result => ({ ok: false, code, error, ...extra });

export async function isDerivedArticleId(contentId: unknown, dataDir: string): Promise<boolean> {
  if (typeof contentId !== "string" || !contentId.trim()) return false;
  const c = await getContent(contentId.trim(), dataDir).catch(() => null);
  return isDerivedArticle(c);
}

/** 批过的包能不能发：源没过期、批准还对得上现在的包 */
export type Approved = { state: ArticleReviewState } | { refusal: { ok: false; code: string; error: string } };

export async function approvedArticle(contentId: string, dataDir: string): Promise<Approved> {
  const s = await articleReviewState(contentId, dataDir, { fresh: true });
  const no = (code: string, error: string): Approved => ({ refusal: { ok: false, code, error } });
  if ("error" in s) return no(s.code, s.error);
  const stopped = lineStoppedReason(await loadProfile(dataDir), "wechat_article");
  if (stopped) return no("line_unpicked", stopped);
  if (s.stale) return no("derived_stale", `这条派生稿过期了，不能发：${s.stale}`);
  if (!s.pkg.approval) return no("article_not_approved", "图文包还没批：先在「等你拍板」的认稿那件里批整包，再推草稿箱");
  if (!s.approval.ok) {
    // 批后改了设置里的东西（排版主题）不经过改包的工具：在这儿退回认稿，让它重新出现在「等你拍板」
    const reopened = await reopenIfApprovalBroken(contentId, dataDir);
    return no("article_not_approved", `批准已失效（${s.approval.reason}）：重新给创始人看审阅页并批过，再推${reopened ? `；${reopened}` : ""}`);
  }
  if (!s.pkg.theme) return no("article_not_approved", "批准里没记排版主题：重新给创始人看审阅页并批过，再推");
  if (s.problems.length) return no("article_not_ready", `图文包有问题，不能推：${s.problems.join("；")}`);
  return { state: s };
}

export interface PushOpts { force?: boolean; dryRun?: boolean }

export async function pushApprovedArticle(contentId: string, dataDir: string, deps: PushDeps = {}, opts: PushOpts = {}): Promise<Result> {
  return withArticleLock(contentId, async () => {
    const a = await approvedArticle(contentId, dataDir);
    if ("refusal" in a) return a.refusal;
    const s = a.state;
    const now = deps.now?.() ?? new Date();
    let st = await readPublishState(contentId, dataDir);
    if (st.inFlight) st = await interrupted(contentId, st, dataDir, now);
    const guard = pushGuard(st, s.hash);
    if (guard) return guard;
    const scan = await scanText(`${s.pkg.chosenTitle}\n\n${s.content.body ?? ""}`, "wechat_mp", dataDir);
    const violations = scan.hits.map((h) => h.word);
    if (violations.length && !opts.force) return fail("sensitive_words", `审核员阻断推送：命中违禁词「${violations.join("、")}」。改稿（改完要重批）后再推`, { violations });
    let staged: Staged;
    try { staged = await stagePackage(contentId, s, dataDir, now); } catch (e) {
      return fail("stage_failed", `推送前暂存这一包失败（没有调公众号）：${e instanceof Error ? e.message : String(e)}`);
    }
    if (opts.dryRun) return dryRunResult(s, staged, st);
    return runPush(contentId, s, staged, superseded(st, now), dataDir, deps, now);
  });
}

/** 上次推送调了脚本却没落结果（进程中断）：草稿可能已经建了，进 unknown 先核对 */
async function interrupted(contentId: string, st: ArticlePublishState, dataDir: string, now: Date): Promise<ArticlePublishState> {
  const raw = `上次推送 ${st.inFlight!.startedAt} 开始后没有结果（进程中断），草稿可能已经建了`;
  const next = withAttempt({ ...st, phase: "unknown", unknownFrom: st.phase ?? "pushed_draft", unknownRaw: raw, inFlight: undefined }, { action: "push_draft", ok: false, raw }, now);
  return writePublishState(contentId, next, dataDir);
}

/** 不能推的情况：结果不明、已交到平台手里（不管有没有 media_id）、同一包已经有草稿 */
function pushGuard(st: ArticlePublishState, hash: string): Result | null {
  if (st.phase === "unknown") return fail("reconcile_first", nextStep(st), { phase: st.phase });
  const draft = st.mediaId ?? st.foundDraft?.mediaId ?? null;
  if (st.phase && COMMITTED.has(st.phase)) {
    if (st.packageHash === hash) return { ok: true, reused: true, media_id: draft, phase: st.phase, next_step: nextStep(st), note: "这一包已经定时 / 发表了，没有再推" };
    return fail("already_committed", `旧版已经${st.phase === "published" ? "发表" : "定时 / 在等扫码"}（草稿 ${draft ?? "身份见 found_draft"}）：包改过了也不能再推一份。请创始人先在公众号后台取消那次定时（发表了就不能撤），再 record_absent，之后才能推新包`, { phase: st.phase });
  }
  if ((st.mediaId || st.foundDraft) && st.packageHash === hash) return { ok: true, reused: true, media_id: draft, found_draft: st.foundDraft ?? null, pushed_at: st.pushedAt, phase: st.phase, next_step: nextStep(st), note: "这一包已经在草稿箱里了，没有再推第二份" };
  return null;
}

function dryRunResult(s: ArticleReviewState, staged: Staged, st: ArticlePublishState): Result {
  const c = s.pkg.cover!;
  return {
    ok: true, dry_run: true, note: "预演：没有调公众号，也没有改发布状态", title: s.pkg.chosenTitle, article_path: staged.articlePath, cover: staged.coverPath,
    crop_235: cropParam(c.crops["2.35:1"]), crop_1_1: cropParam(c.crops["1:1"]), images: staged.images.filter(Boolean), digest: s.content.digest ?? null,
    would_supersede: st.mediaId && st.packageHash !== s.hash ? st.mediaId : null,
  };
}

/** 旧草稿（别的包）记为 superseded；不删 */
function superseded(st: ArticlePublishState, now: Date): ArticlePublishState {
  const id = st.mediaId ?? st.foundDraft?.mediaId ?? (st.foundDraft ? `标题「${st.foundDraft.title}」更新于 ${st.foundDraft.updatedAt}` : undefined);
  if (!id || !st.packageHash) return st;
  const old = { mediaId: id, packageHash: st.packageHash, account: st.account ?? "?", pushedAt: st.pushedAt ?? "?", supersededAt: now.toISOString() };
  return { ...st, superseded: [...st.superseded, old], mediaId: undefined, packageHash: undefined, pushedAt: undefined, slot: undefined, receipt: undefined, foundDraft: undefined, phase: undefined };
}

async function runPush(contentId: string, s: ArticleReviewState, staged: Staged, st0: ArticlePublishState, dataDir: string, deps: PushDeps, now: Date): Promise<Result> {
  const cfg = await loadWechatMpConfig(dataDir);
  const c = s.pkg.cover!;
  const st = await writePublishState(contentId, { ...st0, inFlight: { packageHash: s.hash, startedAt: now.toISOString() } }, dataDir);
  let r: WechatMpDraftResult;
  try {
    r = await (deps.publishImpl ?? publishWechatMpDraft)({
      articlePath: staged.articlePath, title: s.pkg.chosenTitle!, coverPath: staged.coverPath, coverCrops: { crop235: cropParam(c.crops["2.35:1"]), crop11: cropParam(c.crops["1:1"]) },
      preparedImages: staged.images, skipImages: true, strictImages: true, digest: s.content.digest, author: cfg.author || "",
      wechatAppId: cfg.wechatAppId, wechatAppSecret: cfg.wechatAppSecret, openComment: cfg.openComment, theme: s.pkg.theme!,
      wechatPublishScript: cfg.wechatPublishScript, apiProxy: cfg.apiProxy,
    });
  } catch (e) {
    r = { ok: false, articlePath: staged.articlePath, publishInput: staged.articlePath, coverPath: staged.coverPath, imageCount: 0, generatedImages: [], error: `推送进程异常：${e instanceof Error ? e.message : String(e)}` };
  }
  return recordPush(contentId, s.hash, { ...st, inFlight: undefined }, r, cfg.wechatAppId ?? "未配置 AppID", dataDir, now);
}

/**
 * 明确没到「建草稿」那一步的失败（Codex 审 2b P1-4）：凭证 / token、本地文件与环境、标题超限、图片上传失败、
 * draft/add 明确回了 errcode。其余（超时、连接断开、进程异常、说不清的退出）都可能已经建了草稿 → unknown。
 */
const PRE_SEND = /获取 access_token 失败|未配置公众号|Article not found|script not found|uv 未安装|标题过长|上传封面图失败|封面上传失败|所有图片上传失败|--strict-images|推送草稿箱失败 \(errcode=|必须有封面图/;

export function classifyPush(r: WechatMpDraftResult): "ok" | "failed" | "unknown" {
  if (r.ok && r.mediaId) return "ok";
  if (r.ok) return "unknown";
  return PRE_SEND.test([r.error, r.stdout, r.stderr].filter(Boolean).join("\n")) ? "failed" : "unknown";
}

async function recordPush(contentId: string, hash: string, st: ArticlePublishState, r: WechatMpDraftResult, account: string, dataDir: string, now: Date): Promise<Result> {
  const raw = [r.error, r.stdout?.trim().slice(-600), r.stderr?.trim().slice(-600)].filter(Boolean).join("\n");
  const old = st.superseded.at(-1);
  const supersededNote = old && old.packageHash !== hash && old.supersededAt === now.toISOString()
    ? { superseded_draft: old.mediaId, superseded_note: `旧草稿 ${old.mediaId} 是旧版图文包，已标为作废；草稿箱里删不删由你在公众号后台自己处理（这里从不删草稿）` } : {};
  const kind = classifyPush(r);
  if (kind === "ok") {
    const next = withAttempt({ ...st, phase: "pushed_draft", account, mediaId: r.mediaId, packageHash: hash, pushedAt: now.toISOString() }, { action: "push_draft", ok: true, mediaId: r.mediaId }, now);
    await writePublishState(contentId, next, dataDir);
    return { ok: true, reused: false, media_id: r.mediaId, pushed_at: next.pushedAt, account, phase: next.phase, next_step: nextStep(next), ...supersededNote };
  }
  if (kind === "unknown") {
    const next = withAttempt({ ...st, phase: "unknown", unknownFrom: "pushed_draft", unknownRaw: raw, account, packageHash: hash }, { action: "push_draft", ok: false, raw }, now);
    await writePublishState(contentId, next, dataDir);
    return fail("push_unknown", `推送结果不明，草稿可能已经建了：${nextStep(next)}`, { raw, phase: "unknown", ...supersededNote });
  }
  const next = withAttempt({ ...st, phase: "failed", account }, { action: "push_draft", ok: false, raw }, now);
  await writePublishState(contentId, next, dataDir);
  return fail("push_failed", r.error ?? "公众号推送失败（没有原因）", { raw, phase: "failed", next_step: nextStep(next), ...supersededNote });
}
