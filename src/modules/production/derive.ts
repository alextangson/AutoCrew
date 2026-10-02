/**
 * 推导表（spec §2.6）：制作段阶段 = 事实 + 创始人决定 + 登记记录的纯函数。零 I/O。
 *
 * `deriveStage` 只对「有效认稿 + 视频平台」的稿生效，只看当前 round，第一条命中即返回：
 *   D1 已发布 → D2 待发布 → D3 剪辑中（批准齐、登记没对上）→ D4 剪辑中（有制作事实）→ D5 待录制。
 * 批准有效 = 未撤销 + 正文哈希未变 + 所绑文件记录的 sha 未被替换。文件缺失只影响 availability：
 * 不让批准失效、不让阶段倒退，只让 publishable=false（Codex P1-9）。
 */
import { bodyHash } from "../../storage/production-store.js";
import { platformLabel } from "../../desktop/platform-label.js";
import { receiptsOfRound, type Slot } from "./receipts.js";
import { isUngated } from "./publish-check-link.js";
import { sliverVerdict } from "./sliver/verdict.js";
import { validCoverGroups, withCoverGroups } from "./cover-groups.js";
import { latestMarkedCut } from "./ready.js";
import { PRODUCTION_KINDS, type Decision, type Fact, type ProductionDoc, type Registration } from "../../storage/production-types.js";

export type Stage = "待录制" | "剪辑中" | "待发布" | "已发布";
export type Rule = "D1" | "D2" | "D3" | "D4" | "D5";

/** D1 的外部输入：AutoCrew 发布器写的 publish-plan / 数据回流 = 已核实回执（§6） */
export interface PublishEvidence { verified: boolean; badge?: string; /** 最早投出的时间（投影到 published 时盖 publishedAt） */ at?: string }

export interface CandidateView { fact_id: string; kind: Fact["kind"]; path?: string; evidence?: string; post_publish?: boolean; state: Fact["state"]; sha256?: string; started_at?: string }

export interface Derived {
  stage: Stage;
  rule: Rule;
  missing: string[];
  badges: string[];
  candidates: CandidateView[];
  publishable: boolean;
  /** 依据：命中这一行靠的是哪些事实 / 决定（id，给日志和 API，不给创始人看） */
  evidence: string[];
  /** 给创始人看的一句人话原因（「有成片待你审」「抖音、B站 已定时投出」）；规则代码只留在 rule */
  reason: string;
  /** 真有问题的提示（界面标红）：文件不见了、被驳回、未登记就发布…；badges 只是中性信息 */
  alerts: string[];
}

export const UNREGISTERED_PUBLISH = "未登记就发布：发出去的成片没有登记记录可核对";

export const MISSING = {
  cut: "成片",
  srt: "字幕",
  cover34: "封面(3:4)",
  cover43: "封面(4:3)",
  cutReview: "成片待你审",
  coverPick: "封面待你选",
  aroll: "A-roll",
} as const;

const inRound = <T extends { round: number }>(doc: ProductionDoc, xs: T[]): T[] => xs.filter((x) => x.round === doc.round);
const accepted = (doc: ProductionDoc): Fact[] => inRound(doc, doc.facts).filter((f) => f.state === "accepted");
const latest = <T extends { at: string }>(xs: T[]): T | null => xs.reduce<T | null>((best, x) => (!best || x.at >= best.at ? x : best), null);

function revokedIds(doc: ProductionDoc, type: Decision["type"]): Set<string> {
  return new Set(inRound(doc, doc.decisions).filter((d) => d.type === type && d.target_id).map((d) => d.target_id as string));
}

/** 这条批准绑的文件记录还在、sha 没被替换（被覆盖 → 失效，E13） */
function liveFact(doc: ProductionDoc, kind: Fact["kind"], sha: string | undefined, ratio?: Fact["ratio"]): Fact | null {
  if (!sha) return null;
  return accepted(doc).find((f) => f.kind === kind && f.sha256 === sha && !f.replaced_at && (!ratio || f.ratio === ratio)) ?? null;
}

/**
 * 当前选定的批准 = 本轮最近一条该类批准；先定选中哪条，再验它是否有效（Codex 审：撤销 / 打回 / 失效后
 * **不回退**到更早的批准——撤批后旧包立即不可发，§5）。
 */
function selected(doc: ProductionDoc, type: "cut_approval" | "cover_approval"): Decision | null {
  return latest(inRound(doc, doc.decisions).filter((d) => d.type === type));
}

