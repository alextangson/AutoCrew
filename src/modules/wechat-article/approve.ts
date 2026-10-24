/**
 * 认稿 = 批整包（Phase 2a）：批之前核源视频没过期、包里没缺项；批的那一刻记下整包指纹。
 * 之后正文、标题、任何一张图、封面、创作来源变了，批准就失效（status / 审阅页写明是哪一包变了）；2b 的发布会按批准的那一包核。
 */
import { articleReviewState } from "./review.js";
import { approvePackage, readArticlePackage, writeArticlePackage } from "./package.js";

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
  await writeArticlePackage(contentId, approvePackage(pkg, hash), dataDir);
}
