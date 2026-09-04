/**
 * 定向补证（P1 spec §4.2；上游 angle-stage v3 §7.9，创始人 2026-09-03：
 * 「证据不够为什么不让 agent 自己再去搜」）。
 *
 * 一个需求一条短循环：给定「这个主张还缺什么证据」，用现有的搜索代理（同 broker、同引文
 * 逐字校验、同注入定界）去找，只交回**逐字引文 + 来源**。两处复用同一个 researcher：
 *   1. 写之前：立意卡的 `evidenceNeeds` 逐条补证（`researchNeeds`），结果渲染成增补证据块；
 *   2. 写之中：写手的 `find_evidence` 工具——写手自己不看网页，只拿校验过的引文。
 * 两处的产出都进**同一本账本**（每稿一份），`find_evidence` 的次数也由账本的 budget 管。
 *
 * 三条与实验版不同的硬约束（codex #10/#11/#16）：
 * - 配额字段名走类型检查的 `Partial<BrokerQuotas>`（实验里写成 `search/readPage`，静默失效跑的是默认值）；
 * - 每条需求独立 `AbortController` + 3 分钟墙钟，阶段总墙钟 6 分钟；超时**冻结**该 lookup：
 *   `RunState.abandoned` 让工具立刻停手不再偷配额，晚到的 submit 一律丢弃；
 * - 渲染经 `externalBlock` + `sanitizeExternal`，URL 只显示域名（原始 URL 留在账本里）。
 */
import { runLoop, type LoopResult, type LoopTool } from "../../engine/loop.js";
import { resolveEngineRoute, type EngineConfig } from "../../engine/config.js";
import {
  createResearchBroker,
  type BrokerQuotas,
  type ResearchBroker,
  type ResearchBrokerDeps,
} from "./research-broker.js";
import { buildReadPageTool, buildSearchTool, type RunState } from "./research-tools.js";
import {
  INJECTION_NOTICE,
  clampChars,
  externalBlock,
  sanitizeExternal,
  sanitizeUrlish,
  str,
  strList,
} from "./research-prompt-kit.js";
import type { EvidenceLedger, LedgerEntry, LookupRecord } from "./evidence-ledger.js";

// ─── 常量 ────────────────────────────────────────────────────────────────────

const MAX_TURNS = 8;
const MAX_TOTAL_TOKENS = 15_000;
const MAX_ITEMS = 4;
const MAX_REPAIRS = 2;

/** 每条需求的墙钟；补证阶段总墙钟（spec §4.2） */
export const DEFAULT_PER_NEED_DEADLINE_MS = 3 * 60_000;
export const DEFAULT_TOTAL_DEADLINE_MS = 6 * 60_000;

/**
 * 补证配额：比四视角宽（一次写稿可能补 3 条需求 + 写手若干次查证），
 * 但仍然是硬闸——测试断言 `broker.usage()` 不越过这四个数。
 */
export const TARGETED_QUOTAS: Partial<BrokerQuotas> = {
  searchPerPerspective: 5,
  readPagePerPerspective: 8,
  searchPerJob: 40,
  readPagePerJob: 60,
};

/** 渲染上限：条目级防单条刷屏，块级守住 §4.3 的优先级 1 槽位 */
const MAX_CLAIM_CHARS = 120;
const MAX_QUOTE_CHARS = 200;
const MAX_NEED_CHARS = 120;
const MAX_GAP_CHARS = 200;
const MAX_DOMAIN_CHARS = 80;
const MAX_BLOCK_CHARS = 3000;

const FROZEN_MSG = "Error: 本次补证已超时结束，停止检索，不要再调用任何工具。";
const NO_EVIDENCE_HINT = "没找到——正文不要编，绕开或如实说没有数据";

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface TargetedLookup extends LookupRecord {
  /** 本次登记进账本的条目（与 `itemIds` 同序） */
  items: LedgerEntry[];
}

