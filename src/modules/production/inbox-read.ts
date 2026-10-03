/**
 * 「等你拍板」的读方（review-inbox §3）：收集每条稿的输入交给纯函数 `contentItems`，外加全库的条目
 * （收件箱没对上的视频、写作规则 / 发布偏好提案）。只读，零写入（看板读零写入沿用）。
 */
import { isImportedHistory } from "../../storage/imported-history.js";
import fs from "node:fs/promises";
import path from "node:path";
import { listContents, type Content } from "../../storage/local-store.js";
import { readProductionDoc } from "../../storage/production-store.js";
import type { ProductionDoc } from "../../storage/production-types.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { readPublishRecord } from "../../storage/publish-record.js";
import { loadProfile, ruleStatus } from "../profile/creator-profile.js";
import { pendingProposals } from "../publish/review-gate/preferences.js";
import { checksDir } from "../publish/review-gate/check-store.js";
import { checkInputsNow } from "../publish/review-gate/check.js";
import { canonPlatform } from "./receipts.js";
import { attachmentsChanged } from "./asks.js";
import { withCoverGroups } from "./cover-groups.js";
import { explainContent, explainContext } from "./read.js";
import { readReconcileReport } from "./reconcile.js";
import { cachedSha } from "./observe.js";
import { arollOwnerElsewhere } from "./sha-index.js";
import { approvedCoverShas } from "./service.js";
import { contentItems, genOf, sortItems, type CheckView, type ContentInput, type InboxItem } from "./inbox.js";

interface CheckRec { check_id?: string; content_id?: string; platform?: string; checked_at?: string; input_at?: string; verdict?: string; round?: number; items?: unknown[] }

/** 谁更新：先比输入代次（开始读计划的时间，破例重跑沿用原检查的），再比完成时间，最后比 id */
const newer = (a: CheckRec, b: CheckRec) => {
  const ka = a.input_at ?? a.checked_at!, kb = b.input_at ?? b.checked_at!;
  return ka !== kb ? ka > kb : a.checked_at !== b.checked_at ? a.checked_at! > b.checked_at! : a.check_id! > b.check_id!;
};

/**
 * 每个平台当前有效的一组检查（§7-4）：本轮、同平台最新的那一次；更早的算「已被新检查取代」，不出条目。
 * 旧检查没记轮次：检查时间在本轮开始之后（或第一轮）才算本轮。已点过「没问题」的不再出。
 */
export async function currentChecks(content: Content, doc: ProductionDoc | null, dataDir: string): Promise<CheckView[]> {
  let dir: string;
  try { dir = checksDir(content.id, dataDir); } catch { return []; }
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => /^chk-[\w-]+\.json$/.test(n));
  const round = doc?.round ?? 1;
  const since = doc?.round_started_at ? Date.parse(doc.round_started_at) : -Infinity;
  const latest = new Map<string, CheckRec>();
  for (const n of names) {
    const r = JSON.parse(await fs.readFile(path.join(dir, n), "utf8").catch(() => "null")) as CheckRec | null;
    if (!r?.check_id || r.content_id !== content.id || !r.platform || !r.checked_at) continue;
    const inRound = r.round !== undefined ? r.round === round : round === 1 || Date.parse(r.checked_at) >= since;
    if (!inRound) continue;
    const p = canonPlatform(r.platform);
    const prev = latest.get(p);
    if (!prev || newer(r, prev)) latest.set(p, r);
  }
  const confirmed = new Set((doc?.decisions ?? []).filter((d) => d.type === "publish_check_confirm" && d.check_id).map((d) => d.check_id!));
  return [...latest.entries()].filter(([, r]) => !confirmed.has(r.check_id!))
    .map(([p, r]) => ({ check_id: r.check_id!, platform: p, verdict: r.verdict ?? "pass", checked_at: r.checked_at!, items: r.items ?? [] }))
    .map(async (v) => ({ ...v, input: await checkInputsNow(content.id, v.check_id, dataDir).catch(() => ({ same: false, fp: "unreadable" })) }))
    .reduce(async (acc, x) => [...(await acc), await x], Promise.resolve([] as CheckView[]));
}

async function plannedPlatforms(content: Content, dataDir: string): Promise<string[]> {
  const record = await readPublishRecord(content.id, undefined, dataDir).catch(() => ({ kind: "none" as const }));
  const fromPlan = record.kind === "none" ? [] : record.platforms.map((p) => canonPlatform(p.platform));
  const list = fromPlan.length ? fromPlan : content.platform ? [canonPlatform(content.platform)] : [];
  return [...new Set(list)];
}

async function contentInput(c: Content, dataDir: string, ctx: Awaited<ReturnType<typeof explainContext>>): Promise<ContentInput> {
  const video = isVideoPlatform(c.platform);
  const active = video && ctx.enabled && !ctx.excluded.has(c.id);
  const raw = await readProductionDoc(c.id, dataDir).catch(() => null);
  const doc = active && raw ? withCoverGroups(raw, approvedCoverShas(raw, c.body)) : null;
  const exp = active ? await explainContent(c, dataDir, ctx) : null;
  const askAttachmentsChanged: Record<string, boolean> = {};
  for (const a of (doc?.asks ?? []).filter((x) => x.state === "open" && x.attachments.length)) askAttachmentsChanged[a.id] = await attachmentsChanged(c.id, a, dataDir);
  const needsPlan = exp?.stage === "待发布" || exp?.stage === "已发布";
  // 同一段原片已经归了别条稿（比如创始人在那条卡上挂了它）：这条上的候选是过期的（verifier 2a P2）
  const ownedElsewhere = new Set<string>();
  for (const f of (doc?.facts ?? []).filter((x) => x.round === doc!.round && x.kind === "aroll" && x.state === "candidate" && x.sha256)) {
    if (await arollOwnerElsewhere(dataDir, f.sha256!, c.id).catch(() => null)) ownedElsewhere.add(f.id);
  }
  return { content: c, doc: active ? doc ?? null : null, exp, askAttachmentsChanged, checks: video ? await currentChecks(c, raw, dataDir) : [], planned: needsPlan ? await plannedPlatforms(c, dataDir) : [], log: raw?.inbox_log ?? [], ownedElsewhere };
}

