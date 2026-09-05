/**
 * 定向补证（angle-stage spec v3 §7.9，创始人 2026-09-03：「证据不够为什么不让 agent 自己再去搜」）。
 *
 * 一个需求一条短循环：给定「这个主张还缺什么证据」，用现有的搜索代理（同配额、同引文逐字
 * 校验、同注入定界）去找，只交回**逐字引文 + 来源**。两处复用同一个函数：
 *   1. 写之前：立意卡的 evidenceNeeds 逐条补证，结果作为增补证据块给写手；
 *   2. 写之中：写手的 find_evidence 工具——写手自己不看网页，只拿到校验过的引文。
 *
 * 引文校验沿用 broker.validateQuote；引文是真的但页记错了，用 locateQuote 纠正归属而不是打回
 * （2026-08-23 生产复盘：视角失败的主因是记错页，不是编）。
 */
import type { runLoop as RunLoop, LoopTool } from "../../../src/engine/loop.js";
import type { EngineConfig } from "../../../src/engine/config.js";
import { createResearchBroker, type ResearchBroker } from "../../../src/modules/research/research-broker.js";
import { buildReadPageTool, buildSearchTool, type RunState } from "../../../src/modules/research/research-tools.js";
import { INJECTION_NOTICE, str } from "../../../src/modules/research/research-prompt-kit.js";

export interface EvidenceItem {
  /** ev-T1、ev-T2… 与简报的 ev-N 区分 */
  id: string;
  need: string;
  claim: string;
  quote: string;
  sourceId: string;
  sourceUrl: string;
}

export interface TargetedLookup {
  need: string;
  items: EvidenceItem[];
  /** 找不到也要说：模型交回的 gaps，或失败原因 */
  gaps: string[];
  tokens: number;
  turns: number;
  status: "found" | "empty" | "failed";
}

export interface TargetedResearcher {
  find(need: string): Promise<TargetedLookup>;
  lookups(): TargetedLookup[];
  broker: ResearchBroker;
}

const MAX_TURNS = 8;
const MAX_TOKENS = 15_000;
const MAX_ITEMS = 4;

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

export function createTargetedResearcher(opts: {
  config: EngineConfig;
  model: string;
  dataDir: string;
  runLoopImpl: typeof RunLoop;
}): TargetedResearcher {
  // 配额比四视角宽：一次写稿可能补 3 条需求 + 写手若干次查证
  const broker = createResearchBroker({
    dataDir: opts.dataDir,
    quotas: { search: 5, readPage: 8, jobSearch: 40, jobReadPage: 60 } as never,
  });
  const done: TargetedLookup[] = [];
  let seq = 0;

  async function find(need: string): Promise<TargetedLookup> {
    const n = ++seq;
    const pb = broker.forPerspective(`targeted-${n}`);
    const state: RunState = { abandoned: false };
    let captured: { items: EvidenceItem[]; gaps: string[] } | null = null;
    let repairs = 0;

    const submit: LoopTool = {
      name: "submit_evidence",
      description: "提交找到的证据（可为空）与缺口。引文会逐条回原页校验，不过会被打回。",
      parameters: submitSchema(),
      execute: (args) => {
        const raw = Array.isArray(args.items) ? (args.items as Array<Record<string, unknown>>) : [];
        const gaps = Array.isArray(args.gaps) ? (args.gaps as unknown[]).map((g) => str(g)).filter(Boolean) : [];
        const items: EvidenceItem[] = [];
        const errs: string[] = [];
        raw.slice(0, MAX_ITEMS).forEach((it, i) => {
          const quote = str(it.quote).trim();
          let sourceId = str(it.source_id).trim();
          if (quote.length < 8) {
            errs.push(`items[${i}]：引文太短`);
            return;
          }
          const check = broker.validateQuote(sourceId, quote);
          if (!check.ok) {
            const located = broker.locateQuote(quote);
            if (!located) {
              errs.push(`items[${i}]（${sourceId}）：引文在正文里找不到——从 read_page 显示的正文逐字复制`);
              return;
            }
            sourceId = located; // 引文是真的，页记错了：纠正归属
          }
          const src = broker.getSource(sourceId);
          items.push({
            id: `ev-T${n}.${items.length + 1}`,
            need,
            claim: str(it.claim).trim() || quote,
            quote,
            sourceId,
            sourceUrl: src?.finalUrl ?? src?.url ?? "",
          });
        });
        if (errs.length) {
          repairs++;
          if (repairs > 2) return "Error: 校验仍未通过，修复轮已用尽。\n- " + errs.join("\n- ");
          return "Error: 输出契约校验未通过：\n- " + errs.join("\n- ") + "\n逐项修复后重新调用 submit_evidence。";
        }
        captured = { items, gaps };
        return "已收到证据。";
      },
    };

    let tokens = 0;
    let turns = 0;
    try {
      const result = await opts.runLoopImpl(opts.config, {
        model: opts.model,
        systemPrompt: systemPrompt(),
        userMessage: `证据需求：${need}`,
        tools: [buildSearchTool(pb, state), buildReadPageTool(pb, state), submit],
        maxTurns: MAX_TURNS,
        maxTotalTokens: MAX_TOKENS,
        logMeta: { runId: `p0c-targeted-${Date.now()}-${n}`, agent: "targeted" },
      });
      tokens = result.totalTokens;
      turns = result.turns;
    } catch (err) {
      const lookup: TargetedLookup = { need, items: [], gaps: [`补证失败：${err instanceof Error ? err.message : String(err)}`], tokens, turns, status: "failed" };
      done.push(lookup);
      return lookup;
    }
    state.abandoned = true;
    const cap = captured as { items: EvidenceItem[]; gaps: string[] } | null;
    const lookup: TargetedLookup = cap
      ? { need, items: cap.items, gaps: cap.gaps, tokens, turns, status: cap.items.length ? "found" : "empty" }
      : { need, items: [], gaps: ["调研员没有调用 submit_evidence"], tokens, turns, status: "failed" };
    done.push(lookup);
    return lookup;
  }

  return { find, lookups: () => done, broker };
}