export interface TargetedResearcher {
  find(need: string, opts?: { signal?: AbortSignal }): Promise<TargetedLookup>;
  broker: ResearchBroker;
  /** 与写手/修订共享的同一本账本（`find_evidence` 的次数闸也在它上面） */
  ledger: EvidenceLedger;
}

export interface TargetedResearcherOptions {
  dataDir: string;
  config: EngineConfig;
  ledger: EvidenceLedger;
  runLoopImpl?: typeof runLoop;
  /** 单条需求墙钟，默认 3 分钟 */
  perNeedDeadlineMs?: number;
  quotas?: Partial<BrokerQuotas>;
  /** 测试注入假 search/fetch，或生产挂 onActivity；配额与 dataDir 不从这里读 */
  brokerDeps?: Omit<ResearchBrokerDeps, "quotas" | "dataDir">;
}

// ─── 提示词 ──────────────────────────────────────────────────────────────────

function systemPrompt(): string {
  return [
    INJECTION_NOTICE,
    "",
    "你是内容团队的补证调研员。本轮只做一件事：为下面这一条「证据需求」找到可核验的原文证据。",
    "要的是：数字、时间点、具体案例、当事人原话。每条证据都要能指到具体页面。",
    "",
    "检索纪律：search 拿候选（s 开头的来源 id），read_page 打开页面（p 开头）。证据只能引用 p 开头的来源。",
    "quote 必须从 read_page 显示的正文里**逐字复制** 15~60 字，一个字都不改——代码会逐条回原页校验。",
    "配额有限，工具会说还能不能用；用尽就用手上的材料收束。",
    "",
    `产出：调用 submit_evidence 一次交齐，items 0-${MAX_ITEMS} 条；找不到就 items 为空、把原因写进 gaps。`,
    "宁可空着，不要凑数。除工具调用外不要输出分析文字。",
  ].join("\n");
}

function submitSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["items", "gaps"],
    properties: {
      items: {
        type: "array",
        maxItems: MAX_ITEMS,
        items: {
          type: "object",
          required: ["claim", "source_id", "quote"],
          properties: {
            claim: { type: "string", description: "这条证据支撑什么（一句话，你的话）" },
            source_id: { type: "string", description: "p 开头的来源 id" },
            quote: { type: "string", description: "从该页正文逐字复制的 15~60 字" },
          },
        },
      },
      gaps: { type: "array", items: { type: "string" } },
    },
  };
}

// ─── 提交工具 ────────────────────────────────────────────────────────────────

/** 待登记条目：id 在提交时就定好（`ev-T<n>.<i>`），但**冻结后不入账本** */
type PendingItem = Omit<LedgerEntry, "id"> & { id: string };
interface Capture {
  payload: { items: PendingItem[]; gaps: string[] } | null;
  attempts: number;
}

/**
 * 校验一条提交项。引文是真的但页记错了，用 `locateQuote` 纠正归属而不是打回
 * （2026-08-23 生产复盘：视角失败的主因是记错页，不是编）。
 */
function checkItem(
  broker: ResearchBroker,
  raw: Record<string, unknown>,
  index: number,
): { ok: true; sourceId: string; quote: string; claim: string } | { ok: false; problem: string } {
  const quote = str(raw.quote);
  if (quote.length < 8) return { ok: false, problem: `items[${index}]：引文太短` };
  let sourceId = str(raw.source_id);
  if (!broker.validateQuote(sourceId, quote).ok) {
    const located = broker.locateQuote(quote);
    if (!located) {
      return {
        ok: false,
        problem: `items[${index}]（${sourceId || "无来源 id"}）：引文在正文里找不到——从 read_page 显示的正文逐字复制`,
      };
    }
    sourceId = located;
  }
  return { ok: true, sourceId, quote, claim: str(raw.claim) || quote };
}

