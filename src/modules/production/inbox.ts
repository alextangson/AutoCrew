/**
 * 「等你拍板」列表（spec 2026-09-30-review-inbox §3）：每条稿的制作记录、稿件状态、检查、请示 → 条目。纯函数，零 I/O。
 *
 * - 条目 = 一件事：稳定的 `item_id`（同一件事刷新不变）+ 审阅代次 `gen`（它所展示的对象快照的指纹）。
 * - 已消费的代次不再出条目（R22：打回消费当时快照，agent 交了新版本或重新标「可以审了」才开新代次）。
 * - 排序（§3.2）：有 agent 在等的（按等待时长）→ 挡住推进的 → 发布相关 → 稿子 → 其他。
 * - 「正在核对」的原片不是条目（Codex 20）。稿重开 / 归档 / 删除 → 该稿条目全消（读方按轮次与状态推）。
 */
import crypto from "node:crypto";
import path from "node:path";
import type { Content } from "../../storage/local-store.js";
import { bodyHash } from "../../storage/production-store.js";
import type { Ask, Fact, InboxConsumption, ProductionDoc } from "../../storage/production-types.js";
import { platformLabel } from "../../desktop/platform-label.js";
import { askStatus, REPORTED_UNDO_MS } from "./asks.js";
import { validCoverGroups, type GroupView } from "./cover-groups.js";
import { publishReceipts, validCoverApproval, validCutApproval } from "./derive.js";
import type { Explanation } from "./explain.js";
import { hostLabel } from "./host-label.js";
import { markedCuts } from "./ready.js";
import { sliverKey, sliverVerdict, sliverWaived } from "./sliver/verdict.js";

export type InboxType =
  | "ask" | "ask_reported" | "cut_review" | "cover_pick" | "candidate" | "auto_attached" | "attach_check" | "inbox_file" | "sliver"
  | "register_blocked" | "publish_check" | "published_ask" | "publish_claim" | "draft" | "other";

/** 按钮：主（黑底，每件最多一个）/ 次（白底细边）/ 少用（灰字）；带 note 的动作就地展开输入框 */
export interface InboxAction {
  action: string;
  label: string;
  role: "primary" | "secondary" | "quiet";
  /** 这个动作固定要带的参数（选项 id、哪一版、哪一组…） */
  params?: Record<string, unknown>;
  note?: "optional" | "required";
  /** 输入框里的真实例子 */
  placeholder?: string;
}

export interface InboxItem {
  item_id: string;
  gen: string;
  type: InboxType;
  content_id: string | null;
  /** 稿名 */
  title: string;
  /** 一句话要做什么 */
  summary: string;
  /** 谁在等：真实 agent 名；没人在等 = null */
  waiting: { host: string; label: string } | null;
  /** 有 agent 在等（行首小蓝点） */
  agent_waiting: boolean;
  /** 从什么时候开始（「多久以前」按它算） */
  since: string;
  /** 排序档：0 有 agent 在等 / 1 挡住推进 / 2 发布相关 / 3 稿子 / 4 其他 */
  rank: 0 | 1 | 2 | 3 | 4;
  actions: InboxAction[];
  /** 条件不够时按钮位置直接写的原因（「还差 4:3，Claude 在做」） */
  blocked_reason?: string;
  /** 这件事要的东西（类型各异；只放处理这件事要的） */
  detail: Record<string, unknown>;
}

export const genOf = (snapshot: unknown): string => crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16);

// ---- 每条稿的输入（I/O 在 inbox-read 里收集） ----

/** input：按留档输入重算的现在的指纹，same = 计划与文件没改过 */
export interface CheckView { check_id: string; platform: string; verdict: string; checked_at: string; items: unknown[]; input?: { same: boolean; fp: string } }

export interface ContentInput {
  content: Content;
  /** 按本体走的视频稿才有（迁移后的样子） */
  doc: ProductionDoc | null;
  exp: Explanation | null;
  /** 请示附件在答之前变了 */
  askAttachmentsChanged: Record<string, boolean>;
  /** 每个平台当前有效的发布检查（同平台只留最新一组，其余已被取代） */
  checks: CheckView[];
  /** 计划发的平台（发布计划里的平台；没有计划就是稿件平台） */
  planned: string[];
  /** CAS 消费记录（非本体稿也可能有：发布检查、认稿） */
  log: InboxConsumption[];
}

