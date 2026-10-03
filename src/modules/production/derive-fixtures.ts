/**
 * 推导表夹具（spec §2.6 / §16）：每一行的正例与反例，外加 §16 列出的推导用例。
 * 只给测试用；放成独立文件是为了让「表」本身一眼能读完，改推导表时先改这里。
 */
import { bodyHash } from "../../storage/production-store.js";
import { emptyProductionDoc, type Decision, type Fact, type ProductionDoc, type Registration } from "../../storage/production-types.js";
import type { PublishEvidence, Rule, Stage } from "./derive.js";

export const BODY = "定稿正文：这一版是认过的。";
export const BH = bodyHash(BODY);
const sha = (c: string) => c.repeat(64);
export const SHA = { aroll: sha("a"), cut: sha("c"), cut2: sha("d"), srt: sha("e"), c34: sha("3"), c43: sha("4") };

let n = 0;
const t = (i: number) => `2026-09-29T0${Math.min(i, 9)}:00:00.000Z`;

export function fact(kind: Fact["kind"], shaV: string | undefined, extra: Partial<Fact> = {}): Fact {
  n++;
  return { id: `f-${kind}-${n}`, kind, round: 1, state: "accepted", availability: "present", source: "record", at: t(1), ...(shaV ? { sha256: shaV, path: kind === "cover" ? `05-cover/v001/cover-${n}.png` : `x/${kind}-${n}` } : {}), ...extra };
}
export function decision(type: Decision["type"], extra: Partial<Decision> = {}): Decision {
  n++;
  return { id: `d-${type}-${n}`, type, round: 1, at: t(2), source: "founder", ...extra };
}

export const script = (hash = BH) => decision("script_approval", { body_hash: hash });
export const cutOk = (s = SHA.cut, extra: Partial<Decision> = {}) => decision("cut_approval", { sha256: s, body_hash: BH, at: t(3), ...extra });
export const coverOk = (extra: Partial<Decision> = {}) => decision("cover_approval", { cover_3x4_sha: SHA.c34, cover_4x3_sha: SHA.c43, cover_text: "AI 又忘了？", body_hash: BH, at: t(3), ...extra });

/** 夹具里的成片默认都被 agent 标过「可以审了」（review-inbox §7-1）；unmarked=true 模拟对账自动收的导出 */
export function doc(facts: Fact[], decisions: Decision[], registrations: Registration[] = [], opts: { unmarked?: boolean } = {}): ProductionDoc {
  const ready_marks = opts.unmarked ? [] : facts.filter((f) => f.kind === "cut" && f.sha256).map((f) => ({ id: `rm-${f.id}`, fact_id: f.id, sha256: f.sha256!, round: f.round, at: f.at }));
  return { ...emptyProductionDoc(), facts, decisions: [script(), ...decisions], registrations, ready_marks };
}

/** 全套产物：原片、成片、它的字幕、两张封面 */
export function fullFacts(extra: Partial<Record<"cut" | "srt" | "c34" | "c43", Partial<Fact>>> = {}): Fact[] {
  return [
    fact("aroll", SHA.aroll),
    fact("cut", SHA.cut, extra.cut),
    fact("srt", SHA.srt, { for_cut: SHA.cut, ...extra.srt }),
    fact("cover", SHA.c34, { ratio: "3:4", ...extra.c34 }),
    fact("cover", SHA.c43, { ratio: "4:3", ...extra.c43 }),
  ];
}

export function registrationFor(cut: Decision, cover: Decision, extra: Partial<Registration> = {}): Registration {
  return {
    id: "reg-1", round: 1, at: t(4), source: "commit", body_hash: BH, cut_approval_id: cut.id, cut_sha: cut.sha256, cover_approval_id: cover.id,
    cover_3x4_sha: cover.cover_3x4_sha, cover_4x3_sha: cover.cover_4x3_sha, cover_text: cover.cover_text, srt_sha: SHA.srt, srt_for_cut: cut.sha256, ...extra,
  };
}

export interface DeriveCase {
  name: string;
  build: () => { doc: ProductionDoc; body?: string; publish?: PublishEvidence };
  expect: { stage: Stage; rule: Rule; missing?: string[]; missingIncludes?: string[]; badges?: string[]; alerts?: string[]; publishable?: boolean };
}

