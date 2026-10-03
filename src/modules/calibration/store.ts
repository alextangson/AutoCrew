/**
 * 校准数据目录（规格 §一 三份文件分工）：
 *   calibration/rubric.json        盲评白名单（只放通用规则）
 *   calibration/rubric-memo.jsonl  升级 memo、被拒 log、观察生命周期事件（盲评不可读）
 *   calibration/state.json         代码状态
 *   calibration/predictions.jsonl  预测 / 复盘 / 修正 / 重算 记录（append-only）
 *   calibration/blind-runs.jsonl   盲评通道每次调用的输入指纹与输出（append-only）
 *
 * 不可改由代码保证：JSONL 只有追加入口；每行带自身指纹 fp 与上一行指纹 prev（哈希链），
 * 读时逐行复核，被改、被删、被插都会让链断掉并如实报出来。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { getDataDir } from "../../storage/local-store.js";
import { STATE_SCHEMA_VERSION } from "./constants.js";
import { DEFAULT_RUBRIC, rubricLeaks, type Rubric } from "./rubric.js";

export type LogName = "predictions" | "rubric-memo" | "blind-runs";

export interface BaselineEntry { plays: number; source: "age_cohort_d3" | "calibration_pool"; n: number; computed_at: string }
export interface DirectionalError { dir: "high" | "low"; ratio: number; prediction_id: string }

export interface CalibrationState {
  schema_version: string;
  rubric_version: string;
  content_form: "opinion-video";
  calibration_samples: number;
  calibration_samples_at_last_bump: number;
  samples_at_last_cleanup: number;
  baseline: Record<string, BaselineEntry>;
  last_bump_at: string | null;
  last_retro_at: string | null;
  last_prediction_self_scored: boolean;
  last_self_scored_at: string | null;
  consecutive_directional_errors: DirectionalError[];
  pending_retros: string[];
  in_progress: { blind_run_id: string; content_id: string; started_at: string; rubric_version: string } | null;
  benchmark_status: "none" | "imported";
  benchmark_accounts: string[];
  benchmark_sample_count: number;
  initialized_at: string;
}

export function calibrationDir(dataDir?: string): string {
  return path.join(getDataDir(dataDir), "calibration");
}
const file = (dataDir: string | undefined, name: string) => path.join(calibrationDir(dataDir), name);

function freshState(): CalibrationState {
  return {
    schema_version: STATE_SCHEMA_VERSION, rubric_version: DEFAULT_RUBRIC.version, content_form: "opinion-video",
    calibration_samples: 0, calibration_samples_at_last_bump: 0, samples_at_last_cleanup: 0, baseline: {},
    last_bump_at: null, last_retro_at: null, last_prediction_self_scored: false, last_self_scored_at: null,
    consecutive_directional_errors: [], pending_retros: [], in_progress: null,
    benchmark_status: "none", benchmark_accounts: [], benchmark_sample_count: 0, initialized_at: new Date().toISOString(),
  };
}

/** 同一数据目录的校准写入排队：读-改-写与追加不交错 */
const queues = new Map<string, Promise<unknown>>();
export function serializeCalibration<T>(dataDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = calibrationDir(dataDir);
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, run.catch(() => undefined));
  return run;
}

async function readJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, "utf-8")) as T; } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw new Error(`校准文件损坏：${p}（${(err as Error).message}）`);
  }
}

/** 第一次用时落起步 rubric 与空状态；已有就原样读（缺字段用默认补，不崩） */
export async function ensureCalibration(dataDir?: string): Promise<{ state: CalibrationState; rubric: Rubric }> {
  await fs.mkdir(calibrationDir(dataDir), { recursive: true });
  let rubric = await readJson<Rubric>(file(dataDir, "rubric.json"));
  if (!rubric) { rubric = DEFAULT_RUBRIC; await writeRubric(DEFAULT_RUBRIC, dataDir); }
  const raw = await readJson<Partial<CalibrationState>>(path.join(calibrationDir(dataDir), "state.json"));
  const state = { ...freshState(), ...(raw ?? {}) } as CalibrationState;
  if (!raw) await writeState(state, dataDir);
  return { state, rubric };
}