/** 当前有效的成片批准：选中的那条未撤、之后没被打回、正文未变、文件未被替换 */
export function validCutApproval(doc: ProductionDoc, body: string): Decision | null {
  const d = selected(doc, "cut_approval");
  if (!d || revokedIds(doc, "approval_revoke").has(d.id) || d.body_hash !== bodyHash(body) || !liveFact(doc, "cut", d.sha256)) return null;
  const rejected = inRound(doc, doc.decisions).some((r) => r.type === "cut_reject" && r.sha256 === d.sha256 && r.at > d.at);
  return rejected ? null : d;
}

export function validCoverApproval(doc: ProductionDoc, body: string): Decision | null {
  const d = selected(doc, "cover_approval");
  if (!d || revokedIds(doc, "approval_revoke").has(d.id) || d.body_hash !== bodyHash(body)) return null;
  // 批准之后又打回了其中一张（或含它的整批）→ 这组封面失效（Codex 审 seg2 P1）
  const pair = [d.cover_3x4_sha, d.cover_4x3_sha];
  // 按组打回（等你拍板）只作废那几组的批准：同一张图被用进新组又被打回，不连带已批的组（Codex 审 2a-1 P2）
  const rejected = inRound(doc, doc.decisions).some((r) => r.type === "cover_reject" && r.at > d.at
    && (r.group_ids ? Boolean(d.group_id) && r.group_ids.includes(d.group_id!)
      : (r.sha256 && pair.includes(r.sha256)) || (r.shas ?? []).some((s) => pair.includes(s))));
  if (rejected) return null;
  // 按组绑定的批准：只看这一组自己那几份文件有没有被覆盖（同一张图在别的组被覆盖不算，整分支审 4 P2）
  // 只看这条批准绑的那一对（整分支审 7 P2）：组里以前被换掉、后来补过新图的旧成员不算
  if (d.group_id && (doc.cover_members ?? []).some((m) => m.group_id === d.group_id && m.replaced_at && pair.includes(m.sha256))) return null;
  return liveFact(doc, "cover", d.cover_3x4_sha, "3:4") && liveFact(doc, "cover", d.cover_4x3_sha, "4:3") ? d : null;
}

/** E13：选中的批准没被撤，但它绑的文件在盘上被覆盖了 → 批准失效，写原因 */
function overwrittenAlerts(doc: ProductionDoc): string[] {
  const out: string[] = [];
  const revoked = revokedIds(doc, "approval_revoke");
  const gone = (kind: Fact["kind"], sha?: string) => Boolean(sha) && !liveFact(doc, kind, sha)
    && accepted(doc).some((f) => f.kind === kind && f.sha256 === sha && f.replaced_at);
  const cut = selected(doc, "cut_approval"), cover = selected(doc, "cover_approval");
  if (cut && !revoked.has(cut.id) && gone("cut", cut.sha256)) out.push("所批成片的文件被覆盖了，成片批准已失效：重新审这版成片");
  if (cover && !revoked.has(cover.id) && (gone("cover", cover.cover_3x4_sha) || gone("cover", cover.cover_4x3_sha))) out.push("所选封面的文件被覆盖了，封面批准已失效：重新选封面");
  return out;
}

/** 某版成片的字幕：for_cut = 成片 sha 的最近一条 accepted srt */
export function srtFor(doc: ProductionDoc, cutSha: string | undefined): Fact | null {
  if (!cutSha) return null;
  return latest(accepted(doc).filter((f) => f.kind === "srt" && f.for_cut === cutSha && !f.replaced_at));
}

/** 本轮的发布回执（§6）：每个平台一个发布槽，见 receipts.ts */
export function publishReceipts(doc: ProductionDoc): { live: Slot[]; rejected: Slot[]; pending: Slot[] } {
  return receiptsOfRound(doc);
}

const label = (p?: string) => (p ? platformLabel(p) : "平台");

/** 待核声明是要创始人确认的中性提示；被驳回是问题 */
function receiptNotes(r: ReturnType<typeof publishReceipts>): { badges: string[]; alerts: string[] } {
  return {
    badges: r.pending.map((w) => pendingText(w)),
    alerts: r.rejected.map((f) => `${label(f.platform)}被驳回${f.reason ? `：${f.reason}` : ""}`),
  };
}

/**
 * 闸门存在之后、没有有效检查就发了（发布审查闸门 §11、E15）：卡片上只汇总一句「N 个平台发布前未把关」，
 * 哪个平台由面板的回执行标；结论是写入时盖的，事后补检不改
 */
