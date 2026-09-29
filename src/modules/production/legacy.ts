/**
 * 旧登记的迁移（§4.1；Codex 审 P1 derive.ts:94）：已登记的待发布卡启用后不该倒退，但 legacy 登记不能绕过 D2。
 *
 * 只有旧 register 当时核过的东西都还在、字节都还对得上，才导入成本轮的一组完整组合：
 *   approvals.json 里创始人的 gate3（成片）/ gate4（封面对）批准 = video.final 的成片 sha 与封面对指纹，
 *   cover-selection.json 选中的两张封面、decisions.json 的封面字、video.final 的字幕。
 * 成为 legacy 事实（cut / 两张 cover / srt）+ legacy 成片批准 + legacy 封面批准 + 与之完全一致的 legacy 登记记录。
 * 缺任何一样 → 不导入（卡片显示需要重新通过的那几项）。本轮任何新批准都会顶掉它（derive 取最近一条批准）。
 */
import path from "node:path";
import type { Content } from "../../storage/local-store.js";
import { contentRoot, projectRelativeFile } from "../../storage/content-project.js";
import { bodyHash } from "../../storage/production-store.js";
import { draftHash } from "../../storage/draft-hash.js";
import type { Decision, Fact, Registration } from "../../storage/production-types.js";
import { coverPairHash, sha256File } from "../video/handoff/manifest.js";
import { normalizeApprovals, type CoverSelection } from "../video/handoff/gate-state.js";
import { readProjectJson, type ProjectDecisions } from "../video/handoff/project-evidence.js";

export interface LegacyImport { facts: Fact[]; decisions: Decision[]; registrations: Registration[]; reason?: string }

const none = (reason: string): LegacyImport => ({ facts: [], decisions: [], registrations: [], reason });

async function hashAt(root: string, p: string | undefined): Promise<{ rel: string; sha: string } | null> {
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  const sha = await sha256File(abs).catch(() => null);
  return sha ? { rel: path.isAbsolute(p) && path.relative(root, abs).startsWith("..") ? abs : path.relative(root, abs), sha } : null;
}

function legacyFact(kind: Fact["kind"], round: number, at: string, file: { rel: string; sha: string }, extra: Partial<Fact>): Fact {
  return { id: `legacy-${kind}-${extra.ratio?.replace(":", "x") ?? ""}${round}`, kind, round, state: "accepted", availability: "present", source: "legacy", at, path: file.rel, sha256: file.sha, evidence: "旧登记（video.final）迁移", ...extra };
}

/** 从旧登记读出完整组合；任何一环缺失或字节对不上就返回空并说原因 */
export async function importLegacyRegistration(content: Content, round: number, dataDir: string, at: string): Promise<LegacyImport> {
  const f = content.video?.final;
  if (!f || (content.status !== "publish_ready" && content.status !== "publishing")) return none("不是已登记的待发布稿");
  const root = contentRoot(content.id, dataDir);
  const approvals = normalizeApprovals(await readProjectJson<unknown>(content.id, "approvals.json", dataDir).catch(() => null));
  const selection = await readProjectJson<CoverSelection>(content.id, "cover-selection.json", dataDir).catch(() => null);
  const decisions = await readProjectJson<ProjectDecisions>(content.id, "decisions.json", dataDir).catch(() => null);
  const cut = await hashAt(root, projectRelativeFile(`assets/${f.asset_filename}`));
  const c34 = await hashAt(root, selection?.["3:4"]?.path), c43 = await hashAt(root, selection?.["4:3"]?.path);
  const srt = await hashAt(root, f.srt_path);
  if (!cut || cut.sha !== f.sha256) return none("登记的成片文件不在或字节变了");
  if (approvals?.final_cut?.artifact_sha256 !== f.sha256) return none("approvals.json 里没有对得上这版成片的创始人批准");
  if (!c34 || !c43 || c34.sha !== selection?.["3:4"]?.sha256 || c43.sha !== selection?.["4:3"]?.sha256) return none("选中的封面文件不在或字节变了");
  if (approvals?.covers?.artifact_sha256 !== coverPairHash(c34.sha, c43.sha)) return none("approvals.json 里没有对得上这对封面的创始人批准");
  if (!srt) return none("登记时的字幕不在了");
  // 旧批准要仍然有效（Codex 审 seg2 P1）：绑定的是这次登记的交接代次、没被撤回、批准时的稿就是现在的稿。
  // 字节相同不等于创始人批准了现在的正文——任何一样不对就不迁移，卡片显示需要重新通过
  for (const gate of ["final_cut", "covers"] as const) {
    const bound = approvals?.bindings?.[gate];
    if (!bound || bound.generation !== f.generation || bound.manifest_hash !== f.manifest_hash) return none(`旧的${gate === "final_cut" ? "成片" : "封面"}批准没有绑到这次登记的交接代次`);
    if (content.video?.revoked?.includes(bound.manifest_hash)) return none("那一代交接已被撤回");
    if (bound.draft_hash !== draftHash(content)) return none("批准之后稿件改过，旧批准不算现在这一版");
  }
  const text = decisions?.cover_text?.trim();
  if (!text) return none("没有封面字");
  const bh = bodyHash(content.body);
  const cutD: Decision = { id: `legacy-cut-approval-${round}`, type: "cut_approval", round, at, source: "legacy", sha256: f.sha256, body_hash: bh };
  const covD: Decision = { id: `legacy-cover-approval-${round}`, type: "cover_approval", round, at, source: "legacy", cover_3x4_sha: c34.sha, cover_4x3_sha: c43.sha, cover_text: text, body_hash: bh };
  return {
    facts: [
      legacyFact("cut", round, at, cut, {}), legacyFact("cover", round, at, c34, { ratio: "3:4" }), legacyFact("cover", round, at, c43, { ratio: "4:3" }),
      legacyFact("srt", round, at, srt, { for_cut: f.sha256 }),
    ],
    decisions: [cutD, covD],
    registrations: [{ id: `legacy-reg-${round}`, round, at, source: "legacy", body_hash: bh, cut_approval_id: cutD.id, cut_sha: f.sha256, cover_approval_id: covD.id,
      cover_3x4_sha: c34.sha, cover_4x3_sha: c43.sha, cover_text: text, srt_sha: srt.sha, srt_for_cut: f.sha256 }],
  };
}
