/**
 * 假设台账（spec §5.3）—— `<dataDir>/hypotheses.jsonl`，append-only + latest-wins 读，
 * 照 outcome-store 的 JSONL 模式：journal 永不改写，同 id 后写覆盖先写，坏行跳过。
 *
 * 台账只管**存**与**校验**；裁决在 hypothesis-judge.ts（确定性代码，不经模型）。
 * 模型提出的新假设走 `parseHypothesisProposals` —— 那是外部输入，逐字段校验，
 * 不合格整条拒收（宁可这期不写台账，也不写进一条脏假设）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import type { OutcomeMetrics } from "../flywheel/outcome-schema.js";

const HYPOTHESES_FILE = "hypotheses.jsonl";

/**
 * 可作为假设焦点的指标：OutcomeMetrics 全部键 + engagementRate。
 * engagementRate 是聚合层算出来的唯一跨平台率（spec §5.2 点名的「互动率」），
 * 不放进来的话「互动率高于基线」这类假设根本无法表达。
 */
export const METRIC_FOCUS_KEYS = [
  "views",
  "impressions",
  "completionRate",
  "completion5s",
  "likes",
  "comments",
  "shares",
  "favorites",
  "follows",
  "engagementRate",
] as const;
export type MetricFocus = keyof OutcomeMetrics | "engagementRate";

export type HypothesisStatus = "open" | "supported" | "refuted" | "inconclusive";
export type HypothesisDirection = "up" | "down";

/** 裁决证据：全是代码算出来的数，模型不得改写 */
export interface HypothesisEvidence {
  metricFocus: MetricFocus;
  /** 定龄口径（D+N） */
  ageDays: number;
  platforms: string[];
  /** 绑定稿件中拿到 D+N 读数的篇数 */
  sampleSize: number;
  /** 对照基线样本数（同平台同龄期，已剔除绑定稿件） */
  baselineSampleSize: number;
  testValue: number | null;
  baselineValue: number | null;
  /** 相对差 =（试验中位 − 基线中位）/ 基线中位 */
  relDiff: number | null;
  /** 为什么是这个裁决（含样本不足/跨平台不可比等拒判理由） */
  reason: string;
  /** 固定免责口径：观察性结论 */
  note: string;
}

export interface Hypothesis {
  id: string;
  statement: string;
  metricFocus: MetricFocus;
  direction: HypothesisDirection;
  scope: { platform?: string; tag?: string };
  /** 绑定的试验稿；提出时通常为空，发布后由人或复盘挂上 */
  contentIds: string[];
  proposedAt: string;
  retroRunId: string;
  status: HypothesisStatus;
  verdictAt?: string;
  evidence?: HypothesisEvidence;
  /** 下一步动作（模型提假设时必给：一条不能落到动作上的假设等于没提） */
  nextAction?: string;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isMetricFocus(v: unknown): v is MetricFocus {
  return typeof v === "string" && (METRIC_FOCUS_KEYS as readonly string[]).includes(v);
}

function scopeOf(v: unknown, errors: string[]): { platform?: string; tag?: string } {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    errors.push("scope 必须是对象");
    return {};
  }
  const raw = v as Record<string, unknown>;
  const scope: { platform?: string; tag?: string } = {};
  if (str(raw.platform)) scope.platform = str(raw.platform);
  if (str(raw.tag)) scope.tag = str(raw.tag);
  return scope;
}

const MAX_STATEMENT = 200;

/** 完整假设记录校验（落盘前最后一道，也用于读侧过滤脏行） */
export function validateHypothesis(input: unknown): Validated<Hypothesis> {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["假设必须是对象"] };
  }
  const raw = input as Record<string, unknown>;
  const id = str(raw.id);
  const statement = str(raw.statement);
  const retroRunId = str(raw.retroRunId);
  const proposedAt = str(raw.proposedAt);
  if (!id) errors.push("id 必填");
  if (!statement) errors.push("statement 必填");
  if (statement.length > MAX_STATEMENT) errors.push(`statement 超过 ${MAX_STATEMENT} 字`);
  if (!isMetricFocus(raw.metricFocus)) errors.push(`metricFocus 必须是 ${METRIC_FOCUS_KEYS.join("/")} 之一`);
  if (raw.direction !== "up" && raw.direction !== "down") errors.push("direction 必须是 up 或 down");
  if (!retroRunId) errors.push("retroRunId 必填");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(proposedAt)) errors.push("proposedAt 必须是 ISO 时间");
  const status = str(raw.status) || "open";
  if (!["open", "supported", "refuted", "inconclusive"].includes(status)) errors.push(`status ${status} 非法`);
  const contentIds = Array.isArray(raw.contentIds)
    ? raw.contentIds.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    : [];
  if (raw.contentIds !== undefined && !Array.isArray(raw.contentIds)) errors.push("contentIds 必须是数组");
  const scope = scopeOf(raw.scope, errors);
  if (errors.length > 0) return { ok: false, errors };

  const value: Hypothesis = {
    id,
    statement,
    metricFocus: raw.metricFocus as MetricFocus,
    direction: raw.direction as HypothesisDirection,
    scope,
    contentIds,
    proposedAt,
    retroRunId,
    status: status as HypothesisStatus,
    ...(str(raw.verdictAt) ? { verdictAt: str(raw.verdictAt) } : {}),
    ...(raw.evidence && typeof raw.evidence === "object"
      ? { evidence: raw.evidence as HypothesisEvidence }
      : {}),
    ...(str(raw.nextAction) ? { nextAction: str(raw.nextAction) } : {}),
  };
  return { ok: true, value };
}

