/**
 * 运行日志(V5.6 可观测性):每次 LLM 调用/工具调用的完整留痕——prompt 进/出、
 * 耗时、tokens、错误,落 <dataDir>/logs/runs/<YYYY-MM-DD>.jsonl(追加式)。
 * 补的是 dogfood 飞轮的缺口:events.jsonl 只有一行 label,出了错看不见 agent
 * 到底喂了什么、回了什么。
 *
 * 纪律:观测层不得破坏执行层——写失败静默吞;密钥字段落盘前脱敏;单条截断 16k;
 * 按文件名日期保留 14 天。注:logs/ 下的历史 session-*(已下线旧 logger)互不相干。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../storage/local-store.js";

export interface RunLogRecord {
  ts: string;
  /** 任务归属:chat 轮 run-…/后台写稿 run-bg-…/封面 run-cover-…/独立引擎调用 run-eng-… */
  runId: string;
  /** run 内单调递增(进程内计数,重启从 1 重来——排序以 ts 兜底) */
  seq: number;
  kind: "llm" | "tool";
  /** 角色:chief-editor / writer / cover-designer / audience-researcher / mcp … */
  agent?: string;
  /** llm=模型名;tool=工具名 */
  name: string;
  action?: string;
  durationMs: number;
  ok: boolean;
  error?: string;
  tokens?: number;
  /** llm=发出的 messages JSON;tool=入参 JSON。已脱敏+截断 */
  input: string;
  /** llm=assistant 消息 JSON;tool=返回串。已脱敏+截断 */
  output: string;
  truncated?: boolean;
  /** 本次生成注入的对标拆解卡 id(收件箱设计 §3.5):飞轮据此归因「用卡的稿 vs 没用的」 */
  usedPatternIds?: string[];
  /** 本次生成注入的调研简报版本(深调研 §6):可回溯到 briefs/<topicId>.v<N>.json 那份不可变输入 */
  usedBriefRevision?: number;
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  endedAt: string;
  agents: string[];
  llmCalls: number;
  toolCalls: number;
  errorCount: number;
  totalTokens: number;
  firstModel?: string;
}

const TRUNCATE_AT = 16_000;
const RETENTION_DAYS = 14;
const LIST_WINDOW_FILES = 7;

/** JSON 字符串值级脱敏:字段名含 key/token/secret/password(大小写不敏感)的值全遮 */
const SECRET_VALUE_RE = /("[^"]*(?:key|token|secret|password)[^"]*"\s*:\s*")((?:[^"\\]|\\.)*)(")/gi;

export function redactSecrets(s: string): string {
  return s.replace(SECRET_VALUE_RE, "$1<redacted>$3");
}

function clip(s: string): { text: string; truncated: boolean } {
  if (s.length <= TRUNCATE_AT) return { text: s, truncated: false };
  return { text: `${s.slice(0, TRUNCATE_AT)}…[截断 ${s.length - TRUNCATE_AT} 字符]`, truncated: true };
}

function runsDir(dataDir?: string): string {
  return path.join(getDataDir(dataDir), "logs", "runs");
}

const seqByRun = new Map<string, number>();

function nextSeq(runId: string): number {
  const n = (seqByRun.get(runId) ?? 0) + 1;
  seqByRun.set(runId, n);
  if (seqByRun.size > 500) {
    const oldest = seqByRun.keys().next().value;
    if (oldest !== undefined) seqByRun.delete(oldest);
  }
  return n;
}

/** 清理去重按「目录+日期」——同进程可能写多个工作区的日志 */
const sweptDirs = new Set<string>();

async function sweepOld(dir: string, today: string): Promise<void> {
  const key = `${dir}@${today}`;
  if (sweptDirs.has(key)) return;
  if (sweptDirs.size > 100) sweptDirs.clear();
  sweptDirs.add(key);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && m[1] < cutoff) await fs.unlink(path.join(dir, f)).catch(() => {});
  }
}

