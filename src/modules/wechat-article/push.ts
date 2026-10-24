/**
 * 派生公众号文章推草稿箱（Phase 2b）：只推批过的那一整包——选定标题、正文与配图（web 图带署名图说）、
 * 一张封面主图 + 两个裁切、设置里的署名、摘要。推之前核源视频没过期、批准仍有效（包指纹 = 批准时的指纹）。
 *
 * 幂等：同一个批准指纹已经有草稿 → 直接回那个 media_id，不再推第二份。
 * 包变了（重新批过）再推 → 旧草稿记为 superseded 并告诉创始人；草稿从不删除。
 * 已定时 / 等扫码 / 已发 → 不重推（先请创始人在后台取消再 record_absent）。结果不明 → 先核对。
 * 推送失败 → 原始报错照给，状态 failed；不退回复制粘贴。
 */
import { contentFile, resolveContentProject } from "../../storage/content-project.js";
import { projectMarkdownExport } from "../../storage/project-record.js";
import { writeTextAtomic } from "../../storage/json-atomic.js";
import { publishWechatMpDraft, type WechatMpDraftResult } from "../publish/wechat-mp.js";
import { loadWechatMpConfig } from "../publish/wechat-config.js";
import { scanText } from "../filter/sensitive-words.js";
import type { ArticleImageEntry } from "../publish/article-images.js";
import { cropParam } from "./cover.js";
import { withArticleLock } from "./package.js";
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
  if (s.stale) return no("derived_stale", `这条派生稿过期了，不能发：${s.stale}`);
  if (!s.pkg.approval) return no("article_not_approved", "图文包还没批：先在「等你拍板」的认稿那件里批整包，再推草稿箱");
  if (!s.approval.ok) return no("article_not_approved", `批准已失效（${s.approval.reason}）：重新给创始人看审阅页并批过，再推`);
  if (s.problems.length) return no("article_not_ready", `图文包有问题，不能推：${s.problems.join("；")}`);
  return { state: s };
}

/** 推送用的 markdown：标题 + 正文；web 图位后面跟一行斜体署名，排版脚本把它变成图下说明 */
export function articleMarkdown(title: string, body: string, entries: ArticleImageEntry[]): string {
  let k = 0;
  const withCredits = body.replace(/\[IMAGE:\s*(.+?)\]/g, (marker) => {
    const n = k++;
    const e = entries.find((x) => x.index === n);
    const web = e && (e.kind === "web" || e.origin === "web") && e.credit;
    return web ? `${marker}\n\n*${e.credit!.replace(/\*/g, "")}*` : marker;
  });
  return `# ${title}\n\n${withCredits}\n`;
}

export async function pushApprovedArticle(contentId: string, dataDir: string, deps: PushDeps = {}, opts: { force?: boolean } = {}): Promise<Result> {
  return withArticleLock(contentId, async () => {
    const a = await approvedArticle(contentId, dataDir);
    if ("refusal" in a) return a.refusal;
    const s = a.state;
    const st = await readPublishState(contentId, dataDir);
    if (st.phase === "unknown") return fail("reconcile_first", nextStep(st), { phase: st.phase });
    if (st.mediaId && st.packageHash === s.hash) return { ok: true, reused: true, media_id: st.mediaId, phase: st.phase, next_step: nextStep(st), note: "这一包已经在草稿箱里了，没有再推第二份" };
    if (st.mediaId && st.phase && COMMITTED.has(st.phase)) {
      return fail("already_committed", `旧版已经${st.phase === "published" ? "发表" : "定时 / 在等扫码"}（草稿 ${st.mediaId}）：包改过了也不能再推一份。请创始人先在公众号后台取消那次定时（发表了就不能撤），再 record_absent，之后才能推新包`, { phase: st.phase });
    }
    const scan = await scanText(`${s.pkg.chosenTitle}\n\n${s.content.body ?? ""}`, "wechat_mp", dataDir);
    const violations = scan.hits.map((h) => h.word);
    if (violations.length && !opts.force) return fail("sensitive_words", `审核员阻断推送：命中违禁词「${violations.join("、")}」。改稿（改完要重批）后再推`, { violations });
    return runPush(contentId, s, superseded(st, deps.now?.() ?? new Date()), dataDir, deps);
  });
}

