/**
 * 批准即登记（spec §5）：成片批准与封面批准都有效时，服务端跑登记提交；不另要创始人点「登记」。
 *
 * 核（全部先于副作用）：视频平台要有 for_cut = 所批成片 sha 的字幕；所批文件现算 sha 与批准一致；都在项目内、无符号链接。
 *   不过 → 批准照存，doc.commit_failure 写原因，阶段 D3 显示它（E22：不借旧记录）。
 * 做（文件归属事务，按事务 id 提交，摘自 confident-raman commitCore 的思路，去掉按状态 / 无条件 restorePrev 的恢复）：
 *   成片克隆成 07-delivery/registered/final-r<N>-<sha16>（发布器按素材身份取）、选中封面克隆成 05-cover/封面-3x4.* / 封面-4x3.*
 *   （旧的先挪到备份，撤回时放回）→ 在 production.json 写**不可变登记记录**（提交点）。
 *   之后才做、失败只报 warning 不回滚：实拍版口播（register-spoken 的路径）、实拍版核对清单（raman retro-checklist）。
 * 稿件上的 video.final / videoDone / 成片素材由 `projectRegistration` 在投影里按当前登记记录补齐（幂等，崩了也能自愈）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getContent, type Content, type ContentUpdates } from "../../storage/local-store.js";
import { contentRoot, safeProjectPath } from "../../storage/content-project.js";
import { isOntologyActive, newId, readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { Decision, Fact, ProductionDoc, Registration } from "../../storage/production-types.js";
import { writeTextAtomicMkdir } from "../../storage/json-atomic.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { coverPairHash, sha256File } from "../video/handoff/manifest.js";
import { spokenRel } from "../video/handoff/register-spoken.js";
import { spokenFromSrt } from "../video/handoff/spoken.js";
import { readProjectJson, type Citation } from "../video/handoff/project-evidence.js";
import type { VideoFinalRecord } from "../video/handoff/types.js";
import { buildChecklist } from "./checklist.js";
import { matchingRegistration, srtFor, validCoverApproval, validCutApproval } from "./derive.js";
import { identityOf } from "./files.js";
import { checkTargetDir } from "./record-plan.js";
import { isWithin } from "../../storage/storage-roots.js";
import { mutateProduction, refreshContent } from "./service.js";
import { dropBackups, dropTxn, isCommitted, rollbackTxn, saveTxn, type Txn, type TxnOp } from "./txn.js";

export type CommitResult = { ok: true; registration?: Registration; noop?: string; warnings?: string[] } | { ok: false; reason: string };

interface Picked { cut: Decision; cover: Decision; cutFact: Fact; c34: Fact; c43: Fact; srt: Fact }

const accepted = (doc: ProductionDoc, kind: Fact["kind"], sha?: string) =>
  doc.facts.find((f) => f.round === doc.round && f.kind === kind && f.state === "accepted" && f.sha256 === sha && !f.replaced_at);

function pick(doc: ProductionDoc, content: Content): Picked | string | null {
  const cut = validCutApproval(doc, content.body), cover = validCoverApproval(doc, content.body);
  if (!cut || !cover) return null;
  const srt = srtFor(doc, cut.sha256);
  if (!srt) return "缺这版成片的字幕：把成片的字幕报上来（record kind=srt for_cut=成片）";
  const cutFact = accepted(doc, "cut", cut.sha256), c34 = accepted(doc, "cover", cover.cover_3x4_sha), c43 = accepted(doc, "cover", cover.cover_4x3_sha);
  if (!cutFact || !c34 || !c43) return "所批的文件记录不见了";
  return { cut, cover, cutFact, c34, c43, srt };
}

/** 核：在项目内、无符号链接、现算 sha 与批准一致 */
async function verifyFile(root: string, f: Fact, label: string): Promise<string | null> {
  if (!f.path || path.isAbsolute(f.path)) return `${label}不在项目里（${f.path ?? "?"}）：先让创始人确认挪进项目`;
  let abs: string;
  try { abs = safeProjectPath(root, f.path); } catch (e) { return `${label}的路径不安全：${e instanceof Error ? e.message : String(e)}`; }
  const sha = await sha256File(abs).catch(() => null);
  if (!sha) return `${label}不见了：${f.path}`;
  return sha === f.sha256 ? null : `${label}被改过（字节和批准时不一样）：需要重新通过`;
}