type Draft = Omit<InboxItem, "gen" | "content_id" | "title"> & { snapshot: unknown };

const kindName: Record<string, string> = { aroll: "原片", cut: "成片", srt: "字幕", cover: "封面" };
const who = (host?: string) => (host ? { host, label: hostLabel(host) } : null);
const NOTE_CUT = "比如：开头有点拖，前 10 秒再紧一点";

// ---- 请示 ----

function askItems(doc: ProductionDoc, content: Content, changed: Record<string, boolean>, now: number): Draft[] {
  const out: Draft[] = [];
  for (const a of doc.asks ?? []) {
    const s = askStatus(a, doc, content);
    if (s.status === "open") out.push(openAsk(a, changed[a.id] === true));
    else if (a.state === "answered" && a.answer?.via === "agent_reported" && a.round === doc.round && now - Date.parse(a.answer.at) <= REPORTED_UNDO_MS) out.push(reportedAsk(a));
  }
  return out;
}

function openAsk(a: Ask, attachmentsChanged: boolean): Draft {
  const label = hostLabel(a.by?.host);
  return {
    item_id: `ask:${a.id}`, type: "ask", summary: `${label}想问你：${a.question}`, waiting: who(a.by?.host), agent_waiting: true, since: a.at, rank: 0,
    actions: a.options.map((o) => ({ action: "answer_ask", label: o.label, role: "secondary" as const, params: { ask_id: a.id, option_id: o.id }, note: "optional" as const, placeholder: "比如：就这样，但配乐再轻一点" })),
    ...(attachmentsChanged ? { blocked_reason: "附件刚变过，重新看一下再答" } : {}),
    detail: { ask_id: a.id, kind: a.kind, question: a.question, options: a.options, attachments: a.attachments.map((x, i) => ({ index: i, name: path.basename(x.path), path: x.path, html: /\.html?$/i.test(x.path) })),
      attachments_changed: attachmentsChanged, ...(a.storyboard ? { storyboard_fact_id: a.storyboard.fact_id } : {}), reported_allowed: a.kind !== "花费" && a.kind !== "分镜" },
    snapshot: [a.id, a.state, a.options, a.attachments, attachmentsChanged, a.storyboard ?? null],
  };
}

function reportedAsk(a: Ask): Draft {
  const label = hostLabel(a.answer!.host ?? a.by?.host);
  const option = a.options.find((o) => o.id === a.answer!.option_id)?.label ?? a.answer!.option_id;
  return {
    item_id: `ask:${a.id}`, type: "ask_reported", summary: `${label}转述你说的『${a.answer!.quote ?? ""}』，不对点撤回`, waiting: null, agent_waiting: false, since: a.answer!.at, rank: 1,
    actions: [{ action: "ack", label: "对", role: "secondary" }, { action: "undo_ask_answer", label: "撤回", role: "quiet", params: { ask_id: a.id } }],
    detail: { ask_id: a.id, kind: a.kind, question: a.question, option: option, quote: a.answer!.quote ?? "", until: new Date(Date.parse(a.answer!.at) + REPORTED_UNDO_MS).toISOString() },
    snapshot: [a.id, "reported", a.answer!.at, a.answer!.option_id],
  };
}

// ---- 成片 ----

function cutVersions(doc: ProductionDoc, approvedSha?: string) {
  const marked = new Map(markedCuts(doc).map((m) => [m.fact.id, m]));
  const cuts = doc.facts.filter((f) => f.round === doc.round && f.kind === "cut" && f.state === "accepted" && !f.replaced_at && f.sha256).sort((a, b) => b.at.localeCompare(a.at));
  return cuts.map((f, i) => ({
    fact_id: f.id, sha256: f.sha256!, path: f.path, at: f.at, label: i === 0 ? "最新一版" : i === 1 ? "上一版" : `往前第 ${i} 版`,
    ready: marked.has(f.id), approved: f.sha256 === approvedSha, host_label: hostLabel(f.by?.host),
    has_srt: doc.facts.some((s) => s.round === doc.round && s.kind === "srt" && s.state === "accepted" && s.for_cut === f.sha256),
  }));
}

