/**
 * 跑一个平台的 Jev A + B（带缓存）：全部成功才缓存；有一次没跑成 → 该部分标「语义把关没跑成：原因」，
 * 已拿到的答案照常判读，但整份不缓存，下次 check 重试（E3、E11）。
 */
import { JEV_MODEL, JEV_USD_PER_MTOK, JevError, type JevAnswer, type JevCaller } from "./jev-client.js";
import { once, readJevCache, writeJevCache, type CachedCall } from "./check-store.js";
import { interpret, type Instruction, type SemanticRequest } from "./semantic.js";
import type { Basis } from "./subtitles.js";
import type { CheckItem } from "./types.js";

export interface CallRecord {
  kind: "A" | "B";
  ok: boolean;
  reason?: string;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  cost_usd?: number;
  ms?: number;
  questions: Record<string, unknown>;
  answers?: Record<string, JevAnswer>;
}

export interface SemanticResult { items: CheckItem[]; calls: CallRecord[]; cached: boolean; failed: string[] }

export interface SemanticJob { contentId: string; dataDir?: string; fingerprint: string; requests: SemanticRequest[]; basis: Basis; instructions: Instruction[]; caller: JevCaller }

const cost = (tokens: number) => Math.round((tokens * JEV_USD_PER_MTOK / 1e6) * 1e8) / 1e8;

function fromCall(req: SemanticRequest, c: CachedCall): CallRecord {
  return { kind: req.kind, ok: true, model: c.model, usage: c.usage, cost_usd: cost(c.usage.input_tokens), ms: c.ms, questions: req.questions, answers: c.answers };
}

async function callAll(job: SemanticJob): Promise<{ calls: CallRecord[]; fresh: CachedCall[]; failed: string[] }> {
  const calls: CallRecord[] = [], fresh: CachedCall[] = [], failed: string[] = [];
  for (const req of job.requests) {
    try {
      const r = await job.caller(req.state, req.questions);
      const c: CachedCall = { kind: req.kind, model: r.model || JEV_MODEL, usage: r.usage, ms: r.ms, answers: r.answers };
      fresh.push(c);
      calls.push(fromCall(req, c));
    } catch (e) {
      const reason = e instanceof JevError ? e.reason : `调用出错：${e instanceof Error ? e.message : String(e)}`;
      failed.push(`${req.kind === "A" ? "语义把关（A）" : "执行对指令（B）"}没跑成：${reason}`);
      calls.push({ kind: req.kind, ok: false, reason, questions: req.questions });
    }
  }
  return { calls, fresh, failed };
}

async function runUncached(job: SemanticJob): Promise<SemanticResult> {
  const cached = await readJevCache(job.contentId, job.fingerprint, job.dataDir);
  if (cached && cached.calls.length === job.requests.length) {
    return { items: [], calls: job.requests.map((req, i) => fromCall(req, cached.calls[i])), cached: true, failed: [] };
  }
  const { calls, fresh, failed } = await callAll(job);
  if (!failed.length && fresh.length) await writeJevCache(job.contentId, { fingerprint: job.fingerprint, at: new Date().toISOString(), calls: fresh }, job.dataDir);
  return { items: [], calls, cached: false, failed };
}

export async function runSemantic(job: SemanticJob): Promise<SemanticResult> {
  if (!job.requests.length) return { items: [], calls: [], cached: false, failed: [] };
  const base = await once(`${job.contentId}:${job.fingerprint}`, () => runUncached(job));
  const items: CheckItem[] = [];
  job.requests.forEach((req, i) => {
    const call = base.calls[i];
    if (call?.ok && call.answers) items.push(...interpret(req, call.answers, { basis: job.basis, instructions: job.instructions }));
  });
  for (const f of base.failed) items.push({ check: "语义把关", result: "not_run", basis: f });
  return { ...base, items };
}