/** 渲染成写手可读的增补证据块 */
export function renderTargetedEvidence(lookups: TargetedLookup[]): string {
  const lines: string[] = ["<<<TARGETED_EVIDENCE>>>", "为本稿主张专门补的证据（逐字引文，已回原页校验；引用时带 id）："];
  for (const l of lookups) {
    lines.push(`## 需求：${l.need}`);
    if (l.items.length === 0) lines.push(`- （没找到：${l.gaps.join("；") || "无说明"}）——这个需求没有证据，正文里不要编，绕开或如实说没有数据`);
    for (const it of l.items) lines.push(`- ${it.id}【${it.claim}】「${it.quote}」——${it.sourceUrl}`);
  }
  lines.push("<<<END_TARGETED_EVIDENCE>>>");
  return lines.join("\n");
}

/** 写手的查证工具：写到一半缺证据时用，不给它网页，只给校验过的引文 */
export function buildFindEvidenceTool(researcher: TargetedResearcher, maxCalls = 3): LoopTool {
  let calls = 0;
  return {
    name: "find_evidence",
    description: `写稿时缺一个数字/案例/原话就用它去找（最多 ${maxCalls} 次）。返回逐字引文和来源 id；找不到会明说，那就不要写这个数字。`,
    parameters: {
      type: "object",
      properties: { need: { type: "string", description: "你缺什么证据，一句话说清（例：一个企业因 AI 幻觉造成损失的真实案例及金额）" } },
      required: ["need"],
    },
    async execute(args) {
      if (calls >= maxCalls) return `Error: find_evidence 已用完 ${maxCalls} 次，用手上的材料收束；没有证据的数字删掉或标「[未证实]」。`;
      calls++;
      const need = str(args.need).trim();
      if (!need) return "Error: need 不能为空";
      const l = await researcher.find(need);
      if (l.items.length === 0) return `没找到能核验的证据（${l.gaps.join("；") || "无说明"}）。不要编这个数字，绕开或如实说没有数据。`;
      return l.items.map((it) => `${it.id}【${it.claim}】「${it.quote}」——${it.sourceUrl}`).join("\n");
    },
  };
}