/** 旧草稿（别的包）记为 superseded；不删 */
function superseded(st: ArticlePublishState, now: Date): ArticlePublishState {
  if (!st.mediaId || !st.packageHash) return st;
  const old = { mediaId: st.mediaId, packageHash: st.packageHash, account: st.account ?? "?", pushedAt: st.pushedAt ?? "?", supersededAt: now.toISOString() };
  return { ...st, superseded: [...st.superseded, old], mediaId: undefined, packageHash: undefined, pushedAt: undefined, slot: undefined, receipt: undefined, phase: undefined };
}

async function runPush(contentId: string, s: ArticleReviewState, st: ArticlePublishState, dataDir: string, deps: PushDeps): Promise<Result> {
  const now = deps.now?.() ?? new Date();
  const project = resolveContentProject(contentId, dataDir);
  const articlePath = contentFile(contentId, dataDir, "wechat-article-export.md");
  const md = articleMarkdown(s.pkg.chosenTitle!, s.content.body ?? "", s.images.entries);
  await writeTextAtomic(articlePath, project ? projectMarkdownExport(md, project.project_root) : md);
  const cfg = await loadWechatMpConfig(dataDir);
  const cover = s.pkg.cover!;
  const paths: string[] = [];
  for (const e of s.images.entries) if (e.imagePath) paths[e.index] = e.imagePath;
  let r: WechatMpDraftResult;
  try {
    r = await (deps.publishImpl ?? publishWechatMpDraft)({
      articlePath, title: s.pkg.chosenTitle!, coverPath: cover.path, coverCrops: { crop235: cropParam(cover.crops["2.35:1"]), crop11: cropParam(cover.crops["1:1"]) },
      preparedImages: paths, skipImages: true, strictImages: true, digest: s.content.digest, author: cfg.author || "",
      wechatAppId: cfg.wechatAppId, wechatAppSecret: cfg.wechatAppSecret, openComment: cfg.openComment, theme: cfg.theme || "newspaper",
      wechatPublishScript: cfg.wechatPublishScript, apiProxy: cfg.apiProxy,
    });
  } catch (e) {
    r = { ok: false, articlePath, publishInput: articlePath, coverPath: cover.path, imageCount: 0, generatedImages: [], error: e instanceof Error ? e.message : String(e) };
  }
  return recordPush(contentId, s.hash, st, r, cfg.wechatAppId ?? "未配置 AppID", dataDir, now);
}

async function recordPush(contentId: string, hash: string, st: ArticlePublishState, r: WechatMpDraftResult, account: string, dataDir: string, now: Date): Promise<Result> {
  const raw = [r.error, r.stderr?.trim().slice(-800)].filter(Boolean).join("\n");
  const old = st.superseded.at(-1);
  const supersededNote = old && old.packageHash !== hash && old.supersededAt === now.toISOString()
    ? { superseded_draft: old.mediaId, superseded_note: `旧草稿 ${old.mediaId} 是旧版图文包，已标为作废；草稿箱里删不删由你在公众号后台自己处理（这里从不删草稿）` } : {};
  if (r.ok && r.mediaId) {
    const next = withAttempt({ ...st, phase: "pushed_draft", account, mediaId: r.mediaId, packageHash: hash, pushedAt: now.toISOString() }, { action: "push_draft", ok: true, mediaId: r.mediaId }, now);
    await writePublishState(contentId, next, dataDir);
    return { ok: true, reused: false, media_id: r.mediaId, account, phase: next.phase, next_step: nextStep(next), ...supersededNote };
  }
  if (r.ok) {
    const out = (r.stdout ?? "").trim().slice(-800);
    const next = withAttempt({ ...st, phase: "unknown", unknownFrom: "pushed_draft", unknownRaw: out, account, packageHash: hash }, { action: "push_draft", ok: false, raw: `脚本成功退出但没报出草稿 media_id：${out}` }, now);
    await writePublishState(contentId, next, dataDir);
    return fail("push_unknown", `推送脚本退出了但没有报出草稿 media_id，草稿可能已经建了：${nextStep(next)}`, { raw: out, phase: "unknown", ...supersededNote });
  }
  const next = withAttempt({ ...st, phase: "failed", account }, { action: "push_draft", ok: false, raw }, now);
  await writePublishState(contentId, next, dataDir);
  return fail("push_failed", r.error ?? "公众号推送失败（没有原因）", { raw, phase: "failed", next_step: nextStep(next), ...supersededNote });
}
