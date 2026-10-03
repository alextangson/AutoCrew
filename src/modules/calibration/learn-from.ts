/**
 * 对标导入（cheat-learn-from，规格 §六）。两步：
 *   prepare：收 3–15 条样本（Way a 粘稿子 / Way b 资料库「对标视频」文件夹里的视频走本机 FunASR 转写）+ 数据 + 创始人印象（高/中/低+为什么）；
 *            单条失败不拖累其余，失败的逐条列出；转写模型没就绪按现有指引提示。
 *   save：宿主拆完套路、派生 rubric 信号、创始人过目后落盘——每个账号一份对标笔记、句式模式库追加，
 *         rubric 信号只作为观察进 rubric-memo（不改公式）。对标原话标 citable:false，不进证据台账、不能当事实引用。
 * 不抓平台、不用付费接口。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import { isWithin } from "../../storage/storage-roots.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { ASR_WARMUP_WHERE, extractAsrWav, runAsr } from "../video/asr.js";
import { decodeArg } from "../meetings/meeting-args.js";
import { LEARN_MAX_SAMPLES_PER_RUN, LEARN_MIN_SAMPLES } from "./constants.js";
import { normText, readObservations } from "./obs-store.js";
import { reproject } from "./observations.js";
import { requireText } from "./predict-input.js";
import { appendLog, assertLogsIntact, calibrationDir, ensureCalibration, readLog, serializeCalibration, writeState } from "./store.js";

type Obj = Record<string, unknown>;
export type Transcribe = (videoPath: string, workDir: string) => Promise<{ ok: true; text: string } | { ok: false; reason: string; notReady?: boolean }>;

export const benchmarkInbox = (dataDir?: string) => path.join(getDataDir(dataDir), "对标视频");

const defaultTranscribe: Transcribe = async (video, work) => {
  const wav = path.join(work, `${crypto.randomUUID()}.wav`);
  const ex = await extractAsrWav(video, wav);
  if (!ex.ok) return { ok: false, reason: ex.reason };
  const r = await runAsr({ audioFile: wav, outFile: `${wav}.json` });
  if (!r.ok) return { ok: false, reason: r.reason, notReady: r.blockedReason === "asr_not_ready" };
  return { ok: true, text: r.transcript.segments.map((s) => s.text).join("") };
};

function list(raw: unknown, field: string): Obj[] {
  const d = decodeArg(raw);
  if (!Array.isArray(d)) throw new Error(`${field} 必须是数组`);
  return d.map((x, i) => { const o = decodeArg(x); if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(`${field}[${i}] 必须是对象`); return o as Obj; });
}

function readMetrics(raw: unknown): Obj | string {
  const m = decodeArg(raw) as Obj | undefined;
  if (!m || typeof m !== "object" || !(Number(m.views) >= 0)) return "缺数据：metrics 至少要 views（播放/阅读），点赞评论转发有就一起给";
  return Object.fromEntries(["views", "likes", "comments", "shares"].filter((k) => m[k] !== undefined).map((k) => [k, Number(m[k])]));
}

async function sampleOf(s: Obj, dataDir: string | undefined, transcribe: Transcribe): Promise<{ ok: Obj } | { fail: string; notReady?: boolean }> {
  const impression = String(s.impression ?? "");
  if (!["高", "中", "低"].includes(impression) || !String(s.why ?? "").trim()) return { fail: "要创始人的印象判断：impression 高/中/低 + why" };
  const metrics = readMetrics(s.metrics);
  if (typeof metrics === "string") return { fail: metrics };
  let script = typeof s.script === "string" ? s.script.trim() : "";
  let way = "a";
  if (!script && typeof s.video_path === "string") {
    const inbox = benchmarkInbox(dataDir);
    const p = path.resolve(s.video_path);
    if (!isWithin(inbox, p)) return { fail: `视频要放在资料库「对标视频」文件夹里：${inbox}` };
    const t = await transcribe(p, path.join(calibrationDir(dataDir), "asr-work"));
    if (!t.ok) return { fail: t.notReady ? `转写模型还没就绪：去 ${ASR_WARMUP_WHERE}` : `转写失败：${t.reason}`, notReady: t.notReady };
    script = t.text; way = "b";
  }
  if (!script) return { fail: "没有稿子：粘 script 文本，或给资料库对标视频文件夹里的 video_path" };
  return { ok: { title: String(s.title ?? "").trim(), script, way, metrics, impression, why: String(s.why).trim(), citable: false } };
}

export async function learnPrepare(args: Obj, dataDir?: string, deps: { transcribe?: Transcribe } = {}): Promise<Obj> {
  const account = requireText(args.account, "account");
  const raw = list(args.samples, "samples");
  if (raw.length < LEARN_MIN_SAMPLES) return { ok: false, code: "too_few", error: `至少 ${LEARN_MIN_SAMPLES} 条样本才拆得出套路（推荐 5–10 条），现在 ${raw.length} 条` };
  if (raw.length > LEARN_MAX_SAMPLES_PER_RUN) return { ok: false, code: "too_many", error: `单次最多 ${LEARN_MAX_SAMPLES_PER_RUN} 条，分批导入` };
  const samples: Obj[] = [], failed: Obj[] = [];
  for (const [i, s] of raw.entries()) {
    const r = await sampleOf(s, dataDir, deps.transcribe ?? defaultTranscribe);
    if ("ok" in r) samples.push(r.ok); else failed.push({ index: i, title: s.title ?? null, error: r.fail });
  }
  if (samples.length < LEARN_MIN_SAMPLES) return { ok: false, code: "too_few_usable", error: `可用样本只剩 ${samples.length} 条（<${LEARN_MIN_SAMPLES}）`, failed };
  const id = `bench-${crypto.randomUUID().slice(0, 8)}`;
  await serializeCalibration(dataDir, () => appendLog("benchmark-imports", { type: "benchmark_samples", id, account, samples, failed, at: new Date().toISOString() }, dataDir));
  return { ok: true, import_id: id, account, samples: samples.map((s) => ({ title: s.title, way: s.way, impression: s.impression, why: s.why, metrics: s.metrics, script: s.script })), failed,
    next_action: "拆套路（script_patterns）+ 派生 rubric 信号（只定性），给创始人过目改完，再 calib_learn op:save 带 founder_reviewed:true" };
}

export async function learnSave(args: Obj, dataDir?: string): Promise<Obj> {
  if (args.founder_reviewed !== true) return { ok: false, code: "needs_review", error: "落盘前要创始人过目：确认后带 founder_reviewed:true" };
  const { records } = await readLog<Obj & { id: string; account: string; samples: Obj[] }>("benchmark-imports", dataDir);
  const imp = records.find((r) => r.id === args.import_id && r.type === "benchmark_samples");
  if (!imp) return { ok: false, code: "not_found", error: `import_id「${String(args.import_id)}」不存在：先 op:prepare` };
  if (records.some((r) => r.type === "benchmark_saved" && r.import_id === imp.id)) return { ok: false, code: "already_saved", error: "这批对标已经落过盘" };
  const patterns = list(args.patterns, "patterns").map((p, i) => ({ name: requireText(p.name, `patterns[${i}].name`), description: String(p.description ?? ""), example: String(p.example ?? "") }));
  const signals = (decodeArg(args.rubric_signals ?? []) as unknown[]).map((x) => String(x).trim()).filter(Boolean);
  return serializeCalibration(dataDir, () => persist(imp, patterns, signals, dataDir));
}

async function persist(imp: Obj & { id: string; account: string; samples: Obj[] }, patterns: Obj[], signals: string[], dataDir?: string): Promise<Obj> {
  await assertLogsIntact(["script-patterns", "rubric-memo", "benchmark-imports"], dataDir);
  const now = new Date().toISOString();
  const slug = imp.account.replace(/[\\/:*?"<>|\s]+/g, "_");
  const notePath = path.join(calibrationDir(dataDir), "benchmarks", `${slug}.json`);
  await fs.mkdir(path.dirname(notePath), { recursive: true });
  const prev = await fs.readFile(notePath, "utf-8").then((t) => JSON.parse(t) as Obj, () => null);
  const imports = [...((prev?.imports as Obj[]) ?? []), { import_id: imp.id, at: now, samples: imp.samples, patterns }];
  await writeJsonAtomic(notePath, { account: imp.account, citable: false, note: "对标原话只作参考，不进证据台账、不能当事实引用", imports });
  for (const p of patterns) await appendLog("script-patterns", { type: "script_pattern", ...p, source: `benchmark:${imp.account}`, import_id: imp.id, at: now }, dataDir);
  const { tombstones } = await readObservations(dataDir);
  const kept = signals.filter((t) => !tombstones.some((x) => normText(x.text) === normText(t)));
  for (const text of kept) await appendLog("rubric-memo", { type: "observation", id: `obs-${crypto.randomUUID().slice(0, 8)}`, stage: "observation", text, sample_ids: [], source: `benchmark:${imp.account}`, at: now }, dataDir);
  if (kept.length) await reproject(dataDir);
  await appendLog("benchmark-imports", { type: "benchmark_saved", import_id: imp.id, at: now }, dataDir);
  const { state } = await ensureCalibration(dataDir);
  await writeState({ ...state, benchmark_status: "imported", benchmark_accounts: [...new Set([...state.benchmark_accounts, imp.account])], benchmark_sample_count: state.benchmark_sample_count + imp.samples.length }, dataDir);
  return { ok: true, note: notePath, patterns: patterns.length, rubric_signals_as_observations: kept.length,
    ...(kept.length < signals.length ? { tombstoned_signals: signals.filter((s) => !kept.includes(s)) } : {}),
    reminder: state.calibration_samples >= 10 ? "校准样本已 ≥10：对标的影响自然减弱，笔记保留" : "冷启动期对标是早期锚点" };
}