export function gateAlerts(live: Slot[]): string[] {
  const n = live.filter((s) => isUngated(s.gate)).length;
  return n ? [`${n} 个平台发布前未把关`] : [];
}

/** 检查里创始人的原话例外：逐字显示 */
export function overrideBadges(live: Slot[]): string[] {
  return [...new Set(live.flatMap((s) => (s.gate?.overrides ?? []).map((q) => `${label(s.platform)}发布前例外：『${q}』`)))];
}

/** 待你确认的那一句：谁说的、发到哪、哪件作品 */
function pendingText(w: Slot): string {
  const what = w.url ? `：${w.url}` : w.item_id ? `（作品 ${w.item_id}）` : "";
  if (w.source === "claim") return `${w.host ?? "AI"} 说已发到${label(w.platform)}${what}，是吗？`;
  if (w.source === "metrics_title") return `数据回流猜这条发到了${label(w.platform)}${what}，是吗？`;
  return `${label(w.platform)}有一条发布记录${what}，是吗？`;
}

/** 已发布的人话原因：按状态把平台归在一起（「抖音、B站 已定时投出」「B站 你标了已发布」） */
function publishedReason(live: Slot[]): string {
  if (!live.length) return "发布记录显示已投出";
  if (live.every((s) => s.by === "founder")) return `${[...new Set(live.map((s) => label(s.platform)))].join("、")} 你标了已发布`;
  const by = new Map<string, string[]>();
  for (const f of live) by.set(f.pub_state, [...(by.get(f.pub_state) ?? []), label(f.platform)]);
  const text: Record<string, string> = { scheduled: "已定时投出", reviewing: "已投出、审核中", public: "已公开", overdue: "应已公开" };
  return [...by].map(([st, ps]) => `${[...new Set(ps)].join("、")} ${text[st] ?? "已投出"}`).join("；");
}

export function candidatesOf(doc: ProductionDoc): CandidateView[] {
  return inRound(doc, doc.facts)
    .filter((f) => f.state === "candidate" || f.state === "pending_match")
    .sort((a, b) => b.at.localeCompare(a.at))
    // 文件名规则得出的候选全列（E4）；只有 1b 的转写打分候选才截前三
    .map((f) => ({ fact_id: f.id, kind: f.kind, state: f.state, ...(f.sha256 ? { sha256: f.sha256 } : {}), ...(f.path ? { path: f.path } : {}), ...(f.evidence ? { evidence: f.evidence } : {}), ...(f.post_publish ? { post_publish: true } : {}), ...(f.state === "pending_match" && f.match_started_at ? { started_at: f.match_started_at } : {}) }));
}

/**
 * 登记记录与当前有效批准组合完全一致（D2）。legacy 登记没有豁免：它只有在迁移时带进了旧 register 核过的
 * gate3 / gate4 批准与字幕（都成了本轮的 legacy 决定 / 事实）时才对得上；本轮任何新批准都会顶掉它。
 */
export function matchingRegistration(doc: ProductionDoc, body: string, cut: Decision | null, cover: Decision | null): Registration | null {
  if (!cut || !cover) return null;
  const bh = bodyHash(body);
  const regs = inRound(doc, doc.registrations).filter((r) => r.body_hash === bh).reverse();
  const srt = srtFor(doc, cut.sha256);
  return regs.find((r) => r.cut_approval_id === cut.id && r.cut_sha === cut.sha256
    && r.cover_approval_id === cover.id && r.cover_3x4_sha === cover.cover_3x4_sha && r.cover_4x3_sha === cover.cover_4x3_sha
    && r.cover_text === cover.cover_text && Boolean(srt) && r.srt_sha === srt!.sha256 && r.srt_for_cut === cut.sha256) ?? null;
}

/** 登记绑的文件都在（availability=present）才可发布；缺了阶段不退，只拦发布 */
function registrationFilesPresent(doc: ProductionDoc, reg: Registration): boolean {
  const shas = [reg.cut_sha, reg.cover_3x4_sha, reg.cover_4x3_sha, reg.srt_sha].filter((s): s is string => Boolean(s));
  return shas.every((sha) => accepted(doc).some((f) => f.sha256 === sha && f.availability === "present"));
}

