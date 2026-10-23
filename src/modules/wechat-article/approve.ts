/**
 * 认稿 = 批整包（Phase 2a）：批之前核源视频没过期、包里没缺项；批的那一刻记下整包指纹。
 * 之后正文、标题、任何一张图、封面、创作来源变了，发布前的核对（publish-guard）都会拒并说是哪一包变了。
 */
import { articleReviewState } from "./review.js";
import { approvePackage, readArticlePackage, writeArticlePackage } from "./package.js";

export type GateResult = { ok: true; hash: string } | { ok: false; code: string; error: string };

export async function articleApproveGate(contentId: string, dataDir: string): Promise<GateResult> {
  const s = await articleReviewState(contentId, dataDir, { fresh: true });
  if ("error" in s) return { ok: false, code: s.code, error: s.error };
  if (s.stale) return { ok: false, code: "derived_stale", error: `这条派生稿过期了，不能批：${s.stale}` };
  if (s.problems.length) return { ok: false, code: "article_not_ready", error: `图文还不能批：\n${s.problems.map((p, i) => `${i + 1}) ${p}`).join("\n")}` };
  return { ok: true, hash: s.hash };
}

export async function recordArticleApproval(contentId: string, hash: string, dataDir: string): Promise<void> {
  const pkg = await readArticlePackage(contentId, dataDir);
  await writeArticlePackage(contentId, approvePackage(pkg, hash), dataDir);
}
