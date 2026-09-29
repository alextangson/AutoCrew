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
import { receiptsOfRound, type Work } from "./receipts.js";
import { PRODUCTION_KINDS, type Decision, type Fact, type ProductionDoc, type Registration } from "../../storage/production-types.js";

export type Stage = "待录制" | "剪辑中" | "待发布" | "已发布";
export type Rule = "D1" | "D2" | "D3" | "D4" | "D5";

/** D1 的外部输入：AutoCrew 发布器写的 publish-plan / 数据回流 = 已核实回执（§6） */
export interface PublishEvidence { verified: boolean; badge?: string; /** 最早投出的时间（投影到 published 时盖 publishedAt） */ at?: string }

export interface CandidateView { fact_id: string; kind: Fact["kind"]; path?: string; evidence?: string; post_publish?: boolean; state: Fact["state"]; sha256?: string }

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
  const rejected = inRound(doc, doc.decisions).some((r) => r.type === "cover_reject" && r.at > d.at
    && ((r.sha256 && pair.includes(r.sha256)) || (r.shas ?? []).some((s) => pair.includes(s))));
  if (rejected) return null;
  return liveFact(doc, "cover", d.cover_3x4_sha, "3:4") && liveFact(doc, "cover", d.cover_4x3_sha, "4:3") ? d : null;
}

/** 某版成片的字幕：for_cut = 成片 sha 的最近一条 accepted srt */
export function srtFor(doc: ProductionDoc, cutSha: string | undefined): Fact | null {
  if (!cutSha) return null;
  return latest(accepted(doc).filter((f) => f.kind === "srt" && f.for_cut === cutSha && !f.replaced_at));
}

function validPublished(doc: ProductionDoc): Decision | null {
  const corrected = revokedIds(doc, "publish_correction");
  return latest(inRound(doc, doc.decisions).filter((d) => d.type === "i_published" && !corrected.has(d.id)));
}


/** 本轮的发布回执（§6）：不可变观察按作品求值，见 receipts.ts */
export function publishReceipts(doc: ProductionDoc): { live: Work[]; rejected: Work[]; pending: Work[] } {
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

/** 已发布的人话原因：按状态把平台归在一起（「抖音、B站 已定时投出」） */
/** 待你确认的那一句：谁说的、发到哪、哪件作品 */
function pendingText(w: Work): string {
  const what = w.url ? `：${w.url}` : w.item_id ? `（作品 ${w.item_id}）` : "";
  if (w.source === "claim") return `${w.host ?? "AI"} 说已发到${label(w.platform)}${what}，是吗？`;
  if (w.source === "metrics_title") return `数据回流猜这条发到了${label(w.platform)}${what}，是吗？`;
  return `发布计划里有${label(w.platform)}的发布记录${what}，但分不清是不是这一轮发的，是吗？`;
}

function publishedReason(live: Work[], founder: boolean): string {
  if (!live.length) return founder ? "你标了已发布" : "发布记录显示已投出";
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
    .map((f) => ({ fact_id: f.id, kind: f.kind, state: f.state, ...(f.sha256 ? { sha256: f.sha256 } : {}), ...(f.path ? { path: f.path } : {}), ...(f.evidence ? { evidence: f.evidence } : {}), ...(f.post_publish ? { post_publish: true } : {}) }));
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
  const has34 = facts.some((f) => f.kind === "cover" && f.ratio === "3:4");
  const has43 = facts.some((f) => f.kind === "cover" && f.ratio === "4:3");
  if (!has34) missing.push(MISSING.cover34);
  if (!has43) missing.push(MISSING.cover43);
  if (newest && !cut) missing.push(MISSING.cutReview);
  if (has34 && has43 && !cover) missing.push(MISSING.coverPick);
  const approvedCut = cut ? liveFact(doc, "cut", cut.sha256) : null;
  if (approvedCut && newest && newest.sha256 !== approvedCut.sha256 && newest.at > approvedCut.at) badges.push("有新成片待你审");
  return { missing, badges };
}

function editingReason(missing: string[]): string {
  if (missing.includes(MISSING.cutReview)) return "有成片待你审";
  if (missing.includes(MISSING.coverPick)) return "有封面待你选";
  return missing.length ? `剪辑中，还差：${missing.join("、")}` : "剪辑中";
}

/** 调用方保证：视频平台 + 有效认稿（`scriptApprovalFor`） */
export function deriveStage(doc: ProductionDoc, body: string, publish: PublishEvidence): Derived {
  const candidates = candidatesOf(doc);
  const base = { candidates, publishable: false, badges: [] as string[], missing: [] as string[], alerts: [] as string[] };
  const published = validPublished(doc);
  const receipts = publishReceipts(doc);
  if (publish.verified || published || receipts.live.length) {
    // 各平台状态已经收进原因句（「抖音、B站 已定时投出」），不再逐条重复成徽章
    const badges = receipts.live.length ? [] : [...(publish.badge ? [publish.badge] : []), ...(published && !publish.badge ? ["你标了已发布"] : [])];
    const evidence = [...receipts.live.map((f) => `回执 ${f.id}`), ...(publish.verified ? ["发布记录：已投出"] : []), ...(published ? [`决定 ${published.id}：我发了`] : [])];
    // 本轮没有登记记录就发出去了（agent 直接发）：发出去的成片没人核过
    const alerts = inRound(doc, doc.registrations).length ? [] : [UNREGISTERED_PUBLISH];
    return { ...base, stage: "已发布", rule: "D1", badges, alerts, publishable: false, evidence, reason: publish.verified && !receipts.live.length && publish.badge ? publish.badge : publishedReason(receipts.live, Boolean(published)) };
  }
  const notes = receiptNotes(receipts);
  base.badges = notes.badges;
  base.alerts = notes.alerts;
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
    return { ...base, stage: "剪辑中", rule: "D4", missing, badges: [...base.badges, ...badges], evidence: facts.slice(0, 5).map((f) => `事实 ${f.id}（${f.kind}）`), reason: editingReason(missing) };
  }
  const suspect = candidates.some((c) => c.kind === "aroll");
  return { ...base, stage: "待录制", rule: "D5", missing: [MISSING.aroll], badges: [...base.badges, ...(suspect ? ["发现疑似 A-roll"] : [])], evidence: ["有效认稿，本轮还没有制作事实"],
    reason: suspect ? "认过稿，发现了疑似 A-roll 等你确认" : "认过稿，还没有原片" };
}

/** 写稿段稿件已有制作事实：仍在写稿中，只挂 badge（§2.1） */
export function writingBadge(doc: ProductionDoc | null): string | null {
  if (!doc) return null;
  const kinds = new Set(accepted(doc).filter((f) => PRODUCTION_KINDS.has(f.kind)).map((f) => f.kind));
  if (!kinds.size) return null;
  const aroll = kinds.has("aroll"), other = [...kinds].some((k) => k !== "aroll");
  const what = aroll && other ? "A-roll / 剪辑产物" : aroll ? "A-roll" : "剪辑产物";
  return `已有 ${what}，等你认稿`;
}