function editingMissing(doc: ProductionDoc, cut: Decision | null, cover: Decision | null): { missing: string[]; badges: string[] } {
  const facts = accepted(doc).filter((f) => !f.replaced_at);
  const cuts = facts.filter((f) => f.kind === "cut");
  const newest = latest(cuts);
  const missing: string[] = [];
  const badges: string[] = [];
  if (!newest) missing.push(MISSING.cut);
  else if (!srtFor(doc, (cut && liveFact(doc, "cut", cut.sha256)?.sha256) ?? newest.sha256)) missing.push(MISSING.srt);
  // 封面按有效组算（review-inbox §6）：不凭「最新一版缺哪个比例」猜配对
  const groups = validCoverGroups(doc);
  const complete = groups.filter((g) => g.complete);
  const coverAsk = coverRejectNote(doc, complete.at(-1)?.at);
  if (!complete.length) {
    const last = groups.at(-1);
    if (!last?.slots["3:4"].length) missing.push(MISSING.cover34);
    if (!last?.slots["4:3"].length) missing.push(MISSING.cover43);
  }
  // 成片待你审只认 agent 标过「可以审了」的（§7-1）：对账自动收的导出不算
  const marked = latestMarkedCut(doc);
  const review = marked?.fact ?? null;
  // 创始人点了「还要改…」：在 agent 交新版 / 重新标可以审之前，说的是那句话，不再是「成片待你审」（verifier 2a P1）
  const cutAsk = marked ? cutRejectNote(doc, marked.fact.sha256!, marked.marked_at) : null;
  if (review && !cut && cutAsk) missing.push(`你说还要改：${cutAsk}`);
  else if (review && !cut) {
    missing.push(MISSING.cutReview);
    // 抽帧检查（spec 2026-09-30 §6）：没结果 / 有未放行的缝 / 没跑成且没整条放行 → 写进还差什么
    const v = sliverVerdict(doc, review.sha256!, null);
    if (!v.ok && v.missing) missing.push(v.missing);
  }
  if (complete.length && !cover) missing.push(coverAsk ? `你说封面还要改：${coverAsk}` : MISSING.coverPick);
  const approvedCut = cut ? liveFact(doc, "cut", cut.sha256) : null;
  if (approvedCut && review && review.sha256 !== approvedCut.sha256 && review.at > approvedCut.at) badges.push("有新成片待你审");
  return { missing, badges };
}

const clipNote = (s: string) => (Array.from(s).length > 40 ? `${Array.from(s).slice(0, 40).join("")}…` : s);

/** 这版成片在「可以审了」之后被打回的那句话（之后又标过就不算） */
export function cutRejectNote(doc: ProductionDoc, sha: string, markedAt: string): string | null {
  const r = inRound(doc, doc.decisions).filter((d) => d.type === "cut_reject" && d.sha256 === sha && d.at >= markedAt).at(-1);
  return r ? clipNote(r.note ?? "") : null;
}

/** 最新一组完整封面之后的打回（之后又交了新的一组就不算） */
export function coverRejectNote(doc: ProductionDoc, newestGroupAt: string | undefined): string | null {
  const r = inRound(doc, doc.decisions).filter((d) => d.type === "cover_reject" && (!newestGroupAt || d.at >= newestGroupAt)).at(-1);
  return r ? clipNote(r.note ?? "") : null;
}

function editingReason(missing: string[]): string {
  const ask = missing.find((m) => m.startsWith("你说"));
  if (ask) return `${ask}，等 AI 交新版`;
  if (missing.includes(MISSING.cutReview)) return "有成片待你审";
  if (missing.includes(MISSING.coverPick)) return "有封面待你选";
  return missing.length ? `剪辑中，还差：${missing.join("、")}` : "剪辑中";
}