export async function writeState(state: CalibrationState, dataDir?: string): Promise<void> {
  await writeJsonAtomic(path.join(calibrationDir(dataDir), "state.json"), state);
}

/** 写 rubric.json 前过盲评白名单自检，命中即拒（不落盘） */
export async function writeRubric(rubric: Rubric, dataDir?: string): Promise<void> {
  const leaks = rubricLeaks(rubric);
  if (leaks.length) throw new Error(`rubric.json 是盲评白名单，不能写进数据或样本：${leaks.slice(0, 3).join(" / ")}`);
  await fs.mkdir(calibrationDir(dataDir), { recursive: true });
  await writeJsonAtomic(path.join(calibrationDir(dataDir), "rubric.json"), rubric);
}

export async function readRubric(dataDir?: string): Promise<Rubric> {
  return (await ensureCalibration(dataDir)).rubric;
}

// ───────────── append-only 哈希链 ─────────────

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const fingerprint = (v: unknown) => sha256(canonical(v));

export type ChainRecord = Record<string, unknown> & { type: string; fp: string; prev: string | null };
export interface LogRead<T> { records: T[]; integrity: { ok: boolean; problems: string[] } }

export async function readLog<T = ChainRecord>(name: LogName, dataDir?: string): Promise<LogRead<T>> {
  let raw = "";
  try { raw = await fs.readFile(path.join(calibrationDir(dataDir), `${name}.jsonl`), "utf-8"); } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }
  const records: ChainRecord[] = [];
  const problems: string[] = [];
  let prev: string | null = null;
  raw.split("\n").filter((l) => l.trim()).forEach((line, i) => {
    let rec: ChainRecord;
    try { rec = JSON.parse(line) as ChainRecord; } catch { problems.push(`第 ${i + 1} 行不是 JSON`); return; }
    const { fp, ...body } = rec;
    if (fingerprint(body) !== fp) problems.push(`第 ${i + 1} 行内容与指纹不符（被改过）`);
    if (rec.prev !== prev) problems.push(`第 ${i + 1} 行接不上前一行（有行被删或插入）`);
    prev = fp;
    records.push(rec);
  });
  return { records: records as unknown as T[], integrity: { ok: problems.length === 0, problems } };
}

/** 唯一的写入口：追加一行（带 prev/fp）。调用方需在 serializeCalibration 内调用 */
export async function appendLog(name: LogName, rec: Record<string, unknown> & { type: string }, dataDir?: string): Promise<ChainRecord> {
  const { records } = await readLog(name, dataDir);
  const prev = records.length ? records[records.length - 1].fp : null;
  const body = { ...rec, prev };
  const full = { ...body, fp: fingerprint(body) } as ChainRecord;
  await fs.mkdir(calibrationDir(dataDir), { recursive: true });
  await fs.appendFile(path.join(calibrationDir(dataDir), `${name}.jsonl`), `${JSON.stringify(full)}\n`, "utf-8");
  return full;
}

/** 升级清算失败时回滚用：记下各文件长度，失败后截回去 */
export async function snapshotSizes(dataDir?: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const n of ["predictions", "rubric-memo", "blind-runs"]) {
    try { out[n] = (await fs.stat(path.join(calibrationDir(dataDir), `${n}.jsonl`))).size; } catch { out[n] = 0; }
  }
  return out;
}
export async function truncateTo(sizes: Record<string, number>, dataDir?: string): Promise<void> {
  for (const [n, size] of Object.entries(sizes)) {
    const p = path.join(calibrationDir(dataDir), `${n}.jsonl`);
    try { await fs.truncate(p, size); } catch { /* 文件原本不存在 */ }
  }
}
