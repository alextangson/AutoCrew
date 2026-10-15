/**
 * autocrew_draft opening：先磨开头再写全文（spec 2026-10-15 §7、§10、§15.13）。断点可续：
 * - opening{candidates, founder_words?}：记一轮 3 个候选开头。带 founder_words = 他对上一轮的原话（都不满意时说的），记成开头阶段的修改意见。
 * - opening{opening, founder_words}：记他选中（或改了一句）的开头全文和原话。这是选择不是意见，只记在 opening_pick 上。选了才能存第一版全文。
 * 连着两轮都不满意：回执提示回到立意重选。只管新流程的立意（锁了写法版本的）；旧稿不走这一步。
 */
import { isRealDraft } from "../storage/first-body-guard.js";
import { currentVersion, workbenchUrl, type DraftAngle, type OpeningPick } from "../modules/draft/draft-types.js";
import type { DraftFeedbackRecord } from "../modules/draft/draft-feedback.js";
import { fail, withVersion } from "./draft-version.js";
import type { DraftArgs } from "./draft-args.js";

type R = Record<string, unknown>;

function openingFeedback(c: { draftPath?: { feedback?: DraftFeedbackRecord[] } }, angle: DraftAngle, words: string, version: number): DraftFeedbackRecord[] {
  const rec: DraftFeedbackRecord = { version, founder_words: words, at: new Date().toISOString(), stage: "opening", body_changed: false, lessons: [], ...(angle.playbook ? { playbook: angle.playbook } : {}) };
  return [...(c.draftPath?.feedback ?? []), rec];
}

function refusal(a: DraftArgs, angle: DraftAngle | undefined): R | null {
  if (typeof a.candidates === "string") return fail("bad_param", a.candidates);
  if (!angle) return fail("needs_angle", "还没记立意：先出立意卡让创始人选，用 angle 记下");
  if (!angle.method) return fail("old_angle", "这篇的立意是范文库上线前出的，不走开头三选一：照旧写全文");
  if (!a.candidates && !a.opening) return fail("bad_param", "opening 要带 candidates（这一轮 3 个开头）或 opening（他选中的开头全文）+ founder_words");
  if (a.candidates && a.opening) return fail("bad_param", "一次只做一件：记候选（candidates）或记他选的（opening），不要同时传");
  if (a.opening && !a.founderWords) return fail("bad_param", "记他选的开头要带 founder_words：他选时的原话，逐字");
  return null;
}

/** 连着两轮都没选中：第三轮不出，回到立意 */
const exhausted = (prev: OpeningPick | undefined) => Boolean(prev && !prev.chosen && prev.round >= 2);

export async function draftOpening(a: DraftArgs): Promise<R> {
  return withVersion(a, async (c, tx) => {
    const angle = c.draftPath?.angle;
    const bad = refusal(a, angle);
    if (bad) return bad;
    if (await isRealDraft(c, a.dataDir)) return fail("has_body", "已经有正文了：开头三选一只在写第一版之前做；现在按意见改正文");
    const prev = angle!.opening_pick;
    const version = currentVersion(c);
    let feedback = c.draftPath?.feedback;
    // 只有「都不满意、重出」时他说的话是修改意见；选中时的话是选择，只记在 opening_pick 上（§15.18）
    if (a.founderWords && a.candidates) feedback = openingFeedback(c, angle!, a.founderWords, version);
    if (a.candidates) {
      if (exhausted(prev)) {
        // 记下「回立意」的状态：断线重连时 progress / next_action 指向重选立意，不再「等你选开头」
        await tx.write({ draftPath: { ...c.draftPath!, angle: { ...angle!, opening_pick: { ...prev!, exhausted: true, at: new Date().toISOString() } }, ...(feedback ? { feedback } : {}) } });
        return fail("back_to_angle", "连着两轮开头他都不满意：不出第三轮，回到第 3 步重出立意（angle），他这次的原话已记下", { round: prev!.round });
      }
      const pick: OpeningPick = { round: (prev?.round ?? 0) + 1, candidates: a.candidates as string[], at: new Date().toISOString() };
      const note = "把这几个开头编号给创始人挑，他选了（或改了一句）用 opening{opening, founder_words} 记下；都不满意就问清哪里不行，再出一轮";
      await tx.write({ draftPath: { ...c.draftPath!, angle: { ...angle!, opening_pick: pick }, ...(feedback ? { feedback } : {}) } });
      return { ok: true, version, round: pick.round, waiting: "等创始人选开头", workbench_url: workbenchUrl(c.id), next_action: { note } };
    }
    if (prev?.exhausted) return fail("back_to_angle", "连着两轮开头都没选中：先回到立意重选（angle），再磨开头");
    if (!prev?.candidates.length) return fail("no_candidates", "还没记这一轮的候选开头：先 opening{candidates}，给他挑了再记选中的");
    const pick: OpeningPick = { ...prev, chosen: a.opening!, founder_words: a.founderWords, at: new Date().toISOString() };
    await tx.write({ draftPath: { ...c.draftPath!, angle: { ...angle!, opening: a.opening!, opening_pick: pick } } });
    return { ok: true, version, round: pick.round, chosen: pick.chosen, workbench_url: workbenchUrl(c.id), next_action: { note: "按选中的开头、立意、手册和锁住的范文写全文，再 save" } };
  });
}
