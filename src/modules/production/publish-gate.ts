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
import { sha256File } from "../video/handoff/manifest.js";
import { matchingRegistration, srtFor, validCoverApproval, validCutApproval } from "./derive.js";

export interface PublishPackageFiles { registration: Registration; video: string; cover34: string; cover43: string; srt: string | null }
export type GateResult = { ok: true; files: PublishPackageFiles } | { ok: false; code: string; error: string };

const accepted = (doc: ProductionDoc, kind: Fact["kind"], sha?: string) =>
  doc.facts.find((f) => f.round === doc.round && f.kind === kind && f.state === "accepted" && f.sha256 === sha && !f.replaced_at);

async function fileOf(root: string, f: Fact | undefined, label: string): Promise<string | { error: string }> {
  if (!f?.path) return { error: `登记绑的${label}记录不见了` };
  let abs: string;
  try { abs = path.isAbsolute(f.path) ? f.path : safeProjectPath(root, f.path); } catch (e) { return { error: `${label}路径不安全：${e instanceof Error ? e.message : String(e)}` }; }
  const sha = await sha256File(abs).catch(() => null);
  if (!sha) return { error: `登记的${label}文件不见了（${f.path}）` };
  return sha === f.sha256 ? abs : { error: `登记的${label}字节变了（${f.path}），和批准的不是同一份：重新通过后再发` };
}

/** 按本体走的视频稿 → 当前登记的发布文件或阻止原因；不按本体走 → null */
export async function registeredPackage(content: Content, dataDir: string): Promise<GateResult | null> {
  if (!isVideoPlatform(content.platform) || !(await isOntologyActive(dataDir, content.id))) return null;
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
  const video = await fileOf(root, accepted(doc, "cut", reg.cut_sha), "成片");
  const c34 = await fileOf(root, accepted(doc, "cover", reg.cover_3x4_sha), "3:4 封面");
  const c43 = await fileOf(root, accepted(doc, "cover", reg.cover_4x3_sha), "4:3 封面");
  for (const x of [video, c34, c43]) if (typeof x !== "string") return { ok: false, code: "registered_file_changed", error: x.error };
  // 登记绑的字幕同样不可少（Codex 审 seg2 P2）：缺了或字节变了照样拦
  const srt = reg.srt_sha ? await fileOf(root, accepted(doc, "srt", reg.srt_sha), "字幕") : null;
  if (srt && typeof srt !== "string") return { ok: false, code: "registered_file_changed", error: srt.error };
  return { ok: true, files: { registration: reg, video: video as string, cover34: c34 as string, cover43: c43 as string, srt } };
}