/** 调用方保证：视频平台 + 有效认稿（`scriptApprovalFor`） */
export function deriveStage(raw: ProductionDoc, body: string, publish: PublishEvidence): Derived {
  // 还没按 §6.2 迁移的 doc：内存里按同一条规则迁移（对账写盘后是同一个结果）
  const pre = validCoverApproval(raw, body);
  const doc = withCoverGroups(raw, new Set([pre?.cover_3x4_sha, pre?.cover_4x3_sha].filter((x): x is string => Boolean(x))));
  const candidates = candidatesOf(doc);
  const base = { candidates, publishable: false, badges: [] as string[], missing: [] as string[], alerts: [] as string[] };
  const receipts = publishReceipts(doc);
  if (publish.verified || receipts.live.length) {
    // 各平台状态已经收进原因句（「抖音、B站 已定时投出」），不再逐条重复成徽章
    const badges = receipts.live.length ? [] : publish.badge ? [publish.badge] : [];
    const evidence = [...receipts.live.map((f) => `槽 ${f.id}（${f.by}）`), ...(publish.verified ? ["发布记录：已投出"] : [])];
    // 本轮没有登记记录就发出去了（agent 直接发）：发出去的成片没人核过
    // 其他平台已投出时，被驳回平台的原因照样上卡（E35）
    const alerts = [...(inRound(doc, doc.registrations).length ? [] : [UNREGISTERED_PUBLISH]), ...receiptNotes(receipts).alerts, ...gateAlerts(receipts.live)];
    badges.push(...overrideBadges(receipts.live));
    return { ...base, stage: "已发布", rule: "D1", badges, alerts, publishable: false, evidence, reason: publish.verified && !receipts.live.length && publish.badge ? publish.badge : publishedReason(receipts.live) };
  }
  const notes = receiptNotes(receipts);
  base.badges = notes.badges;
  base.alerts = [...notes.alerts, ...overwrittenAlerts(doc)];
  const cut = validCutApproval(doc, body), cover = validCoverApproval(doc, body);
  const reg = matchingRegistration(doc, body, cut, cover);
  if (reg) {
    const present = registrationFilesPresent(doc, reg);
    return { ...base, stage: "待发布", rule: "D2", publishable: present, alerts: [...base.alerts, ...(present ? [] : ["文件不见了"])], evidence: [`登记记录 ${reg.id}`],
      reason: present ? "成片和封面都通过了，已登记，可以发" : "已登记，但登记的文件不见了，先找回再发" };
  }
  if (cut && cover) {
    const failure = doc.commit_failure?.round === doc.round ? doc.commit_failure.reason : null;
    const why = srtFor(doc, cut.sha256) ? failure ?? "登记还没完成" : "缺这版成片的字幕";
    return { ...base, stage: "剪辑中", rule: "D3", missing: [why], evidence: [`成片批准 ${cut.id}`, `封面批准 ${cover.id}`], reason: `成片和封面都通过了，${why}` };
  }
  const facts = accepted(doc).filter((f) => PRODUCTION_KINDS.has(f.kind));
  if (facts.length) {
    const { missing, badges } = editingMissing(doc, cut, cover);
    // 有缝 / 检查没跑成是真问题：看板卡上标红（「还没有结果」只是等检查，不标红）
    const sliverAlerts = missing.filter((m) => m.startsWith("抽帧缝") || m.startsWith("抽帧检查没跑成"));
    return { ...base, stage: "剪辑中", rule: "D4", missing, alerts: [...base.alerts, ...sliverAlerts], badges: [...base.badges, ...badges], evidence: facts.slice(0, 5).map((f) => `事实 ${f.id}（${f.kind}）`), reason: editingReason(missing) };
  }
  // 1b §3-8：pending_match 显示「正在核对原片」，别的候选才是「发现疑似 A-roll」
  const checking = candidates.some((c) => c.kind === "aroll" && c.state === "pending_match");
  const suspect = candidates.some((c) => c.kind === "aroll" && c.state === "candidate");
  const badges = [...base.badges, ...(checking ? [PENDING_BADGE] : []), ...(suspect ? ["发现疑似 A-roll"] : [])];
  return { ...base, stage: "待录制", rule: "D5", missing: [MISSING.aroll], badges, evidence: ["有效认稿，本轮还没有制作事实"],
    reason: suspect ? "认过稿，发现了疑似 A-roll 等你确认" : checking ? "认过稿，正在核对 agent 报来的原片" : "认过稿，还没有原片" };
}

export const PENDING_BADGE = "正在核对原片";

/** 写稿段稿件已有制作事实：仍在写稿中，只挂 badge（§2.1） */
export function writingBadge(doc: ProductionDoc | null): string | null {
  if (!doc) return null;
  const kinds = new Set(accepted(doc).filter((f) => PRODUCTION_KINDS.has(f.kind)).map((f) => f.kind));
  if (!kinds.size) return inRound(doc, doc.facts).some((f) => f.kind === "aroll" && f.state === "pending_match") ? PENDING_BADGE : null;
  const aroll = kinds.has("aroll"), other = [...kinds].some((k) => k !== "aroll");
  const what = aroll && other ? "原片 / 剪辑产物" : aroll ? "原片" : "剪辑产物";
  return `已有${what}，等你认稿`;
}