const MAX_PROPOSALS = 3;

/** 去掉 ```json / ```hypotheses 围栏——模型爱包围栏，包了也照收 */
function stripFence(raw: string): string {
  const fenced = raw.match(/```(?:json|hypotheses)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : raw).trim();
}

/**
 * 解析模型提出的新假设 JSON 块 → 完整假设记录。
 * 任何一条不合格 = 整块拒收（部分收下会让台账里混进半截假设，还得靠人挑）。
 */
export function parseHypothesisProposals(
  raw: string,
  ctx: { retroRunId: string; proposedAt?: string },
): Validated<Hypothesis[]> {
  const text = stripFence(raw ?? "");
  if (!text) return { ok: false, errors: ["假设块为空"] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`JSON 解析失败:${err instanceof Error ? err.message : String(err)}`] };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0) return { ok: true, value: [] };
  if (list.length > MAX_PROPOSALS) return { ok: false, errors: [`一次最多 ${MAX_PROPOSALS} 条假设,收到 ${list.length} 条`] };

  const proposedAt = ctx.proposedAt ?? new Date().toISOString();
  const value: Hypothesis[] = [];
  const errors: string[] = [];
  list.forEach((item, i) => {
    const fields = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    if (!str(fields.nextAction)) errors.push(`第 ${i + 1} 条:nextAction 必填(假设要能落到动作上)`);
    const candidate = {
      ...fields,
      id: `hyp-${ctx.retroRunId}-${i + 1}`,
      proposedAt,
      retroRunId: ctx.retroRunId,
      status: "open",
    };
    const checked = validateHypothesis(candidate);
    if (checked.ok) value.push(checked.value);
    else errors.push(`第 ${i + 1} 条:${checked.errors.join("；")}`);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

function hypothesesPath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), HYPOTHESES_FILE);
}

/** 进程内写队列：读-改-写不互相穿插（同 outcome-store 的做法） */
const writeChains = new Map<string, Promise<unknown>>();

function serializeHypothesisWrite<T>(dataDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = getDataDir(dataDir);
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(() => undefined, () => undefined);
  writeChains.set(key, tail);
  void tail.then(() => {
    if (writeChains.get(key) === tail) writeChains.delete(key);
  });
  return next;
}

/** latest-wins：同 id 只保留 journal 中最后一条；坏行/不合 schema 的行跳过 */
export async function listHypotheses(dataDir?: string): Promise<Hypothesis[]> {
  let raw: string;
  try {
    raw = await fs.readFile(hypothesesPath(dataDir), "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const byId = new Map<string, Hypothesis>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // 崩溃留下的半行：跳过，不清空整个读视图
    }
    const checked = validateHypothesis(parsed);
    if (checked.ok) byId.set(checked.value.id, checked.value);
  }
  return [...byId.values()];
}

export async function listOpenHypotheses(dataDir?: string): Promise<Hypothesis[]> {
  return (await listHypotheses(dataDir)).filter((h) => h.status === "open");
}

/** 单次 append 落盘；写前逐条校验，不合格直接抛（脏数据不进 journal） */
export async function appendHypotheses(items: Hypothesis[], dataDir?: string): Promise<void> {
  if (items.length === 0) return;
  for (const h of items) {
    const checked = validateHypothesis(h);
    if (!checked.ok) throw new Error(`假设不合 schema:${checked.errors.join("；")}`);
  }
  await serializeHypothesisWrite(dataDir, async () => {
    await fs.mkdir(getDataDir(dataDir), { recursive: true });
    const payload = items.map((h) => JSON.stringify(h) + "\n").join("");
    await fs.appendFile(hypothesesPath(dataDir), payload, "utf-8");
  });
}
