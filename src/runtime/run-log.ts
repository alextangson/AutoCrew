/**
 * 运行日志(V5.6 可观测性):每次 LLM 调用/工具调用的完整留痕——prompt 进/出、
 * 耗时、tokens、错误,落 <dataDir>/logs/runs/<YYYY-MM-DD>.jsonl(追加式)。
 * 补的是 dogfood 飞轮的缺口:events.jsonl 只有一行 label,出了错看不见 agent
 * 到底喂了什么、回了什么。
 *
 * 纪律:观测层不得破坏执行层——写失败静默吞;密钥字段落盘前脱敏;单条截断 16k;
 * 按文件名日期保留 14 天。注:logs/ 下的历史 session-*(已下线旧 logger)互不相干。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../storage/local-store.js";

/**
 * 调用方会话（P6 §3.8 会话归因，**只做诊断，不做门禁**）：MCP 层把转发器每进程一个的 nonce
 * （`X-AutoCrew-Session`）挂在这次 `tools/call` 的异步上下文上，这次调用里落的每条 run-log、
 * 写的每份认领/交接都顺手带上它——一条 trace 才分得出是哪个 Claude 会话干的。
 * 不经参数层层传：写认领的调用点散在十几个工具里，挨个加参数就会漏。
 */
const callerSessionStore = new AsyncLocalStorage<string>();

export function withCallerSession<T>(session: string, fn: () => T): T {
  return callerSessionStore.run(session, fn);
}

/** 当前调用所属的会话；不在 MCP 调用里（工作台、后台定时任务）= undefined */
export function callerSession(): string | undefined {
  return callerSessionStore.getStore();
}

/**
 * 归因元数据(一处定义,三处消费:日志记录、recorder 入参、`LoopOptions.logMeta`)。
 * 抄三份必然分叉——P1 加了角度/语料/补证三组字段,分叉一次就有一处日志永远缺列。
 */
export interface RunLogAttribution {
  /** 本次生成注入的对标拆解卡 id(收件箱设计 §3.5):飞轮据此归因「用卡的稿 vs 没用的」 */
  usedPatternIds?: string[];
  /** 本次生成注入的调研简报版本(深调研 §6):可回溯到 briefs/<topicId>.v<N>.json 那份不可变输入 */
  usedBriefRevision?: number;
  /** 那份简报的内容指纹(P1 §3.0):版本号说「哪一版」,指纹说「盘上那份没被换过」 */
  usedBriefHash?: string;
  /** 本稿生效的角度卡 id(P1 §4.4 归因):手写 direction / 无卡时不出现 */
  usedAngleId?: string;
  /** 那张卡的版本(2 或 3)与内容指纹——卡可改写,光有 id 说不清写的时候是哪一版 */
  usedAngleCardVersion?: number;
  usedAngleHash?: string;
  /** 写手实际注入的内部语料片段 id(P1 §3.2) */
  usedOwnMaterialIds?: string[];
  /** 定向补证/写手查证登记进账本的条目 id(P1 §3.3) */
  usedLookupIds?: string[];
  /** 用户明说跳过角度点选的原话(§1.6):它是「为什么没选角度」的证据,必须结构化留痕 */
  angleSkipReason?: string;
}

export interface RunLogRecord extends RunLogAttribution {
  ts: string;
  /** 任务归属:chat 轮 run-…/后台写稿 run-bg-…/封面 run-cover-…/独立引擎调用 run-eng-… */
  runId: string;
  /** run 内单调递增(进程内计数,重启从 1 重来——排序以 ts 兜底) */
  seq: number;
  /** fallback = 换了端点或熔断跳过(P6 §3.9):from/to/reason 必带,`to:"none"` = 没有端点接手 */
  kind: "llm" | "tool" | "fallback";
  /** 发起这次调用的宿主会话(P6 §3.8,诊断用);runId 的 session-* 是服务端按数据目录生成的,分不开会话 */
  session?: string;
  /** fallback 专用:从哪个端点 → 到哪个端点(端点 id) */
  from?: string;
  to?: string;
  /** fallback 专用:为什么换(主端点的失败原文,或熔断时健康记录里那句) */
  reason?: string;
  /** fallback 专用:熔断跳过、没发请求 */
  skipped?: boolean;
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
  const session = rec.session ?? callerSession();
  try {
    const dir = runsDir(dataDir);
    await fs.mkdir(dir, { recursive: true });
    await sweepOld(dir, ts.slice(0, 10));
    const input = clip(redactSecrets(rec.input));
    const output = clip(redactSecrets(rec.output));
    const full: RunLogRecord = {
      ...rec,
      ...(session ? { session } : {}),
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
    } else if (r.kind === "tool") {
      cur.toolCalls += 1;
    }
    // fallback 记录是换线留痕不是失败本身：真失败那次已有自己的 llm 记录，这里再算就重复了
    if (!r.ok && r.kind !== "fallback") cur.errorCount += 1;
    byRun.set(r.runId, cur);
  }
  return [...byRun.values()].sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1)).slice(0, limit);
}

