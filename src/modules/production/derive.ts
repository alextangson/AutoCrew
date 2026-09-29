/**
 * 推导表（spec §2.6）：制作段阶段 = 事实 + 创始人决定 + 登记记录的纯函数。零 I/O。
 *
 * `deriveStage` 只对「有效认稿 + 视频平台」的稿生效，只看当前 round，第一条命中即返回：
 *   D1 已发布 → D2 待发布 → D3 剪辑中（批准齐、登记没对上）→ D4 剪辑中（有制作事实）→ D5 待录制。
 * 批准有效 = 未撤销 + 正文哈希未变 + 所绑文件记录的 sha 未被替换。文件缺失只影响 availability：
 * 不让批准失效、不让阶段倒退，只让 publishable=false（Codex P1-9）。
 */
import { bodyHash } from "../../storage/production-store.js";
import { PRODUCTION_KINDS, type Decision, type Fact, type ProductionDoc, type Registration } from "../../storage/production-types.js";

export type Stage = "待录制" | "剪辑中" | "待发布" | "已发布";
export type Rule = "D1" | "D2" | "D3" | "D4" | "D5";

/** D1 的外部输入：AutoCrew 发布器写的 publish-plan / 数据回流 = 已核实回执（§6） */
export interface PublishEvidence { verified: boolean; badge?: string; /** 最早投出的时间（投影到 published 时盖 publishedAt） */ at?: string }

export interface CandidateView { fact_id: string; kind: Fact["kind"]; path?: string; evidence?: string; post_publish?: boolean; state: Fact["state"] }

export interface Derived {
  stage: Stage;
  rule: Rule;
  missing: string[];
  badges: string[];
  candidates: CandidateView[];
  publishable: boolean;
  /** 依据：命中这一行靠的是哪些事实 / 决定 */
  evidence: string[];
}

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

export function candidatesOf(doc: ProductionDoc): CandidateView[] {
  return inRound(doc, doc.facts)
    .filter((f) => f.state === "candidate" || f.state === "pending_match")
    .sort((a, b) => b.at.localeCompare(a.at))
    // 文件名规则得出的候选全列（E4）；只有 1b 的转写打分候选才截前三
    .map((f) => ({ fact_id: f.id, kind: f.kind, state: f.state, ...(f.path ? { path: f.path } : {}), ...(f.evidence ? { evidence: f.evidence } : {}), ...(f.post_publish ? { post_publish: true } : {}) }));
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

/** 调用方保证：视频平台 + 有效认稿（`scriptApprovalFor`） */
export function deriveStage(doc: ProductionDoc, body: string, publish: PublishEvidence): Derived {
  const candidates = candidatesOf(doc);
  const base = { candidates, publishable: false, badges: [] as string[], missing: [] as string[] };
  const published = validPublished(doc);
  if (publish.verified || published) {
    const badges = publish.badge ? [publish.badge] : published ? ["你标了已发布"] : [];
    return { ...base, stage: "已发布", rule: "D1", badges, publishable: false, evidence: [publish.verified ? "发布记录：已投出" : `决定 ${published!.id}：我发了`] };
  }
  const cut = validCutApproval(doc, body), cover = validCoverApproval(doc, body);
  const reg = matchingRegistration(doc, body, cut, cover);
  if (reg) {
    const present = registrationFilesPresent(doc, reg);
    return { ...base, stage: "待发布", rule: "D2", publishable: present, badges: present ? [] : ["文件不见了"], evidence: [`登记记录 ${reg.id}`] };
  }
  if (cut && cover) {
    const failure = doc.commit_failure?.round === doc.round ? doc.commit_failure.reason : null;
    const why = srtFor(doc, cut.sha256) ? failure ?? "登记还没完成" : "缺这版成片的字幕";
    return { ...base, stage: "剪辑中", rule: "D3", missing: [why], evidence: [`成片批准 ${cut.id}`, `封面批准 ${cover.id}`] };
  }
  const facts = accepted(doc).filter((f) => PRODUCTION_KINDS.has(f.kind));
  if (facts.length) {
    const { missing, badges } = editingMissing(doc, cut, cover);
    return { ...base, stage: "剪辑中", rule: "D4", missing, badges, evidence: facts.slice(0, 5).map((f) => `事实 ${f.id}（${f.kind}）`) };
  }
  const suspect = candidates.some((c) => c.kind === "aroll");
  return { ...base, stage: "待录制", rule: "D5", missing: [MISSING.aroll], badges: suspect ? ["发现疑似 A-roll"] : [], evidence: ["有效认稿，本轮还没有制作事实"] };
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