function cutItem(doc: ProductionDoc, content: Content): Draft | null {
  const marked = markedCuts(doc);
  const review = marked.at(-1);
  if (!review) return null;
  const ok = validCutApproval(doc, content.body);
  const newer = ok && review.fact.sha256 !== ok.sha256 && review.marked_at > ok.at;
  if (ok && !newer) return null;
  const label = hostLabel(review.host ?? review.fact.by?.host);
  return {
    item_id: `cut:r${doc.round}`, type: "cut_review", summary: newer ? "新的一版剪好了，要不要换" : "成片剪好了，看一遍",
    waiting: who(review.host ?? review.fact.by?.host), agent_waiting: false, since: review.marked_at, rank: 1,
    actions: [
      { action: "approve_cut", label: "就用这版", role: "primary", params: { fact_id: review.fact.id, sha256: review.fact.sha256 } },
      { action: "reject_cut", label: "还要改…", role: "secondary", params: { fact_id: review.fact.id, sha256: review.fact.sha256 }, note: "required", placeholder: NOTE_CUT },
    ],
    detail: { versions: cutVersions(doc, ok?.sha256), review_fact_id: review.fact.id, approved_fact_id: ok ? doc.facts.find((f) => f.kind === "cut" && f.sha256 === ok.sha256)?.id ?? null : null, editor_label: label },
    snapshot: [doc.round, bodyHash(content.body), review.fact.id, review.fact.sha256, review.marked_at, ok?.id ?? null, marked.map((m) => m.fact.id)],
  };
}

// ---- 封面 ----

const groupView = (g: GroupView, i: number, approved: boolean) => ({
  group_id: g.group.id, label: i === 0 ? "最新一组" : i === 1 ? "上一组" : `往前第 ${i} 组`, at: g.at, text: g.text, approved, host_label: hostLabel(g.group.by?.host ?? g.slots["3:4"][0]?.by?.host),
  "3:4": g.slots["3:4"][0] ? { fact_id: g.slots["3:4"][0].id, sha256: g.slots["3:4"][0].sha256, path: g.slots["3:4"][0].path } : null,
  "4:3": g.slots["4:3"][0] ? { fact_id: g.slots["4:3"][0].id, sha256: g.slots["4:3"][0].sha256, path: g.slots["4:3"][0].path } : null,
});

function coverItem(doc: ProductionDoc, content: Content): Draft | null {
  const groups = validCoverGroups(doc);
  const complete = groups.filter((g) => g.complete).reverse();
  if (!complete.length) return null;
  const ok = validCoverApproval(doc, content.body);
  const isApproved = (g: GroupView) => Boolean(ok && g.slots["3:4"][0].sha256 === ok.cover_3x4_sha && g.slots["4:3"][0].sha256 === ok.cover_4x3_sha);
  const newer = ok ? complete.filter((g) => !isApproved(g) && g.at > ok.at) : [];
  if (ok && !newer.length) return null;
  const top = ok ? newer[0] : complete[0];
  const incomplete = groups.filter((g) => !g.complete).map((g) => ({ group_id: g.group.id, has: g.slots["3:4"].length ? "3:4" : "4:3",
    note: g.ambiguous ? "这组同一个比例不止一张" : `只有 ${g.slots["3:4"].length ? "3:4" : "4:3"}，还差 ${g.slots["3:4"].length ? "4:3" : "3:4"}，${hostLabel(g.group.by?.host)}在做` }));
  return {
    item_id: `cover:r${doc.round}`, type: "cover_pick", summary: ok ? "新的一组封面做好了，要不要换" : "封面做好了，挑一张", waiting: who(top.group.by?.host), agent_waiting: false, since: top.at, rank: 1,
    actions: [
      { action: "pick_cover", label: "用这组", role: "primary", params: { group_id: top.group.id, cover_text: top.text } },
      { action: "reject_cover", label: "还要改…", role: "secondary", note: "required", placeholder: "比如：字再大一点，换张笑的照片" },
      { action: "retire_cover_group", label: "这组不要了", role: "quiet", params: { group_id: top.group.id } },
    ],
    detail: { groups: complete.map((g, i) => groupView(g, i, isApproved(g))), incomplete },
    snapshot: [doc.round, bodyHash(content.body), complete.map((g) => [g.group.id, g.slots["3:4"][0].sha256, g.slots["4:3"][0].sha256, g.text]), ok?.id ?? null],
  };
}