export async function readRun(dataDir: string | undefined, runId: string): Promise<RunLogRecord[]> {
  const records = await readRecent(dataDir, RETENTION_DAYS);
  return records.filter((r) => r.runId === runId).sort((a, b) => a.seq - b.seq || (a.ts < b.ts ? -1 : 1));
}

/** 一次回退/熔断跳过的留痕(P6 §3.9)。ok = 接手的端点这次成没成(`to:"none"` 恒为 false) */
export interface FallbackEntry {
  from: string;
  to: string;
  reason: string;
  skipped: boolean;
  ok: boolean;
}

export interface RunRecorder {
  llm: (e: { model: string; durationMs: number; ok: boolean; error?: string; tokens?: number; input: string; output: string }) => void;
  tool: (e: { name: string; durationMs: number; ok: boolean; input: string; output: string }) => void;
  fallback: (e: FallbackEntry) => void;
}

const NOOP_RECORDER: RunRecorder = { llm: () => {}, tool: () => {}, fallback: () => {} };

/** dataDir 缺省(手工构造的测试 config)= 不落日志,引擎行为零变化 */
export function createRunRecorder(
  dataDir: string | undefined,
  meta?: RunLogAttribution & { runId?: string; agent?: string },
): RunRecorder {
  if (!dataDir) return NOOP_RECORDER;
  const runId = meta?.runId ?? `run-eng-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const agent = meta?.agent;
  // 归因元数据挂在每条记录上:单条日志自带「这稿用了哪几张卡/哪版简报」,不用回溯整个 run
  const attribution: RunLogAttribution = {
    ...(meta?.usedPatternIds?.length ? { usedPatternIds: meta.usedPatternIds } : {}),
    ...(meta?.usedBriefRevision !== undefined ? { usedBriefRevision: meta.usedBriefRevision } : {}),
    ...(meta?.usedBriefHash ? { usedBriefHash: meta.usedBriefHash } : {}),
    ...(meta?.usedAngleId ? { usedAngleId: meta.usedAngleId } : {}),
    ...(meta?.usedAngleCardVersion !== undefined ? { usedAngleCardVersion: meta.usedAngleCardVersion } : {}),
    ...(meta?.usedAngleHash ? { usedAngleHash: meta.usedAngleHash } : {}),
    ...(meta?.usedOwnMaterialIds?.length ? { usedOwnMaterialIds: meta.usedOwnMaterialIds } : {}),
    ...(meta?.usedLookupIds?.length ? { usedLookupIds: meta.usedLookupIds } : {}),
    ...(meta?.angleSkipReason ? { angleSkipReason: meta.angleSkipReason } : {}),
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
    fallback: (e) =>
      void appendRunLog(dataDir, {
        runId,
        kind: "fallback",
        agent,
        ...attribution,
        name: "fallback",
        action: `${e.from}→${e.to}`,
        from: e.from,
        to: e.to,
        reason: clip(redactSecrets(e.reason)).text,
        ...(e.skipped ? { skipped: true } : {}),
        durationMs: 0,
        ok: e.ok,
        input: "",
        output: "",
      }),
  };
}

export interface EngineFallbackStats {
  /** 24 h 内成功的模型调用里由备用端点顶上的占比;没有调用 = null(0/0 不是 0%) */
  fallback_rate_24h: number | null;
  /** 24 h 内熔断跳过的端点次数(每跳过一条线记一次) */
  skipped_24h: number;
  /** 分母:24 h 内成功的模型调用数——主路 host-first 时它本来就该是 0 */
  calls_24h: number;
}

/**
 * `autocrew_status overview` 的引擎一栏(P6 §3.9「24 h 回退率」)。
 * 分母取成功的 llm 记录(每次成功调用恰好一条);分子取「备用接手且成了」的 fallback 记录,
 * 两者一一对应,比值落在 [0,1]。两端都倒的调用不进比值,它们在 skipped/错误里看得见。
 */
export async function engineFallbackStats(dataDir?: string, now: number = Date.now()): Promise<EngineFallbackStats> {
  const since = new Date(now - 86_400_000).toISOString();
  const records = (await readRecent(dataDir, 2)).filter((r) => r.ts >= since);
  let calls = 0;
  let fallbacks = 0;
  let skipped = 0;
  for (const r of records) {
    if (r.kind === "llm" && r.ok) calls += 1;
    if (r.kind !== "fallback") continue;
    if (r.skipped) skipped += 1;
    if (r.ok && r.to !== "none") fallbacks += 1;
  }
  return {
    fallback_rate_24h: calls ? Math.round((fallbacks / calls) * 1000) / 1000 : null,
    skipped_24h: skipped,
    calls_24h: calls,
  };
}