function buildSubmitTool(args: {
  broker: ResearchBroker;
  need: string;
  seq: number;
  capture: Capture;
  frozen: () => boolean;
}): LoopTool {
  let repairs = 0;
  return {
    name: "submit_evidence",
    description: "提交找到的证据（可为空）与缺口。引文会逐条回原页校验，不过会被打回。",
    parameters: submitSchema(),
    execute(toolArgs) {
      if (args.frozen()) return FROZEN_MSG;
      args.capture.attempts += 1;
      const raw = Array.isArray(toolArgs.items) ? (toolArgs.items as Record<string, unknown>[]) : [];
      const items: PendingItem[] = [];
      const problems: string[] = [];
      raw.slice(0, MAX_ITEMS).forEach((it, i) => {
        const checked = checkItem(args.broker, it ?? {}, i);
        if (!checked.ok) {
          problems.push(checked.problem);
          return;
        }
        const src = args.broker.getSource(checked.sourceId);
        items.push({
          id: `ev-T${args.seq}.${items.length + 1}`,
          source: "verified_quote",
          need: args.need,
          claim: checked.claim,
          quote: checked.quote,
          sourceId: checked.sourceId,
          sourceUrl: src?.finalUrl ?? src?.url ?? "",
        });
      });
      if (problems.length) {
        if (repairs >= MAX_REPAIRS) {
          return `Error: 校验仍未通过，修复轮已用尽（${MAX_REPAIRS} 轮），本次提交作废。`;
        }
        repairs += 1;
        return ["Error: 输出契约校验未通过：", ...problems.map((p) => `- ${p}`), "逐项修复后重新调用 submit_evidence。"].join("\n");
      }
      args.capture.payload = { items, gaps: strList(toolArgs.gaps) };
      return "已收到证据，本次补证结束，不要再调用任何工具。";
    },
  };
}

// ─── researcher ──────────────────────────────────────────────────────────────

const TIMEOUT = Symbol("timeout");
type LoopOutcome = { ok: true; result: LoopResult } | { ok: false; error: unknown };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function record(
  need: string,
  startedAt: string,
  patch: Partial<LookupRecord> & { status: LookupRecord["status"] },
): TargetedLookup {
  return {
    need,
    status: patch.status,
    itemIds: patch.itemIds ?? [],
    gaps: patch.gaps ?? [],
    tokens: patch.tokens ?? 0,
    turns: patch.turns ?? 0,
    startedAt,
    endedAt: new Date().toISOString(),
    items: [],
  };
}