async function verifyAll(root: string, p: Picked): Promise<string | null> {
  for (const [f, label] of [[p.cutFact, "成片"], [p.c34, "3:4 封面"], [p.c43, "4:3 封面"], [p.srt, "字幕"]] as const) {
    const why = await verifyFile(root, f, label);
    if (why) return why;
  }
  return null;
}

/** 克隆到目标；目标已在且字节相同 → 不动；已在但不同 → 旧的挪去备份（replace） */
async function cloneTo(txn: Txn, dataDir: string, source: string, target: string, sha: string): Promise<void> {
  const existing = await sha256File(target).catch(() => null);
  if (existing === sha) return;
  const op: TxnOp = { op: existing ? "replace" : "clone", source, target, sha256: sha, step: "planned", ...(existing ? { backup: `${target}.prev-${txn.id}` } : {}) };
  txn.ops.push(op);
  await saveTxn(dataDir, txn);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (op.backup) await fs.rename(target, op.backup);
  const id = await identityOf(source);
  await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
  if ((await sha256File(target)) !== sha || !(await identityOf(source).then((x) => x.ino === id.ino && x.mtime_ms === id.mtime_ms))) throw new Error(`拷贝 ${path.basename(target)} 时源变了`);
  op.step = "placed";
  await saveTxn(dataDir, txn);
}

export function registeredCutName(n: number, sha: string, ext: string): string {
  return `final-r${n}-${sha.slice(0, 16)}${ext}`;
}

/** 登记目标目录：每级不许是符号链接、真实路径不出项目（Codex 审 seg2 P1，与 record 落位同一套检查） */
async function safeDir(root: string, rel: string): Promise<void> {
  const safe = await checkTargetDir(root, rel);
  if (!safe.ok) throw new Error(safe.error);
  await fs.mkdir(path.join(root, rel), { recursive: true });
  if (!isWithin(root, await fs.realpath(path.join(root, rel)))) throw new Error(`登记目标目录出了项目：${rel}`);
}

async function placeAll(root: string, p: Picked, n: number, txn: Txn, dataDir: string): Promise<void> {
  await safeDir(root, "07-delivery/registered");
  await safeDir(root, "05-cover");
  const ext = (f: Fact) => path.extname(f.path!).toLowerCase();
  await cloneTo(txn, dataDir, path.join(root, p.cutFact.path!), path.join(root, "07-delivery/registered", registeredCutName(n, p.cutFact.sha256!, ext(p.cutFact))), p.cutFact.sha256!);
  await cloneTo(txn, dataDir, path.join(root, p.c34.path!), path.join(root, `05-cover/封面-3x4${ext(p.c34)}`), p.c34.sha256!);
  await cloneTo(txn, dataDir, path.join(root, p.c43.path!), path.join(root, `05-cover/封面-4x3${ext(p.c43)}`), p.c43.sha256!);
}

function registrationOf(doc: ProductionDoc, p: Picked, txnId: string): Registration {
  return {
    id: newId("reg"), round: doc.round, at: new Date().toISOString(), source: "commit", body_hash: p.cut.body_hash!,
    cut_approval_id: p.cut.id, cut_sha: p.cut.sha256, cover_approval_id: p.cover.id, cover_3x4_sha: p.cover.cover_3x4_sha,
    cover_4x3_sha: p.cover.cover_4x3_sha, cover_text: p.cover.cover_text, srt_sha: p.srt.sha256, srt_for_cut: p.srt.for_cut, txn_id: txnId,
  };
}