export async function appendRunLog(
  dataDir: string | undefined,
  rec: Omit<RunLogRecord, "ts" | "seq" | "truncated">,
): Promise<void> {
  // seq 在任何 await 之前同步分配——fire-and-forget 并发追加也保持逻辑顺序(读侧按 seq 排)
  const seq = nextSeq(rec.runId);
  const ts = new Date().toISOString();
  try {
    const dir = runsDir(dataDir);
    await fs.mkdir(dir, { recursive: true });
    await sweepOld(dir, ts.slice(0, 10));
    const input = clip(redactSecrets(rec.input));
    const output = clip(redactSecrets(rec.output));
    const full: RunLogRecord = {
      ...rec,
      ts,
      seq,
      input: input.text,
      output: output.text,
      ...(input.truncated || output.truncated ? { truncated: true } : {}),
    };
    await fs.appendFile(path.join(dir, `${ts.slice(0, 10)}.jsonl`), JSON.stringify(full) + "\n", "utf-8");
  } catch {
    /* 观测层吞错 */
  }
}

async function readRecent(dataDir: string | undefined, fileWindow: number): Promise<RunLogRecord[]> {
  const dir = runsDir(dataDir);
  const files = (await fs.readdir(dir).catch(() => [] as string[]))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .slice(-fileWindow);
  const records: RunLogRecord[] = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(dir, f), "utf-8").catch(() => "");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as RunLogRecord);
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  return records;
}

export async function listRuns(dataDir?: string, limit = 50): Promise<RunSummary[]> {
  const records = await readRecent(dataDir, LIST_WINDOW_FILES);
  const byRun = new Map<string, RunSummary>();
  for (const r of records) {
    const cur =
      byRun.get(r.runId) ??
      ({ runId: r.runId, startedAt: r.ts, endedAt: r.ts, agents: [], llmCalls: 0, toolCalls: 0, errorCount: 0, totalTokens: 0 } as RunSummary);
    if (r.ts < cur.startedAt) cur.startedAt = r.ts;
    if (r.ts > cur.endedAt) cur.endedAt = r.ts;
    if (r.agent && !cur.agents.includes(r.agent)) cur.agents.push(r.agent);
    if (r.kind === "llm") {
      cur.llmCalls += 1;
      cur.totalTokens += r.tokens ?? 0;
      if (!cur.firstModel) cur.firstModel = r.name;
    } else {
      cur.toolCalls += 1;
    }
    if (!r.ok) cur.errorCount += 1;
    byRun.set(r.runId, cur);
  }
  return [...byRun.values()].sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1)).slice(0, limit);
}

export async function readRun(dataDir: string | undefined, runId: string): Promise<RunLogRecord[]> {
  const records = await readRecent(dataDir, RETENTION_DAYS);
  return records.filter((r) => r.runId === runId).sort((a, b) => a.seq - b.seq || (a.ts < b.ts ? -1 : 1));
}

export interface RunRecorder {
  llm: (e: { model: string; durationMs: number; ok: boolean; error?: string; tokens?: number; input: string; output: string }) => void;
  tool: (e: { name: string; durationMs: number; ok: boolean; input: string; output: string }) => void;
}

const NOOP_RECORDER: RunRecorder = { llm: () => {}, tool: () => {} };

/** dataDir 缺省(手工构造的测试 config)= 不落日志,引擎行为零变化 */
export function createRunRecorder(
  dataDir: string | undefined,
  meta?: { runId?: string; agent?: string; usedPatternIds?: string[]; usedBriefRevision?: number },
): RunRecorder {
  if (!dataDir) return NOOP_RECORDER;
  const runId = meta?.runId ?? `run-eng-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const agent = meta?.agent;
  // 归因元数据挂在每条记录上:单条日志自带「这稿用了哪几张卡/哪版简报」,不用回溯整个 run
  const attribution = {
    ...(meta?.usedPatternIds?.length ? { usedPatternIds: meta.usedPatternIds } : {}),
    ...(meta?.usedBriefRevision !== undefined ? { usedBriefRevision: meta.usedBriefRevision } : {}),
  };
  return {
    llm: (e) =>
      void appendRunLog(dataDir, {
        runId,
        kind: "llm",
        agent,
        ...attribution,
        name: e.model,
        durationMs: e.durationMs,
        ok: e.ok,
        error: e.error,
        tokens: e.tokens,
        input: e.input,
        output: e.output,
      }),
    tool: (e) =>
      void appendRunLog(dataDir, {
        runId,
        kind: "tool",
        agent,
        ...attribution,
        name: e.name,
        durationMs: e.durationMs,
        ok: e.ok,
        input: e.input,
        output: e.output,
      }),
  };
}