export function createTargetedResearcher(opts: TargetedResearcherOptions): TargetedResearcher {
  const broker = createResearchBroker({
    ...(opts.brokerDeps ?? {}),
    dataDir: opts.dataDir,
    quotas: { ...TARGETED_QUOTAS, ...(opts.quotas ?? {}) },
  });
  const runLoopImpl = opts.runLoopImpl ?? runLoop;
  const deadlineMs = opts.perNeedDeadlineMs ?? DEFAULT_PER_NEED_DEADLINE_MS;
  const route = resolveEngineRoute(opts.config, "scout", opts.config.strongModel);
  let seq = 0;

  /** 落账：只在**未冻结**的正常收尾路径调用，晚到的提交到不了这里 */
  function commit(lookup: TargetedLookup, pending: PendingItem[]): TargetedLookup {
    const items = pending.map((p) => opts.ledger.add(p));
    const out = { ...lookup, items, itemIds: items.map((i) => i.id) };
    opts.ledger.recordLookup(out);
    return out;
  }

  function fail(lookup: TargetedLookup): TargetedLookup {
    opts.ledger.recordLookup(lookup);
    return lookup;
  }

  /** 一条需求 = 一次短循环：同 broker、同工具带、同 `abandoned` 弃标记 */
  function startLoop(args: {
    need: string;
    seq: number;
    state: RunState;
    capture: Capture;
    frozen: () => boolean;
    signal: AbortSignal;
  }): Promise<LoopResult> {
    const pb = broker.forPerspective(`targeted-${args.seq}`);
    return runLoopImpl(route.config, {
      model: route.model,
      systemPrompt: systemPrompt(),
      userMessage: `证据需求：${args.need}`,
      tools: [
        buildSearchTool(pb, args.state),
        buildReadPageTool(pb, args.state),
        buildSubmitTool({ broker, need: args.need, seq: args.seq, capture: args.capture, frozen: args.frozen }),
      ],
      maxTurns: MAX_TURNS,
      maxTotalTokens: MAX_TOTAL_TOKENS,
      signal: args.signal,
      logMeta: { agent: "targeted" },
    });
  }

  async function find(need: string, findOpts: { signal?: AbortSignal } = {}): Promise<TargetedLookup> {
    const trimmed = str(need);
    const startedAt = new Date().toISOString();
    if (!trimmed) return fail(record("", startedAt, { status: "failed", gaps: ["证据需求为空"] }));
    if (findOpts.signal?.aborted) {
      return fail(record(trimmed, startedAt, { status: "timeout", gaps: ["补证阶段已超时，本条未开始"] }));
    }

    const n = ++seq;
    const state: RunState = { abandoned: false };
    const capture: Capture = { payload: null, attempts: 0 };
    const ctl = new AbortController();
    let frozen = false;
    const raced = await runWithDeadline({
      deadlineMs,
      external: findOpts.signal,
      ctl,
      onTimeout: () => {
        frozen = true;
        state.abandoned = true;
      },
      work: () => startLoop({ need: trimmed, seq: n, state, capture, frozen: () => frozen, signal: ctl.signal }),
    });

    if (raced === TIMEOUT) {
      return fail(
        record(trimmed, startedAt, {
          status: "timeout",
          gaps: [`补证超时（${Math.round(deadlineMs / 1000)} 秒），本条结果作废`],
        }),
      );
    }
    state.abandoned = true; // 循环已结束：即便有残留调用也不许再花配额
    if (!raced.ok) {
      return fail(record(trimmed, startedAt, { status: "failed", gaps: [`补证失败：${errText(raced.error)}`] }));
    }
    const { totalTokens: tokens, turns } = raced.result;
    if (!capture.payload) {
      const why = capture.attempts === 0 ? "调研员没有调用 submit_evidence" : "提交未通过校验，修复轮已用尽";
      return fail(record(trimmed, startedAt, { status: "failed", gaps: [why], tokens, turns }));
    }
    const { items, gaps } = capture.payload;
    return commit(
      record(trimmed, startedAt, { status: items.length ? "found" : "empty", gaps, tokens, turns }),
      items,
    );
  }

  return { find, broker, ledger: opts.ledger };
}

/**
 * 墙钟竞速。取舍与视角子运行同款：runLoop 不可强杀，到点只能**丢弃结果**——
 * 但 `signal` 会传到引擎（中止不是失败，正常返回），`abandoned` 让工具立刻停手，
 * 两者合起来才让超时的那条不再偷配额。
 */
async function runWithDeadline(args: {
  deadlineMs: number;
  external?: AbortSignal;
  ctl: AbortController;
  onTimeout: () => void;
  work: () => Promise<LoopResult>;
}): Promise<LoopOutcome | typeof TIMEOUT> {
  const onExternalAbort = () => args.ctl.abort();
  args.external?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => args.ctl.abort(), args.deadlineMs);
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    args.ctl.signal.addEventListener(
      "abort",
      () => {
        args.onTimeout();
        resolve(TIMEOUT);
      },
      { once: true },
    );
  });
  // work 永不 reject：race 之后不会有掉在地上的 rejection
  const work = args
    .work()
    .then((result) => ({ ok: true as const, result }), (error) => ({ ok: false as const, error }));
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    args.external?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * 立意卡的 `evidenceNeeds` 逐条补证：**并行**跑，各自一个 AbortController，
 * 结果按需求序归并；阶段总墙钟到点，未完成的那几条一起冻结（status `timeout`）。
 */
export async function researchNeeds(
  researcher: TargetedResearcher,
  needs: string[],
  opts: { totalDeadlineMs?: number } = {},
): Promise<LookupRecord[]> {
  const list = needs.map((n) => str(n)).filter(Boolean);
  if (list.length === 0) return [];
  const controllers = list.map(() => new AbortController());
  const timer = setTimeout(
    () => controllers.forEach((c) => c.abort()),
    opts.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS,
  );
  try {
    const results = await Promise.all(
      list.map((need, i) => researcher.find(need, { signal: controllers[i]!.signal })),
    );
    return results.map(({ items: _items, ...rest }) => rest);
  } finally {
    clearTimeout(timer);
  }
}

