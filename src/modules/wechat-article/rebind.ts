/**
 * 公众号文章的 rebind（spec §9.1）：源视频成片换版后，正文、标题、配图、封面、创作来源都原样留着当草稿，
 * 只把绑定换到新成片、撤掉整包批准、退回「等你拍板」——他看着旧 / 新成片的逐句对比决定正文要不要改，再重新批。
 * 已经定时 / 等扫码 / 发出去的不 rebind（那一篇已经按旧成片发了，先在后台取消再说）。
 *
 * 落盘顺序（Codex 审 P1）：① 撤批准 + 记 rebindPending → ② 换绑定 → ③ 退回待认稿、清 rebindPending。
 * 中途断了：批准已经没了；再调 rebind 看到 rebindPending 就把剩下的做完，不回「不用 rebind」。
 * 另外包指纹在 rebind 过之后带上源成片身份，绑定一换旧批准必然失效（双保险）。
 */
import { getContent } from "../../storage/local-store.js";
import { backToReview, commitRebind, noopResult, planRebind } from "../lineage/rebind.js";
import { diffBriefLines, readRebindDiff } from "../lineage/rebind-diff.js";
import { readArticlePackage, withArticleLock, writeArticlePackage, type ArticlePackage } from "./package.js";
import { COMMITTED, readPublishState } from "./publish-state.js";

type Result = Record<string, unknown>;

const withoutApproval = ({ approval: _a, ...rest }: ArticlePackage): ArticlePackage => { void _a; return rest; };

export function rebindArticle(id: string, dataDir: string): Promise<Result> {
  return withArticleLock(id, async () => {
    const st = await readPublishState(id, dataDir);
    if (st.phase && COMMITTED.has(st.phase)) return { ok: false, code: "already_scheduled", error: `这篇已经按旧成片定时 / 发出去了（${st.phase}）：先请创始人在公众号后台取消，record_absent 之后再 rebind` };
    const plan = await planRebind((await getContent(id, dataDir))!, dataDir);
    if ("ok" in plan) return plan;
    const pkg = await readArticlePackage(id, dataDir);
    if (plan.noop) return pkg.rebindPending ? finish(id, dataDir, true) : noopResult(plan.cut);
    await writeArticlePackage(id, { ...withoutApproval(pkg), rebindPending: { toCut: plan.to, at: new Date().toISOString() } }, dataDir);
    await commitRebind(id, plan, dataDir);
    return finish(id, dataDir, false);
  });
}

async function finish(id: string, dataDir: string, resumed: boolean): Promise<Result> {
  const moved = await backToReview(id, dataDir);
  const { rebindPending: _p, ...pkg } = withoutApproval(await readArticlePackage(id, dataDir));
  void _p;
  await writeArticlePackage(id, pkg, dataDir);
  const diff = await readRebindDiff(id, dataDir);
  return {
    ok: true, rebound: true, ...(resumed ? { resumed: true } : {}), ...(diff ? { diff: diff.summary, diff_lines: diffBriefLines(diff) } : {}),
    kept: "正文、标题候选与选定标题、配图、封面、创作来源都留着；整包批准已撤，要重新批",
    ...(moved ? { status_warning: moved } : {}),
    next_action: "把 diff_lines 给创始人看：哪几句变了要不要改正文（改正文走 autocrew_content update）；然后 autocrew_review_inbox list 把认稿那件给他重批",
  };
}
