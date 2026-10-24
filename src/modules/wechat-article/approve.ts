/**
 * 认稿 = 批整包（Phase 2a）：批之前核源视频没过期、包里没缺项；批的那一刻记下整包指纹。
 * 之后正文、标题、任何一张图、封面、创作来源变了，批准就失效（status / 审阅页写明是哪一包变了）；2b 的发布会按批准的那一包核。
 */
import { articleReviewState } from "./review.js";
import { approvePackage, packageApprovalCheck, readArticlePackage, writeArticlePackage } from "./package.js";
import { getArticleImageReview } from "../publish/article-images.js";
import { wechatTheme } from "../publish/wechat-config.js";
import { getContent, transitionStatus } from "../../storage/local-store.js";

export type GateResult = { ok: true; hash: string } | { ok: false; code: string; error: string };

/** expected = 给创始人看的那一包的指纹（认稿那件的 detail.package_hash）；现在的包对不上就拒，不拿他的话批另一包 */
export async function articleApproveGate(contentId: string, dataDir: string, expected: string | undefined): Promise<GateResult> {
  const s = await articleReviewState(contentId, dataDir, { fresh: true });
  if ("error" in s) return { ok: false, code: s.code, error: s.error };
  if (!expected || expected !== s.hash) return { ok: false, code: "stale", error: "图文包在给你看之后变了（标题 / 配图 / 封面 / 创作来源 / 正文）：重新看一眼审阅页再批" };
  if (s.stale) return { ok: false, code: "derived_stale", error: `这条派生稿过期了，不能批：${s.stale}` };
  if (s.problems.length) return { ok: false, code: "article_not_ready", error: `图文还不能批：\n${s.problems.map((p, i) => `${i + 1}) ${p}`).join("\n")}` };
  return { ok: true, hash: s.hash };
}

export async function recordArticleApproval(contentId: string, hash: string, dataDir: string): Promise<void> {
  const pkg = await readArticlePackage(contentId, dataDir);
  // 记下批准这一刻的主题；hash 是按同一刻设置算的。两者之间设置被改 → 下次核对指纹对不上，照样退回重批
  await writeArticlePackage(contentId, approvePackage(pkg, hash, await wechatTheme(dataDir)), dataDir);
}

/**
 * 批过之后包又变了（标题 / 封面 / 配图 / 创作来源 / 篇幅放行）：和改正文一样退回「等你拍板」的认稿，原因写明。
 * 只在稿件还停在 approved 时做；发布状态那边自己按指纹拦（已定时的不会被重推）。
 */
export async function reopenIfApprovalBroken(contentId: string, dataDir: string): Promise<string | null> {
  const content = await getContent(contentId, dataDir);
  if (!content || content.status !== "approved") return null;
  const pkg = await readArticlePackage(contentId, dataDir);
  if (!pkg.approval) return null;
  const check = await packageApprovalCheck(content, pkg, await getArticleImageReview(contentId, dataDir), await wechatTheme(dataDir));
  if (check.ok) return null;
  const r = await transitionStatus(contentId, "draft_ready", { force: true }, dataDir);
  if (!r.ok) throw new Error(`包改了、批准失效，但退回认稿失败：${r.error ?? "没有原因"}`);
  return `批过的图文包改了（${check.reason}），已退回「等你拍板」重新认稿`;
}
