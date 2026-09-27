import { hostEvidencePath } from "../modules/research/host-evidence-store.js";
/**
 * 稿件证据台账的写入口（P6 §3.8 写门 + §11 待修第一条）。
 *
 * 两条路进同一本账、过同一套检查：
 * - 研究任务补证：scout cite / claim_offline 带 task_id 与 citation_target，条目号 `ev-H…`（原路径不变）；
 * - 写手侧登记：provided/skip 模式根本没有研究任务，由用户材料推算出来的数（「一场省三十分钟」）
 *   只能靠 claim_offline 带 content_id + pack_id 登记成 `user-<n>` 的 user_claim，必须写明推算依据。
 *   以前这一步要 task_id，宿主撞上 task_required 就去翻源码（P6-e 行为 eval 那条 12 分钟超时）。
 *
 * 写门（claim_token）、包号 fencing、每稿 12 条终身额度两条路完全一样：写手侧登记不是后门。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getContent, updateContent } from "../storage/local-store.js";
import { gateClaimWrite, type ClaimDenial } from "../storage/claims.js";
import { writeJsonAtomic, writeTextAtomic } from "../storage/json-atomic.js";
import { HostResearchError } from "../modules/research/host-research-store.js";
import { DEFAULT_MAX_LOOKUPS, restoreEvidenceLedger, type EvidenceLedgerSnapshot, type LedgerEntry } from "../modules/research/evidence-ledger.js";
import { isReadyPack, readPack, writePack, serializeWriterCall, renderPack, packPath, PACK_MD, type ReadyPack } from "./writer-pack.js";

/** 每稿宿主补证的终身上限：重领包、换研究任务都不重置 */
export const HOST_EVIDENCE_LIMIT = 12;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const nonempty = (v: unknown, name: string) => {
  const s = str(v);
  if (!s.trim()) throw new HostResearchError("missing_argument", `${name} 必填`);
  return s;
};

/** 补证入稿被写门拒绝：走研究台的错误通道，但把持有者原样带回去 */
class ClaimHeldError extends HostResearchError {
  constructor(denial: ClaimDenial) {
    super(denial.code ?? "claim_held", denial.error, denial.holder ? { holder: denial.holder } : undefined);
  }
}

export interface EvidenceTarget {
  contentId: string;
  /** 空串 = 导入稿（§13.4-B）：没有写作包，直接记进稿件自己的证据台账 */
  packId: string;
  topicId: string;
  /** 包必须属于这个宿主；研究任务路径传任务宿主，写手侧传调用方 */
  host: string;
  claimToken: string;
  dir: string;
}

/** 写门：往稿件证据账本里写 = 写这篇稿，和写稿同一道令牌门 */
async function gateEvidenceWrite(t: EvidenceTarget): Promise<{ claim_token?: string }> {
  const token = t.claimToken.trim();
  const gate = await gateClaimWrite(t.contentId, { host: t.host, employee: "writer", token: token || undefined }, t.dir);
  if ("denied" in gate) throw new ClaimHeldError(gate.denied);
  return gate.grant;
}

/** 导入稿补证入口（§13.4-B）：用户已有成稿导入、停在 draft_ready，没有写作包也能补证 */
export async function isImportDraft(contentId: string, dir: string): Promise<boolean> {
  const content = await getContent(contentId, dir);
  return content?.writingSource?.kind === "manual_import" && content.status === "draft_ready";
}

interface WritableTarget {
  ledger: EvidenceLedgerSnapshot;
  /** 导入稿没有写作包 */
  pack?: ReadyPack;
}

const EMPTY_LEDGER: EvidenceLedgerSnapshot = { entries: [], lookups: [], budget: { max: DEFAULT_MAX_LOOKUPS, used: 0 } };

/**
 * 稿件与包号都对得上、没在审，才允许改这篇稿的账本。
 * 导入稿（不带包号）按 content_id 认：只看来源与 draft_ready；没挂选题的导入稿不核选题。
 */
async function loadWritableTarget(t: EvidenceTarget): Promise<WritableTarget> {
  const content = await getContent(t.contentId, t.dir);
  if (!t.packId) {
    if (!content || content.writingSource?.kind !== "manual_import" || content.status !== "draft_ready")
      throw new HostResearchError("missing_pack", "补证入稿需要同时提供content_id和pack_id（只有 draft_ready 的导入稿可以不带包号）");
    if (content.topicId && content.topicId !== t.topicId) throw new HostResearchError("wrong_content", "补证目标不属于本次选题");
    return { ledger: content.evidenceLedger ?? EMPTY_LEDGER };
  }
  if (!content || content.topicId !== t.topicId) throw new HostResearchError("wrong_content", "补证目标不属于本次选题");
  if (!["drafting", "revision", "needs_evidence"].includes(content.status))
    throw new HostResearchError("content_not_writable", "稿件当前不在写作/修订/补证阶段，不能改写该稿证据账本");
  const pack = await readPack(t.contentId, t.dir);
  if (!isReadyPack(pack) || pack.packId !== t.packId || content.pack?.packId !== t.packId || pack.host !== t.host)
    throw new HostResearchError("stale_pack", "写作包已失效、尚未就绪或属于另一宿主，补证未入稿");
  if (Object.values(pack.attempts).some((a) => ["reviewing", "awaiting_host_review"].includes(a.status)))
    throw new HostResearchError("review_in_progress", "本稿正在审阅，先完成该次审稿再补证，避免修改审稿快照");
  return { ledger: pack.ledger, pack };
}