// ---- 候选 / 自动挂上 / 挂载核对 ----

function candidateItems(doc: ProductionDoc): Draft[] {
  const out: Draft[] = [];
  for (const f of doc.facts.filter((x) => x.round === doc.round)) {
    if (f.state === "candidate") out.push(candidateItem(f));
    else if (f.kind === "aroll" && f.state === "accepted" && f.auto_attached && f.attach_check?.status !== "kept") out.push(autoItem(f));
    if (f.kind === "aroll" && f.state === "accepted" && f.attach_check?.status === "suggest" && f.attach_check.other_id) out.push(attachItem(f));
  }
  return out;
}

const factParams = (f: Fact) => ({ fact_id: f.id, sha256: f.sha256 });

function candidateItem(f: Fact): Draft {
  return {
    item_id: `cand:${f.id}`, type: "candidate", summary: `找到一段${kindName[f.kind] ?? "文件"}${f.post_publish ? "（发布之后的新导出）" : ""}，是这条的吗`, waiting: null, agent_waiting: false, since: f.at, rank: 1,
    actions: [{ action: "confirm_candidate", label: "对，就是它", role: "primary", params: factParams(f) }, { action: "reject_candidate", label: "不是", role: "secondary", params: factParams(f) }],
    detail: { fact_id: f.id, kind: f.kind, path: f.path, name: f.path ? path.basename(f.path) : null, evidence: f.evidence ?? "", ratio: f.ratio ?? null, source: f.source },
    snapshot: [f.id, f.sha256, f.state, f.path],
  };
}

function autoItem(f: Fact): Draft {
  return {
    item_id: `auto:${f.id}`, type: "auto_attached", summary: f.source === "reconcile" ? "从收件箱自动挂上了一段原片，对吗" : "核对后自动挂上了一段原片，对吗", waiting: null, agent_waiting: false, since: f.at, rank: 1,
    actions: [{ action: "ack", label: "对，就是它", role: "primary" }, { action: "undo_auto_attach", label: "不是", role: "secondary", params: factParams(f) }],
    detail: { fact_id: f.id, path: f.path, source_path: f.source_path ?? null, evidence: f.evidence ?? "" },
    snapshot: [f.id, f.sha256, "auto"],
  };
}

function attachItem(f: Fact): Draft {
  const c = f.attach_check!;
  return {
    item_id: `attach:${f.id}`, type: "attach_check", summary: `这段原片听起来更像《${c.other_title ?? ""}》`, waiting: null, agent_waiting: false, since: c.at, rank: 1,
    actions: [{ action: "keep_attach", label: "对，就是它", role: "primary", params: factParams(f) }, { action: "reassign_aroll", label: `改挂到《${c.other_title ?? ""}》`, role: "secondary", params: { ...factParams(f), to: c.other_id } }],
    detail: { fact_id: f.id, path: f.path, other_id: c.other_id, other_title: c.other_title ?? "", reason: c.reason ?? "" },
    snapshot: [f.id, f.sha256, c.job ?? c.at, c.other_id],
  };
}

// ---- 闪帧（针对所选成片：每一版标过可以审、还没通过的成片各算各的） ----

