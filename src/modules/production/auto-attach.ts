/**
 * 收件箱自动挪（1b §4，Q1 A）：发现在锁外做完；这里在文件归属锁里按 §3-4 同一套检查复核后才搬。
 * 事实 source=reconcile、accepted、auto_attached、source_path 记原位置；时间线「从收件箱自动挂上」。
 * 复核不过 → 不搬：文件不见了 / 字节变了就等下一轮；目标不再等原片、被占、被 ChatCut 引用等 → 候选并写原因。
 */
import path from "node:path";
import { getContent } from "../../storage/local-store.js";
import { isOntologyActive, newId, readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { Fact } from "../../storage/production-types.js";
import type { AutoMove } from "./discover.js";
import { checkDuration, stableFingerprint } from "./files.js";
import { chatcutHold, inUseEvidence } from "./chatcut-refs.js";
import { decide, describeTop3, sameSnapshot, snapshotOf, type MatchDecision } from "./match/decide.js";
import { readTranscript } from "./match/cache.js";
import { matchDeps } from "./match/deps.js";
import { arollPool } from "./match/pool.js";
import { placementCheck } from "./match/pending.js";
import type { FilePlan } from "./record-plan.js";
import { commitFile } from "./record.js";
import { now, probe } from "./roots.js";
import { mutateProduction } from "./service.js";

export const AUTO_ATTACHED_BADGE = "从收件箱自动挂上，不对就点「不是」";

async function candidateNow(dataDir: string, m: AutoMove, reason: string): Promise<void> {
  await mutateProduction(m.content_id, dataDir, (doc) => {
    if (doc.facts.some((f) => f.kind === "aroll" && f.sha256 === m.file.sha256)) return { value: null, events: [] };
    const f: Fact = { id: newId("fact"), kind: "aroll", round: doc.round, state: "candidate", availability: "present", source: "reconcile", at: new Date().toISOString(),
      path: m.file.file, sha256: m.file.sha256, size: m.file.size, mtime_ms: m.file.mtime_ms, evidence: `原片收件箱：${reason}` };
    doc.facts.push(f);
    return { value: null, events: [{ type: "fact_imported", detail: { fact_id: f.id, kind: "aroll", state: "candidate", source: "reconcile", evidence: f.evidence } }] };
  });
}

async function currentDecision(dataDir: string, m: AutoMove): Promise<MatchDecision> {
  const pool = await arollPool(dataDir);
  if (sameSnapshot(snapshotOf(m.file.sha256, pool), m.d.snapshot)) return m.d;
  const cached = await readTranscript(dataDir, m.file.sha256);
  const heard = cached ? { text: cached.text } : { text: null, why: "池变了、没有缓存转写" };
  return decide({ fileName: m.file.name, sha256: m.file.sha256, pool, heard }, matchDeps().thresholds);
}

/**
 * 1a 留下的收件箱候选（真实数据预演：上线前放进收件箱的文件被 1a 记成候选，1b 发现时按 sha 去重就再也不判）：
 * 对账建的（不是创始人、不是 agent、不是监视文件夹）、还是候选、本轮、文件还在同一个收件箱路径（发现时已核过 sha）。
 */
function inboxCandidate(f: Fact, doc: { round: number }, m: AutoMove): boolean {
  return f.state === "candidate" && f.source === "reconcile" && f.round === doc.round && f.path === m.file.file;
}

/** 调用方持有文件归属锁。返回要进对账警告的一句（null = 没事） */
export async function autoAttach(dataDir: string, move: AutoMove): Promise<string | null> {
  let m = move;
  const content = await getContent(m.content_id, dataDir);
  if (!content || content.deletedAt || content.status === "archived" || !(await isOntologyActive(dataDir, content.id))) return null;
  const doc = await readProductionDocOrEmpty(content.id, dataDir);
  // 点过「不是这条」的字节不再自动挪到这条（B10）；已记过的也不另起一条——只有 1a 对账留下的收件箱候选可以原地升级（真实数据预演）
  const same = doc.facts.filter((f) => f.kind === "aroll" && f.sha256 === m.file.sha256);
  const legacy = same.length === 1 && inboxCandidate(same[0], doc, m) ? same[0] : undefined;
  if (same.length && !legacy) return null;
  if (doc.facts.some((f) => f.round === doc.round && f.kind === "aroll" && f.state === "accepted")) { await candidateNow(dataDir, m, "这条已经有本轮原片了，后来的只做候选"); return null; }
  // 发现在锁外：池（round / 正文哈希 / 标题）变了就用缓存转写按当前池重判，不用旧 winner（Codex 审 segB P1，同 §3-4）
  const d = await currentDecision(dataDir, m);
  if (d.winner !== m.content_id) return null;
  m = { ...m, d };
  const check = await placementCheck(content, doc, m.file.file, m.file.sha256, undefined, dataDir, ["inbox"]);
  if (!check.ok) {
    if (!check.gone) await candidateNow(dataDir, m, `${check.why}，没挪`);
    return null;
  }
  const fp = await stableFingerprint(check.source, now());
  if (!fp.ok || fp.value.sha256 !== m.file.sha256) return null;
  // 完整性（Codex 审 segB2 P1）：与 record / 卡片挂载同一道门，读不出时长的不挪、不冻结
  const dur = await checkDuration(check.source, probe);
  if (!dur.ok) return `收件箱里的 ${path.basename(m.file.file)} 没自动挂上：${dur.error}`;
  const hold = await chatcutHold(check.source);
  const plan: FilePlan = { action: hold.project ? "in_place" : "move", kind: "aroll", source: check.source, sha256: m.file.sha256, id: fp.value.id, projectRoot: check.projectRoot, location: "inbox",
    ...(legacy ? { existing: legacy } : {}), duration_ms: dur.value,
    evidence: `从收件箱自动挂上：${m.d.reason}${m.d.top3.length > 1 ? `；前三名：${describeTop3(m.d.top3)}` : ""}${hold.project ? `；${inUseEvidence(hold.project)}` : hold.note}` };
  const a = { content_id: content.id, kind: "aroll" as const, request_id: `auto-${m.file.sha256.slice(0, 24)}-${doc.round}`, host: "autocrew" };
  const match = { winner: m.d.winner, reason: m.d.reason, top3: m.d.top3.map((r) => ({ ...r })) };
  const r = await commitFile(a, content, plan, dataDir, undefined, { patch: { source: "reconcile", auto_attached: true, match, by: { host: "autocrew" } }, event: "aroll_auto_attached" });
  return r.ok ? null : `《${content.title}》从收件箱自动挂原片没成（${path.basename(m.file.file)}）：${String(r.error)}`;
}