async function recordFailure(contentId: string, dataDir: string, reason: string): Promise<void> {
  await mutateProduction(contentId, dataDir, (d) => {
    if (d.commit_failure?.round === d.round && d.commit_failure.reason === reason) return { value: null, events: [] };
    d.commit_failure = { round: d.round, reason, at: new Date().toISOString() };
    return { value: null, events: [{ type: "registration_failed", detail: { reason } }] };
  });
}

/** 登记之后的附带产物：实拍版口播与核对清单。失败只报 warning（登记已提交） */
async function sideProducts(content: Content, root: string, p: Picked, n: number, dataDir: string): Promise<string[]> {
  try {
    const srt = await fs.readFile(path.join(root, p.srt.path!), "utf8");
    await writeTextAtomicMkdir(path.join(root, spokenRel(n)), spokenFromSrt(srt));
    const citations = (await readProjectJson<{ citations?: Citation[] }>(content.id, "citations.json", dataDir).catch(() => null))?.citations ?? [];
    const items = buildChecklist(srt, citations, content);
    await writeTextAtomicMkdir(path.join(root, spokenRel(n).replace(/-spoken\.md$/, "-checklist.json")), JSON.stringify({ registration: n, items }, null, 2));
    return [];
  } catch (e) {
    return [`登记已完成，但实拍版口播 / 核对清单没存上：${e instanceof Error ? e.message : String(e)}`];
  }
}

/** 调用方持有文件归属事务（决定、record、对账三处触发）。按本体走的视频稿才会登记 */
export async function commitRegistration(contentId: string, dataDir: string): Promise<CommitResult> {
  const content = await getContent(contentId, dataDir);
  if (!content || !isVideoPlatform(content.platform) || !(await isOntologyActive(dataDir, contentId))) return { ok: true, noop: "不按本体走" };
  const doc = await readProductionDocOrEmpty(contentId, dataDir);
  const picked = pick(doc, content);
  if (picked === null) return { ok: true, noop: "两个批准还没齐" };
  if (typeof picked === "string") { await recordFailure(contentId, dataDir, picked); return { ok: false, reason: picked }; }
  const existing = matchingRegistration(doc, content.body, picked.cut, picked.cover);
  if (existing) {
    // 登记记录在、稿件上的投影没跟上（上次派生写入失败）：这里补完
    if (existing.source === "commit" && content.video?.final?.register_hash !== existing.id) {
      await refreshContent(contentId, dataDir);
      return { ok: true, noop: "已经登记过这组批准", warnings: ["补完了上次没写完的成片记录投影"] };
    }
    return { ok: true, noop: "已经登记过这组批准" };
  }
  const root = await fs.realpath(contentRoot(contentId, dataDir));
  const bad = await verifyAll(root, picked);
  if (bad) { await recordFailure(contentId, dataDir, bad); return { ok: false, reason: bad }; }
  const n = doc.registrations.length + 1;
  const txn: Txn = { id: newId("txn"), kind: "register", content_id: contentId, round: doc.round, ops: [], at: new Date().toISOString() };
  try { await placeAll(root, picked, n, txn, dataDir); }
  catch (e) {
    const undone = await rollbackTxn(dataDir, txn).then(() => true, () => false);
    const reason = `登记落文件失败${undone ? "（已撤回）" : "（没能撤回，日志留着，重启时核定）"}：${e instanceof Error ? e.message : String(e)}`;
    await recordFailure(contentId, dataDir, reason);
    return { ok: false, reason };
  }
  return landRegistration(content, root, picked, n, txn, dataDir);
}