function sliverItems(doc: ProductionDoc, content: Content): Draft[] {
  const ok = validCutApproval(doc, content.body);
  const out: Draft[] = [];
  for (const { fact, marked_at } of markedCuts(doc)) {
    if (ok?.sha256 === fact.sha256) continue;
    const v = sliverVerdict(doc, fact.sha256!, null);
    const c = v.check;
    if (v.ok || !c || (c.status !== "slivers" && c.status !== "unchecked")) continue;
    const open = c.slivers.filter((s) => !sliverWaived(doc, fact.sha256!, c.fingerprint, s));
    out.push({
      item_id: `sliver:${fact.id}`, type: "sliver", summary: c.status === "slivers" ? `画面有闪帧（${open.length} 处）` : "画面闪帧检查没跑成", waiting: null, agent_waiting: false, since: c.checked_at, rank: 1,
      actions: [
        { action: "reject_cut", label: "去剪辑里改", role: "primary", params: factParams(fact), note: "optional", placeholder: "比如：这几处补一帧 B-roll" },
        ...(c.status === "unchecked" && v.wholeWaivable ? [{ action: "waive_sliver_check", label: "这条不查了", role: "quiet" as const, params: { cut_sha: fact.sha256 } }] : []),
      ],
      detail: { cut_fact_id: fact.id, cut_sha: fact.sha256, status: c.status, reason: c.reason ?? null, fingerprint: c.fingerprint,
        items: c.slivers.map((s) => ({ key: sliverKey(s), start_tc: s.start_tc, frames: s.frames, prev_name: s.prev_name ?? null, next_name: s.next_name ?? null, suggestion: s.suggestion ?? null, waived: sliverWaived(doc, fact.sha256!, c.fingerprint, s),
          action: { action: "waive_sliver", label: "这处是故意的", role: "secondary", params: { cut_sha: fact.sha256, fingerprint: c.fingerprint, sliver_key: sliverKey(s) } } })) },
      // 重新标「可以审了」= 重新交审，开新代次（Codex 审 2a-1 r4 P2）；检查结果身份也在里面
      snapshot: [fact.id, fact.sha256, marked_at, c.id, c.fingerprint, c.status, c.checked_at, open.map(sliverKey)],
    });
  }
  return out;
}

// ---- 还差一步（两项批准都有效但登记没成） ----

function registerItem(doc: ProductionDoc, content: Content, exp: Explanation): Draft | null {
  if (exp.rule !== "D3") return null;
  const cut = validCutApproval(doc, content.body), cover = validCoverApproval(doc, content.body);
  const why = exp.missing[0] ?? "登记还没完成";
  const host = doc.facts.find((f) => f.kind === "cut" && f.sha256 === cut?.sha256)?.by?.host;
  return {
    item_id: `register:r${doc.round}`, type: "register_blocked", summary: `还差一步才能发：${why}`, waiting: null, agent_waiting: false, since: [cut?.at, cover?.at].filter(Boolean).sort().at(-1) ?? content.updatedAt, rank: 1,
    actions: [{ action: "nudge", label: `让 ${hostLabel(host)} 补`, role: "primary" }],
    detail: { reason: why, who_label: hostLabel(host) },
    snapshot: [cut?.id, cover?.id, why],
  };
}

// ---- 发布相关 ----