async function readHistory(file: string): Promise<Record<string, LedgerEntry>> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, LedgerEntry>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return {};
  }
}

/**
 * 登记一条进稿件台账：检查全过才过写门（作废的补证不该顺手认领一篇稿），
 * 额度账先落盘（崩溃、重领包都不重置），再同步包、包 markdown 与稿件上的账本快照。
 * `draft` 拿到已有条目（额度历史 + 当前包）决定这条的 id；返回已有 id 即幂等，不扣额度。
 */
export function attachContentEvidence(
  t: EvidenceTarget,
  draft: (known: LedgerEntry[]) => LedgerEntry,
): Promise<Record<string, unknown>> {
  return serializeWriterCall(t.contentId, async () => {
    const target = await loadWritableTarget(t);
    const file = hostEvidencePath(t.contentId, t.dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const history = await readHistory(file);
    const entry = draft([...Object.values(history), ...target.ledger.entries]);
    if (!history[entry.id] && Object.keys(history).length >= HOST_EVIDENCE_LIMIT)
      throw new HostResearchError("evidence_quota", "本稿宿主补证累计已满12条；重领包不会重置额度，请用已有材料收束");
    const grant = await gateEvidenceWrite(t);
    history[entry.id] ??= entry;
    await writeJsonAtomic(file, history);
    const ledger = restoreEvidenceLedger(target.ledger);
    for (const item of Object.values(history)) ledger.add(item);
    const snapshot = ledger.snapshot();
    if (target.pack) {
      target.pack.ledger = snapshot;
      await writePack(t.contentId, target.pack, t.dir);
      await writeTextAtomic(packPath(t.contentId, t.dir, PACK_MD), renderPack(t.contentId, target.pack));
    }
    await updateContent(t.contentId, { evidenceLedger: snapshot, _versionNote: "宿主补证登记（保留来源等级）" }, t.dir);
    return {
      content_id: t.contentId,
      ...(t.packId ? { pack_id: t.packId } : {}),
      evidence_entry: entry,
      host_evidence_used: Object.keys(history).length,
      host_evidence_limit: HOST_EVIDENCE_LIMIT,
      ...grant,
    };
  });
}

/** 写手侧登记的条目：同一句话重复登记沿用原号；新号接着台账里已有的 `user-<n>` 往下编 */
function userClaimEntry(known: LedgerEntry[], claim: string, quote: string, reason: string): LedgerEntry {
  const same = known.find((e) => e.source === "user_claim" && e.reason && e.claim === claim && e.quote === quote);
  if (same) return same;
  const max = Math.max(0, ...known.map((e) => Number(/^user-(\d+)$/.exec(e.id)?.[1] ?? 0)));
  return { id: `user-${max + 1}`, source: "user_claim", claim, quote, reason };
}

const TASK_REQUIRED =
  "先 prepare 获取 task_id；后续研究动作须带 topic_id/task_id。往稿里登记由用户材料推算出的数不需要研究任务：claim_offline 带 writer pack 回执里的 content_id、pack_id 与 claim、reason。";

/**
 * 没带 task_id 的 cite / claim_offline 在这里分流：带稿件目标的 claim_offline 直接写进稿件台账；
 * cite 要核对研究任务抓过的网页，没有任务就核不了，照实说并指向 claim_offline。其余情况返回 null，
 * 交回研究台原逻辑（仍是 task_required）。
 */
export async function routeContentEvidence(
  action: string,
  args: Record<string, unknown>,
  ctx: { topicId: string; host: string; dir: string },
): Promise<Record<string, unknown> | null> {
  if (args.task_id || (action !== "claim_offline" && action !== "cite")) return null;
  const contentId = str(args.content_id),
    packId = str(args.pack_id);
  // 导入稿（§13.4-B）没有写作包：带 content_id 不带 pack_id 的 claim_offline 也按稿件台账登记
  if (action === "cite" || !contentId || (!packId && !(await isImportDraft(contentId, ctx.dir))))
    throw new HostResearchError("task_required", TASK_REQUIRED);
  const claim = nonempty(args.claim, "claim"),
    reason = nonempty(args.reason, "reason"),
    quote = str(args.quote) || claim;
  const target = { contentId, packId, topicId: ctx.topicId, host: ctx.host, claimToken: str(args.claim_token), dir: ctx.dir };
  const attached = await attachContentEvidence(target, (known) => userClaimEntry(known, claim, quote, reason));
  const entry = attached.evidence_entry as LedgerEntry;
  return {
    ok: true,
    topic_id: ctx.topicId,
    claim_id: entry.id,
    verified: false,
    ...attached,
    note: `已登记为本稿未核验的 user_claim（${entry.id}），数字门认它；正文可以用，但不能说成已查证事实。`,
  };
}