async function landRegistration(content: Content, root: string, picked: Picked, n: number, txn: Txn, dataDir: string): Promise<CommitResult> {
  let reg: Registration;
  const warnings: string[] = [];
  try {
    reg = (await mutateProduction(content.id, dataDir, (d) => {
      const r = registrationOf(d, picked, txn.id);
      d.registrations.push(r);
      d.txns = [...(d.txns ?? []), txn.id];
      d.commit_failure = null;
      return { value: r, events: [{ type: "registered", detail: { registration_id: r.id, cut_sha: r.cut_sha, number: n } }] };
    })).value;
  } catch (e) {
    const committed = await isCommitted(dataDir, content.id, txn.id);
    if (committed !== true) {
      if (committed === false) await rollbackTxn(dataDir, txn).catch(() => undefined);
      return { ok: false, reason: `登记记录没写上：${e instanceof Error ? e.message : String(e)}` };
    }
    reg = (await readProductionDocOrEmpty(content.id, dataDir)).registrations.at(-1)!;
    // 提交点已过（登记记录在），只是投影 / 时间线没写完（Codex 审 seg2 P2）：照实报，下一次投影补完
    warnings.push(`登记记录已写进制作记录，但稿件上的成片记录（video.final / videoDone）没写完：${e instanceof Error ? e.message : String(e)}。下一轮对账会补完`);
  }
  await dropBackups(txn);
  await dropTxn(dataDir, txn.id);
  warnings.push(...(await sideProducts(content, root, picked, n, dataDir)));
  return { ok: true, registration: reg, ...(warnings.length ? { warnings } : {}) };
}

/**
 * 投影：D2 命中的登记记录（commit 来源）落到稿件上——成片素材、video.final、videoDone（下游发布包、我的内容读它们）。
 * 幂等：稿件上已经是这条登记就不写。返回要写的补丁或 null。
 */
export async function registrationPatch(content: Content, doc: ProductionDoc, reg: Registration, dataDir: string): Promise<ContentUpdates | null> {
  if (reg.source !== "commit" || content.video?.final?.register_hash === reg.id) return null;
  const n = doc.registrations.findIndex((r) => r.id === reg.id) + 1;
  const cutFact = accepted(doc, "cut", reg.cut_sha), c34 = accepted(doc, "cover", reg.cover_3x4_sha), c43 = accepted(doc, "cover", reg.cover_4x3_sha), srt = accepted(doc, "srt", reg.srt_sha);
  if (!cutFact?.path || !c34?.path || !c43?.path) return null;
  const root = contentRoot(content.id, dataDir);
  const name = registeredCutName(n, reg.cut_sha!, path.extname(cutFact.path).toLowerCase());
  const cut = doc.decisions.find((d) => d.id === reg.cut_approval_id), cover = doc.decisions.find((d) => d.id === reg.cover_approval_id);
  const final: VideoFinalRecord = {
    path: path.join(root, cutFact.path), asset_filename: name, sha256: reg.cut_sha!, duration_ms: cutFact.duration_ms ?? 0,
    covers: { "3:4": path.join(root, c34.path), "4:3": path.join(root, c43.path) },
    cover_copies: { "3:4": `05-cover/封面-3x4${path.extname(c34.path).toLowerCase()}`, "4:3": `05-cover/封面-4x3${path.extname(c43.path).toLowerCase()}` },
    ...(srt?.path ? { srt_path: path.join(root, srt.path) } : {}),
    approvals: {
      final_cut: { artifact_sha256: reg.cut_sha!, approved_at: cut?.at ?? reg.at, user_message: "创始人批准（本体决定）" },
      covers: { artifact_sha256: coverPairHash(reg.cover_3x4_sha!, reg.cover_4x3_sha!), approved_at: cover?.at ?? reg.at, user_message: "创始人选定（本体决定）" },
    },
    registered_by: "founder", at: reg.at, generation: n, manifest_hash: "", register_hash: reg.id, video_ready_at: reg.at,
  };
  const assets = [...(content.assets ?? []).filter((a) => a.filename !== name), { filename: name, type: "video" as const, role: "other" as const, renderedRevision: n, addedAt: reg.at, description: `登记成片 r${n}`, media: { durationMs: cutFact.duration_ms ?? 0 } }];
  const history = content.video?.final ? [...(content.video.history ?? []), content.video.final] : content.video?.history ?? [];
  return { video: { ...content.video, final, history }, videoDone: { renderedRevision: n, at: reg.at }, ...(content.videoReadyAt ? {} : { videoReadyAt: reg.at }), assets };
}