function publishItems(doc: ProductionDoc | null, input: ContentInput): Draft[] {
  const out: Draft[] = [];
  const { content, exp } = input;
  const receipts = doc ? publishReceipts(doc) : { live: [], pending: [], rejected: [] };
  const live = new Set(receipts.live.map((s) => s.platform));
  for (const c of input.checks) {
    if (live.has(c.platform)) continue;
    const blocked = c.verdict === "block";
    out.push({
      item_id: `pubcheck:r${doc?.round ?? 1}:${c.platform}`, type: "publish_check", summary: `发之前再看一眼（${platformLabel(c.platform)}）`, waiting: null, agent_waiting: false, since: c.checked_at, rank: 2,
      actions: [
        { action: "publish_check_confirm", label: "没问题", role: "primary", params: { check_id: c.check_id } },
        { action: "publish_check_revise", label: "有几处要改…", role: "secondary", params: { check_id: c.check_id }, note: "required", placeholder: "比如：标题别用问号，话题加上 #AI工具" },
        ...(blocked ? [{ action: "publish_check_override", label: "这条我破例…", role: "quiet" as const, params: { check_id: c.check_id }, note: "required" as const, placeholder: "写你的原话，比如：这次封面字小一点没关系" }] : []),
      ],
      ...(c.input && !c.input.same ? { blocked_reason: "计划刚改过，按新计划重新检查后再看" } : {}),
      detail: { check_id: c.check_id, platform: c.platform, verdict: c.verdict, items: c.items, plan_changed: c.input ? !c.input.same : false },
      // 计划输入的指纹进代次：agent 改了计划文件，旧条目就失效（Codex 审 2a-1 r5 P1）
      snapshot: [c.check_id, c.verdict, c.input?.fp ?? null],
    });
  }
  if (!doc || !exp) return out;
  for (const s of receipts.pending) {
    out.push({
      item_id: `claim:r${doc.round}:${s.platform}`, type: "publish_claim", summary: `${s.source === "claim" ? hostLabel(s.host) : "数据回流"}说已经发了（${platformLabel(s.platform)}）`, waiting: null, agent_waiting: false, since: s.at, rank: 2,
      actions: [{ action: "confirm_receipt", label: "对，发了", role: "primary", params: { fact_id: s.fact_id } }, { action: "correct_publish", label: "没发", role: "secondary", params: { target_id: s.id } }],
      detail: { platform: s.platform, url: s.url ?? null, item: s.item_id ?? null, evidence: s.evidence },
      snapshot: [s.fact_id, s.pub_state],
    });
  }
  if (exp.stage !== "待发布" && exp.stage !== "已发布") return out;
  const known = new Set([...live, ...receipts.pending.map((s) => s.platform), ...receipts.rejected.map((s) => s.platform)]);
  for (const p of input.planned.filter((x) => !known.has(x))) {
    out.push({
      item_id: `published:r${doc.round}:${p}`, type: "published_ask", summary: `发了吗（${platformLabel(p)}）`, waiting: null, agent_waiting: false, since: content.updatedAt, rank: 2,
      actions: [{ action: "i_published", label: "已经发出去了", role: "primary", params: { platform: p }, note: "optional", placeholder: "作品链接（可不填）" }],
      detail: { platform: p },
      snapshot: [doc.round, p],
    });
  }
  return out;
}

function draftItem(content: Content): Draft | null {
  if (content.status !== "draft_ready") return null;
  return {
    item_id: `draft:${content.id}`, type: "draft", summary: "稿子写好了，过一眼", waiting: null, agent_waiting: false, since: content.updatedAt, rank: 3,
    actions: [{ action: "approve_script", label: "稿子没问题", role: "primary" }, { action: "revise_script", label: "还要改…", role: "secondary", note: "required", placeholder: "比如：开头换成客户问的那句话" }],
    detail: { platform: content.platform ?? null, words: Array.from((content.body ?? "").replace(/\s+/g, "")).length },
    // 退回修改后重交（同样的正文也算重交）开新代次
    snapshot: [bodyHash(content.body), content.title, content.updatedAt],
  };
}

// ---- 汇总 ----

/** 一条稿的全部条目（已消费的代次去掉） */
export function contentItems(input: ContentInput, now = Date.now()): InboxItem[] {
  const { content, doc, exp } = input;
  if (content.deletedAt || content.status === "archived") return [];
  const drafts: Draft[] = [];
  const d = draftItem(content);
  if (d) drafts.push(d);
  if (doc && exp?.phase === "production") {
    drafts.push(...askItems(doc, content, input.askAttachmentsChanged, now), ...candidateItems(doc), ...sliverItems(doc, content));
    for (const x of [cutItem(doc, content), coverItem(doc, content), registerItem(doc, content, exp)]) if (x) drafts.push(x);
  } else if (doc) {
    // 写稿段也可能有候选（认稿前发现的疑似原片）和请示
    drafts.push(...askItems(doc, content, input.askAttachmentsChanged, now), ...candidateItems(doc));
  }
  drafts.push(...publishItems(doc, input));
  const consumed = new Set(input.log.filter((e) => !e.pending || now - Date.parse(e.at) <= 10 * 60_000).map((c) => `${c.item_id}\u0000${c.gen}`));
  return drafts.map(({ snapshot, ...x }) => ({ ...x, gen: genOf([x.item_id, snapshot]), content_id: content.id, title: content.title }))
    .filter((x) => !consumed.has(`${x.item_id}\u0000${x.gen}`));
}

/** §3.2 排序：有 agent 在等的按等待时长（最久的在前）→ 挡住推进 → 发布相关 → 稿子 → 其他；同档按时间从早到晚 */
export function sortItems(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => a.rank - b.rank || a.since.localeCompare(b.since) || a.item_id.localeCompare(b.item_id));
}
