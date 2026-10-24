/**
 * 源成片换版 → rebind（spec §9.1，创始人 2026-10-24）：派生稿不重做，绑到新成片。
 * 通用这一段只管：核源视频现在有审过的成片、和派生时那版不同；算旧 / 新成片字幕的逐句对比并落盘；
 * 改 derivedFrom（新的成片身份 + 从哪版换过来）。草稿怎么保留、哪些批准失效由各条线自己做（wechat-article / en-edition 的 rebind）。
 */
import { getContent, transitionStatus, updateContentWith, type Content } from "../../storage/local-store.js";
import { normalizeLegacyStatus } from "../../storage/local-store.js";
import { missingAsNull } from "../publish/review-gate/plan.js";
import { approvedCutIdentity } from "./cut-identity.js";
import { shortHash } from "./artifact-approval.js";
import { buildRebindDiff, writeRebindDiff, type RebindDiff } from "./rebind-diff.js";

export type RebindPlan = { noop: true; cut: string } | { noop: false; source: Content; from: string; to: string; diff: RebindDiff };
export type RebindFail = { ok: false; code: string; error: string };

export async function planRebind(c: Content, dataDir: string): Promise<RebindPlan | RebindFail> {
  const from = c.derivedFrom;
  if (!from) return { ok: false, code: "not_derived", error: "这条不是派生稿，没有可以 rebind 的源成片" };
  const source = await getContent(from.contentId, dataDir).catch(missingAsNull);
  if (!source || source.deletedAt) return { ok: false, code: "source_missing", error: `源视频（${from.contentId}）不在了：没有新成片可绑` };
  const cut = await approvedCutIdentity(source, dataDir, { fresh: true });
  if (cut.id === null) return { ok: false, code: "no_approved_cut", error: `${cut.reason}：等新成片在「等你拍板」里审过，再 rebind` };
  if (cut.id === from.sourceCutHash) return { noop: true, cut: cut.id };
  const diff = await buildRebindDiff(source, from.sourceCutHash, cut.id, dataDir);
  if ("error" in diff) return { ok: false, code: "no_source_srt", error: diff.error };
  return { noop: false, source, from: from.sourceCutHash, to: cut.id, diff };
}

/** 落对比、改绑定（新成片身份 + 从哪版换来）；at 也换成现在：之后的过期判断按新成片算 */
export async function commitRebind(id: string, plan: Extract<RebindPlan, { noop: false }>, dataDir: string): Promise<void> {
  await writeRebindDiff(id, plan.diff, dataDir);
  const at = new Date().toISOString();
  const updated = await updateContentWith(id, (c) => ({ derivedFrom: { ...c.derivedFrom!, sourceCutHash: plan.to, at, rebound: { fromCutHash: plan.from, at } } }), dataDir);
  if (!updated) throw new Error(`派生稿 ${id} 读不到了，没绑上新成片`);
}

/** 退回「等你拍板」的认稿（批准已失效，要他按对比重看）；已经在待认稿就不动 */
export async function backToReview(id: string, dataDir: string): Promise<string | null> {
  const c = await getContent(id, dataDir);
  const status = normalizeLegacyStatus(c!.status);
  if (status === "draft_ready") return null;
  const r = await transitionStatus(id, "draft_ready", { force: true, expectedStatus: status }, dataDir);
  return r.ok ? null : `已经绑到新成片，但没放回待认稿（${r.error ?? "没有原因"}）：创始人暂时在「等你拍板」里看不到它`;
}

export const noopResult = (cut: string) => ({ ok: true, rebound: false, note: `源视频审过的成片还是派生时那一版（${shortHash(cut)}），不用 rebind` });
