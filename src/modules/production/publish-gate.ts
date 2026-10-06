/**
 * 发布出口（spec §5，Codex P1-3）：所有发布路径（ego-lite 发布包、video_kit、pre_publish、我的内容「待发布」文件夹）
 * 只取**当前有效登记记录**里的成片与封面，发前再核批准有效与实际字节。
 *
 * - 新版已批准但登记没提交（D3）→ 阻止，不静默用旧包（E37）；
 * - 撤批后旧包立即不可发（derive 不回退到旧批准）；
 * - 所绑文件缺失 / 字节变了 → 阻止并说原因。
 * 不按本体走的稿返回 null，调用方走旧路径（旧路径也已去掉「最新视频素材」回退）。
 */
import path from "node:path";
import type { Content } from "../../storage/local-store.js";
import { contentRoot, safeProjectPath } from "../../storage/content-project.js";
import { isOntologyActive, readProductionDocOrEmpty, scriptApprovalFor } from "../../storage/production-store.js";
import type { Fact, ProductionDoc, Registration } from "../../storage/production-types.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { cachedSha, commitSha, loadHashCache } from "./hash-cache.js";
import { matchingRegistration, registeredSrt, srtFor, validCoverApproval, validCutApproval } from "./derive.js";

export interface PublishPackageFiles { registration: Registration; video: string; cover34: string; cover43: string; srt: string | null }
export type GateResult = { ok: true; files: PublishPackageFiles } | { ok: false; code: string; error: string };

const accepted = (doc: ProductionDoc, kind: Fact["kind"], sha?: string) =>
  doc.facts.find((f) => f.round === doc.round && f.kind === kind && f.state === "accepted" && f.sha256 === sha && !f.replaced_at);

/** 发布前（fresh）现算全文件、还在写的拒绝；看状态 / 排「我的内容」只按元数据缓存认 */
async function shaFor(abs: string, fresh: boolean): Promise<string | { error: string } | null> {
  if (!fresh) return (await cachedSha(abs).catch(() => null))?.sha256 ?? null;
  const r = await commitSha(abs).catch(() => null);
  return !r ? null : r.ok ? r.sha256 : { error: r.reason };
}

async function fileOf(root: string, f: Fact | undefined, label: string, fresh: boolean): Promise<string | { error: string }> {
  if (!f?.path) return { error: `登记绑的${label}记录不见了` };
  let abs: string;
  try { abs = path.isAbsolute(f.path) ? f.path : safeProjectPath(root, f.path); } catch (e) { return { error: `${label}路径不安全：${e instanceof Error ? e.message : String(e)}` }; }
  const sha = await shaFor(abs, fresh);
  if (sha && typeof sha !== "string") return { error: `登记的${label}：${sha.error}` };
  if (!sha) return { error: `登记的${label}文件不见了（${f.path}）` };
  return sha === f.sha256 ? abs : { error: `登记的${label}字节变了（${f.path}），和批准的不是同一份：重新通过后再发` };
}

/** 按本体走的视频稿 → 当前登记的发布文件或阻止原因；不按本体走 → null */
/** 这条稿按本体走：资料库启用、没被排除、且是视频稿（卡片 active、登记出口、explain 用的同一组条件） */
export async function ontologyApplies(content: Pick<Content, "id" | "platform">, dataDir: string): Promise<boolean> {
  return isVideoPlatform(content.platform) && (await isOntologyActive(dataDir, content.id));
}

/** `fresh: true` 只给真要发出去的那一步（发布包、pre_publish、发布审查执行）；看状态的读路径走缓存 */
export async function registeredPackage(content: Content, dataDir: string, opts: { fresh?: boolean } = {}): Promise<GateResult | null> {
  if (!(await ontologyApplies(content, dataDir))) return null;
  await loadHashCache(dataDir);
  const fresh = opts.fresh === true;
  const doc = await readProductionDocOrEmpty(content.id, dataDir);
  if (!scriptApprovalFor(doc, content.body)) return { ok: false, code: "not_approved", error: "这条的认稿已失效（正文改过或重开了），先认稿、剪辑、批准再发" };
  const cut = validCutApproval(doc, content.body), cover = validCoverApproval(doc, content.body);
  const reg = matchingRegistration(doc, content.body, cut, cover);
  if (!reg) {
    const newer = cut && cover;
    return { ok: false, code: newer ? "registration_pending" : "no_registration",
      error: newer ? `新版已批准，但登记还没完成：${doc.commit_failure?.round === doc.round ? doc.commit_failure.reason : srtFor(doc, cut!.sha256) ? "等登记提交" : "缺这版成片的字幕"}；不会用旧包发布` : "没有当前有效的登记：成片或封面批准变了、被撤了，或还没批——重新通过后自动登记" };
  }
  const root = contentRoot(content.id, dataDir);
  const video = await fileOf(root, accepted(doc, "cut", reg.cut_sha), "成片", fresh);
  const c34 = await fileOf(root, accepted(doc, "cover", reg.cover_3x4_sha), "3:4 封面", fresh);
  const c43 = await fileOf(root, accepted(doc, "cover", reg.cover_4x3_sha), "4:3 封面", fresh);
  for (const x of [video, c34, c43]) if (typeof x !== "string") return { ok: false, code: "registered_file_changed", error: x.error };
  // 登记绑的字幕同样不可少（Codex 审 seg2 P2）：缺了或字节变了照样拦
  const srt = reg.srt_sha ? await fileOf(root, registeredSrt(doc, reg), "字幕", fresh) : null;
  if (srt && typeof srt !== "string") return { ok: false, code: "registered_file_changed", error: srt.error };
  return { ok: true, files: { registration: reg, video: video as string, cover34: c34 as string, cover43: c43 as string, srt } };
}
