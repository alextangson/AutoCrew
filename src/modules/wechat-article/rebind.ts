/**
 * 公众号文章的 rebind（spec §9.1）：源视频成片换版后，正文、标题、配图、封面、创作来源都原样留着当草稿，
 * 只把绑定换到新成片、撤掉整包批准、退回「等你拍板」——他看着旧 / 新成片的逐句对比决定正文要不要改，再重新批。
 * 已经定时 / 等扫码 / 发出去的不 rebind（那一篇已经按旧成片发了，先在后台取消再说）。
 */
import { getContent } from "../../storage/local-store.js";
import { backToReview, commitRebind, noopResult, planRebind } from "../lineage/rebind.js";
import { diffBriefLines } from "../lineage/rebind-diff.js";
import { readArticlePackage, withArticleLock, writeArticlePackage } from "./package.js";
import { COMMITTED, readPublishState } from "./publish-state.js";

type Result = Record<string, unknown>;

export function rebindArticle(id: string, dataDir: string): Promise<Result> {
  return withArticleLock(id, async () => {
    const st = await readPublishState(id, dataDir);
    if (st.phase && COMMITTED.has(st.phase)) return { ok: false, code: "already_scheduled", error: `这篇已经按旧成片定时 / 发出去了（${st.phase}）：先请创始人在公众号后台取消，record_absent 之后再 rebind` };
    const plan = await planRebind((await getContent(id, dataDir))!, dataDir);
    if ("ok" in plan) return plan;
    if (plan.noop) return noopResult(plan.cut);
    await commitRebind(id, plan, dataDir);
    const { approval: _old, ...pkg } = await readArticlePackage(id, dataDir);
    void _old;
    await writeArticlePackage(id, pkg, dataDir);
    const moved = await backToReview(id, dataDir);
    return {
      ok: true, rebound: true, diff: plan.diff.summary, diff_lines: diffBriefLines(plan.diff),
      kept: "正文、标题候选与选定标题、配图、封面、创作来源都留着；整包批准已撤，要重新批",
      ...(moved ? { status_warning: moved } : {}),
      next_action: "把 diff_lines 给创始人看：哪几句变了要不要改正文（改正文走 autocrew_content update）；然后 autocrew_review_inbox list 把认稿那件给他重批",
    };
  });
}