function registered(extra: { cut?: Partial<Decision>; reg?: Partial<Registration>; facts?: Parameters<typeof fullFacts>[0] } = {}) {
  const cut = cutOk(SHA.cut, extra.cut), cover = coverOk();
  return doc(fullFacts(extra.facts), [cut, cover], [registrationFor(cut, cover, extra.reg)]);
}

export const DERIVE_CASES: DeriveCase[] = [
  // D1
  { name: "D1+ 已核实发布回执 → 已发布", build: () => ({ doc: registered(), publish: { verified: true, badge: "douyin 审核中" } }), expect: { stage: "已发布", rule: "D1", badges: ["douyin 审核中"] } },
  { name: "D1+ 创始人点了「我发了」→ 已发布", build: () => ({ doc: doc(fullFacts(), [decision("i_published", { platform: "douyin" })]) }), expect: { stage: "已发布", rule: "D1" } },
  { name: "D1- 「我发了」被纠正 → 不命中 D1", build: () => { const p = decision("i_published"); return { doc: doc(fullFacts(), [p, decision("publish_correction", { target_id: p.id })]) }; }, expect: { stage: "剪辑中", rule: "D4" } },
  { name: "D1- 回执被驳回（未投出）→ 不命中 D1，回待发布", build: () => ({ doc: registered(), publish: { verified: false } }), expect: { stage: "待发布", rule: "D2", publishable: true } },
  // D2
  { name: "D2+ 登记记录与当前有效批准完全一致 → 待发布", build: () => ({ doc: registered() }), expect: { stage: "待发布", rule: "D2", publishable: true, badges: [] } },
  { name: "D2+ 所绑文件不见了 → 阶段不倒退、publishable=false", build: () => ({ doc: registered({ facts: { cut: { availability: "missing" } } }) }), expect: { stage: "待发布", rule: "D2", publishable: false, badges: [], alerts: ["文件不见了"] } },
  { name: "D2+ 登记绑的字幕不见了、另一版成片有同字节字幕 → 仍 publishable=false", build: () => { const d = registered({ facts: { srt: { availability: "missing" } } }); d.facts.push(fact("srt", SHA.srt, { for_cut: SHA.cut2 })); return { doc: d }; }, expect: { stage: "待发布", rule: "D2", publishable: false, badges: [], alerts: ["文件不见了"] } },
  { name: "D2- 登记记录的字幕与当前不一致 → 不命中 D2", build: () => ({ doc: registered({ reg: { srt_sha: SHA.cut2 } }) }), expect: { stage: "剪辑中", rule: "D3" } },
  { name: "D2- 登记记录绑的是别的成片批准 → 不命中 D2", build: () => ({ doc: registered({ reg: { cut_approval_id: "d-old" } }) }), expect: { stage: "剪辑中", rule: "D3" } },
  { name: "D2- 登记后正文变了（批准随正文哈希失效）→ 不命中 D2", build: () => ({ doc: registered(), body: "改过的正文" }), expect: { stage: "剪辑中", rule: "D4" } },
  // D3
  { name: "D3+ 两个批准都有效但缺这版成片的字幕 → 剪辑中写原因", build: () => { const c = cutOk(), v = coverOk(); return { doc: doc(fullFacts({ srt: { for_cut: SHA.cut2 } }), [c, v]) }; }, expect: { stage: "剪辑中", rule: "D3", missing: ["缺这版成片的字幕"] } },
  { name: "D3+ 字幕齐了但登记没提交 → 剪辑中「登记还没完成」", build: () => ({ doc: doc(fullFacts(), [cutOk(), coverOk()]) }), expect: { stage: "剪辑中", rule: "D3", missing: ["登记还没完成"] } },
  { name: "D3+ 有更早的登记记录也不借用", build: () => { const old = cutOk(SHA.cut2), c = cutOk(SHA.cut, { at: t(5) }), v = coverOk(); const facts = [...fullFacts(), fact("cut", SHA.cut2)]; return { doc: doc(facts, [old, c, v], [registrationFor(old, v)]) }; }, expect: { stage: "剪辑中", rule: "D3" } },
  { name: "D3- 封面批准被撤销 → 不命中 D3", build: () => { const v = coverOk(); return { doc: doc(fullFacts(), [cutOk(), v, decision("approval_revoke", { target_id: v.id, at: t(6) })]) }; }, expect: { stage: "剪辑中", rule: "D4", missingIncludes: ["封面待你选"] } },
  // D4
  { name: "D4+ 只有原片 → 剪辑中，缺成片与两张封面", build: () => ({ doc: doc([fact("aroll", SHA.aroll)], []) }), expect: { stage: "剪辑中", rule: "D4", missing: ["成片", "封面(3:4)", "封面(4:3)"] } },
  { name: "D4+ 全套产物无批准 → 成片待你审 / 封面待你选（pzey0m 形状）", build: () => ({ doc: doc(fullFacts(), []) }), expect: { stage: "剪辑中", rule: "D4", missing: ["成片待你审", "抽帧检查还没有结果", "封面待你选"] } },
  { name: "D4+ 对账自动收的成片（没标可以审了）不算待你审（review-inbox §7-1）", build: () => ({ doc: doc(fullFacts(), [], [], { unmarked: true }) }), expect: { stage: "剪辑中", rule: "D4", missing: ["封面待你选"] } },
  { name: "D4+ 一组只有 3:4 → 还差 4:3，不出封面待你选（review-inbox §6.1）", build: () => ({ doc: doc([fact("cut", SHA.cut), fact("srt", SHA.srt, { for_cut: SHA.cut }), fact("cover", SHA.c34, { ratio: "3:4", path: "05-cover/v001/a.png" }), fact("cover", SHA.c43, { ratio: "4:3", path: "05-cover/v002/b.png", at: t(5) })], []) }), expect: { stage: "剪辑中", rule: "D4", missing: ["封面(3:4)", "成片待你审", "抽帧检查还没有结果"] } },
  { name: "D4+ 成片没字幕 → 缺字幕", build: () => ({ doc: doc([fact("cut", SHA.cut)], []) }), expect: { stage: "剪辑中", rule: "D4", missingIncludes: ["字幕", "成片待你审"] } },
  { name: "D4+ 文件缺失（availability=missing）不倒退", build: () => ({ doc: doc([fact("aroll", SHA.aroll, { availability: "missing" })], []) }), expect: { stage: "剪辑中", rule: "D4" } },
  { name: "D4+ 只有 ChatCut 工程也算制作事实", build: () => ({ doc: doc([fact("chatcut_project", undefined, { project_id: "p1" })], []) }), expect: { stage: "剪辑中", rule: "D4" } },
  { name: "D4+ 新成片不作废旧批准，只挂「有新成片待你审」", build: () => ({ doc: doc([...fullFacts(), fact("cut", SHA.cut2, { at: t(7) })], [cutOk()]) }), expect: { stage: "剪辑中", rule: "D4", badges: ["有新成片待你审"], missingIncludes: ["封面待你选"] } },
  { name: "D4- 事实只是候选 → 不算制作事实", build: () => ({ doc: doc([fact("aroll", SHA.aroll, { state: "candidate" })], []) }), expect: { stage: "待录制", rule: "D5", badges: ["发现疑似 A-roll"] } },
  { name: "D4- 事实属于上一轮 → 不算", build: () => { const d = doc([fact("aroll", SHA.aroll, { round: 1 })], []); d.round = 2; d.decisions.push(decision("script_approval", { round: 2, body_hash: BH })); return { doc: d }; }, expect: { stage: "待录制", rule: "D5" } },
  // D5
  { name: "D5+ 认过稿、什么都没有 → 待录制缺 A-roll", build: () => ({ doc: doc([], []) }), expect: { stage: "待录制", rule: "D5", missing: ["A-roll"], badges: [] } },
  // §16 附加
  { name: "§16 所批成片被外部覆盖（sha 被替换）→ 成片批准失效", build: () => ({ doc: doc(fullFacts({ cut: { replaced_at: t(8) } }), [cutOk(), coverOk()]) }), expect: { stage: "剪辑中", rule: "D4" } },
  { name: "§16 登记记录与批准组合不一致（封面字不同）→ 不命中 D2", build: () => ({ doc: registered({ reg: { cover_text: "别的字" } }) }), expect: { stage: "剪辑中", rule: "D3" } },
];