// ─── 渲染 ────────────────────────────────────────────────────────────────────

/** URL 只进域名：原始 URL 留在账本里，进 prompt 的是模型不能点也不能转述的最短形态 */
function domainOf(url: string): string {
  const raw = str(url);
  if (!raw) return "来源未记录";
  try {
    return sanitizeUrlish(new URL(raw).host || raw, MAX_DOMAIN_CHARS);
  } catch {
    return sanitizeUrlish(raw.replace(/^https?:\/\//i, "").split("/")[0] ?? raw, MAX_DOMAIN_CHARS);
  }
}

function renderItem(entry: LedgerEntry): string {
  const claim = sanitizeExternal(entry.claim ?? "", MAX_CLAIM_CHARS);
  const quote = sanitizeExternal(entry.quote, MAX_QUOTE_CHARS);
  return `- ${entry.id}【${claim}】「${quote}」——${domainOf(entry.sourceUrl ?? "")}`;
}

/**
 * 渲染成写手可读的增补证据块。**没找到也要写出来**——空着的需求最容易被编，
 * 明说「没找到」比不提它安全。
 */
export function renderTargetedEvidence(ledger: EvidenceLedger): string {
  const lookups = ledger.lookups();
  if (lookups.length === 0) return "";
  const byId = new Map(ledger.entries().map((e) => [e.id, e]));
  const body: string[] = ["为本稿主张专门补的证据（逐字引文，已回原页校验；引用时带 id）："];
  for (const lookup of lookups) {
    body.push(`## 需求：${sanitizeExternal(lookup.need, MAX_NEED_CHARS)}`);
    const items = lookup.itemIds.map((id) => byId.get(id)).filter((e): e is LedgerEntry => !!e);
    if (items.length === 0) {
      const why = lookup.gaps.map((g) => sanitizeExternal(g, MAX_GAP_CHARS)).join("；") || "无说明";
      body.push(`- （${why}）——${NO_EVIDENCE_HINT}`);
      continue;
    }
    for (const item of items) body.push(renderItem(item));
  }
  return externalBlock([clampChars(body.join("\n"), MAX_BLOCK_CHARS)]);
}

/**
 * 写手的查证工具：写到一半缺证据就用它去找。不给它网页，只给校验过的引文；
 * 次数走账本的共享 budget——写手用掉的，修订轮就没有了（spec §3.3）。
 */
export function buildFindEvidenceTool(researcher: TargetedResearcher): LoopTool {
  const max = researcher.ledger.budget.max;
  return {
    name: "find_evidence",
    description: `写稿时缺一个数字/案例/原话就用它去找（整稿最多 ${max} 次，写手与修订共享）。返回逐字引文和来源 id；找不到会明说，那就不要写这个数字。`,
    parameters: {
      type: "object",
      properties: {
        need: {
          type: "string",
          description: "你缺什么证据，一句话说清（例：一个企业因 AI 幻觉造成损失的真实案例及金额）",
        },
      },
      required: ["need"],
    },
    async execute(args) {
      const need = str(args.need);
      if (!need) return "Error: need 不能为空";
      if (!researcher.ledger.budget.take()) {
        return `Error: find_evidence 已用完 ${max} 次（写手与修订共享这一份额度）。用手上的材料收束：没有证据的数字删掉或改成定性说法，不要编。`;
      }
      const lookup = await researcher.find(need);
      if (lookup.items.length === 0) {
        const why = lookup.gaps.map((g) => sanitizeExternal(g, MAX_GAP_CHARS)).join("；") || "无说明";
        return `没找到能核验的证据（${why}）。不要编这个数字，绕开或如实说没有数据。`;
      }
      return externalBlock(lookup.items.map(renderItem));
    },
  };
}