/** 收件箱里没对上的视频（1b §4）：「指定给…」= 挂到那条稿（卡片挂载决定） */
async function inboxFileItems(dataDir: string, contents: Content[]): Promise<InboxItem[]> {
  const report = await readReconcileReport(dataDir);
  const waiting = contents.filter((c) => isVideoPlatform(c.platform) && !c.deletedAt && ["draft_ready", "approved"].includes(c.status)).map((c) => ({ id: c.id, title: c.title }));
  // 已经指定出去的（消费记录记在接收的那条稿上）：下一次读就不再列，不等下一轮对账（整分支审 6 P2）
  const consumed = new Set<string>();
  for (const c of contents) for (const e of (await readProductionDoc(c.id, dataDir).catch(() => null))?.inbox_log ?? []) if (e.item_id.startsWith("inbox_file:") && !e.pending) consumed.add(`${e.item_id}\u0000${e.gen}`);
  const out: InboxItem[] = [];
  for (const f of report?.inbox?.unmatched ?? []) {
    // 文件身份（字节）进代次：对账之间文件被换了，旧代次就指定不了新字节（整分支审 6 P2）
    const now = await cachedSha(f.path).catch(() => null);
    if (!now) continue;
    const snapshot = [f.path, now.sha256, now.size, now.mtime_ms];
    const item_id = `inbox_file:${genOf(f.path)}`;
    const gen = genOf([item_id, snapshot]);
    if (consumed.has(`${item_id}\u0000${gen}`)) continue;
    out.push({
      item_id, gen, type: "inbox_file" as const, content_id: null, title: f.name, summary: `收件箱里有个视频没对上：${f.name}`,
      waiting: null, agent_waiting: false, since: new Date(now.mtime_ms).toISOString(), rank: 1 as const,
      actions: [{ action: "assign", label: "指定给…", role: "primary" as const, params: { path: f.path, expect_sha: now.sha256 } }],
      detail: { name: f.name, size: now.size, guess: f.guess, choices: waiting },
    });
  }
  return out;
}

/** 其他（默认收起）：写作规则提案、发布偏好提案——原界面、原动作，这里只列出来 */
async function otherItems(dataDir: string): Promise<InboxItem[]> {
  const out: InboxItem[] = [];
  const profile = await loadProfile(dataDir).catch(() => null);
  for (const r of (profile?.writingRules ?? []).filter((x) => ruleStatus(x) === "pending")) {
    const item_id = `rule:${r.id ?? genOf(r.rule)}`;
    out.push({ item_id, gen: genOf([item_id, r.revision ?? 0]), type: "other", content_id: null, title: "写作规则提案", summary: r.rule, waiting: null, agent_waiting: false,
      since: (r as { createdAt?: string }).createdAt ?? new Date(0).toISOString(), rank: 4, actions: [], detail: { where: "settings/writing-rules", rule_id: r.id ?? null } });
  }
  for (const p of await pendingProposals(dataDir).catch(() => [])) {
    const item_id = `pref:${p.id}`;
    out.push({ item_id, gen: genOf([item_id, p.at]), type: "other", content_id: null, title: "发布偏好提案", summary: Array.isArray(p.value) ? p.value.join(" / ") : p.value, waiting: null, agent_waiting: false,
      since: p.at, rank: 4, actions: [], detail: { where: "settings/publish-prefs", proposal_id: p.id, founder_quote: p.founder_quote } });
  }
  return out;
}

export interface InboxView { ok: true; items: InboxItem[]; count: number; agent_waiting: number; generated_at: string }

/** 全库「等你拍板」（contentId 给了就只算那一条稿，给 summary / 单一入口用） */
export async function readInbox(dataDir: string, opts: { contentId?: string; now?: number } = {}): Promise<InboxView> {
  const ctx = await explainContext(dataDir);
  // 历史作品记录不进「等你拍板」
  const all = (await listContents(dataDir)).filter((c) => !isImportedHistory(c));
  const contents = opts.contentId ? all.filter((c) => c.id === opts.contentId) : all;
  const items: InboxItem[] = [];
  for (const c of contents) {
    if (c.deletedAt || c.status === "archived" || isImportedHistory(c)) continue;
    items.push(...contentItems(await contentInput(c, dataDir, ctx), opts.now));
  }
  if (!opts.contentId) items.push(...(await inboxFileItems(dataDir, all)), ...(await otherItems(dataDir)));
  const sorted = sortItems(items);
  return { ok: true, items: sorted, count: sorted.length, agent_waiting: sorted.filter((i) => i.agent_waiting).length, generated_at: new Date().toISOString() };
}
