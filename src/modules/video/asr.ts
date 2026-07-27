/**
 * ASR：FunASR sidecar 的调用封装（设计 spec §4.3）。
 *
 * 契约在 `sidecars/asr/README.md`，这里只负责把它翻成管线语义：
 *
 * - **未就绪 ≠ 失败**：没装 uv、sidecar 不在、模型没下载，都是 `blocked: asr_not_ready`
 *   加一条人话指引（装什么、点哪儿）。翻成 failed 会诱导人去点「重试」，而重试一百次也没用。
 * - **半文件 = 失败可见**：sidecar 崩在写一半、或输出结构不对，一律报「转写产物损坏」，
 *   绝不把半个 transcript 当事实存进不可变产物里。
 * - **预热是后台动作**：模型 ~1GB，`warmupAsr` 投出去就返回，状态写
 *   `<dataDir>/video/asr-status.json`（原子写）供 doctor/设置页查询。
 *
 * FunASR 吃的是音频。A-roll 是 mp4，所以先用 ffmpeg 抽一条 16k 单声道 wav——
 * 这一步属于「准备 ASR 输入」，故留在本模块，不散到 assemble 去。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { commandExists, nowIso, REPO_ROOT, runProcess, stderrTail, type VideoDeps } from "./proc.js";
import type { TranscriptSegment, VideoTranscript } from "./types.js";

/** 长音频 + CPU 推理，10 分钟是「肯定卡死了」的量级而不是「慢一点」（§3 lease 同量级） */
export const ASR_TIMEOUT_MS = 10 * 60_000;
/** 与 asr.py 的约定：20 = 模型未就绪 */
export const ASR_EXIT_MODEL_NOT_READY = 20;

export const ASR_SIDECAR_DIR = path.join(REPO_ROOT, "sidecars", "asr");
export const ASR_SIDECAR_SCRIPT = path.join(ASR_SIDECAR_DIR, "asr.py");

const INSTALL_UV = "未装 uv（ASR sidecar 的运行器）。装法：brew install uv，装好后重试";
const NEED_WARMUP = "ASR 模型还没下载（约 1GB）。到设置里点一次「预热 ASR 模型」，下完再重试";

export type AsrStatusValue = "absent" | "warming" | "ready" | "failed";

export interface AsrStatusRecord {
  status: AsrStatusValue;
  detail?: string;
  updatedAt?: string;
}

export type AsrOutcome =
  | { ok: true; transcript: VideoTranscript }
  | { ok: false; blockedReason?: "asr_not_ready"; errorCode: string; reason: string };

export interface AsrRequest {
  audioFile: string;
  outFile: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

function sidecarArgs(extra: readonly string[]): string[] {
  return ["run", "--project", ASR_SIDECAR_DIR, ASR_SIDECAR_SCRIPT, ...extra];
}

// ---------------------------------------------------------------------------
// 音频抽取
// ---------------------------------------------------------------------------

/** 16k 单声道 wav —— Paraformer 的输入规格；顺带把视频轨扔掉，省得 sidecar 再解一遍 */
export async function extractAsrWav(
  source: string,
  out: string,
  deps?: VideoDeps,
): Promise<{ ok: true } | { ok: false; errorCode: string; reason: string }> {
  await fs.mkdir(path.dirname(out), { recursive: true });
  const result = await runProcess({
    command: "ffmpeg",
    args: ["-y", "-hide_banner", "-nostdin", "-v", "error", "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out],
    timeoutMs: 10 * 60_000,
    ...(deps?.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
  });
  if (result.spawnError) {
    return { ok: false, errorCode: "ffmpeg_missing", reason: `找不到 ffmpeg：${result.spawnError}。装法：brew install ffmpeg` };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      errorCode: "audio_extract_failed",
      reason: `抽取音轨失败（ffmpeg 退出码 ${String(result.code)}）：${stderrTail(result.stderr, 3) || "无输出"}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 转写
// ---------------------------------------------------------------------------

async function preflight(deps?: VideoDeps): Promise<AsrOutcome | null> {
  try {
    await fs.access(ASR_SIDECAR_SCRIPT);
  } catch {
    return {
      ok: false,
      blockedReason: "asr_not_ready",
      errorCode: "asr_sidecar_missing",
      reason: `找不到 ASR sidecar（${ASR_SIDECAR_SCRIPT}）：仓库不完整，请重新拉取`,
    };
  }
  if (!(await commandExists("uv", deps))) {
    return { ok: false, blockedReason: "asr_not_ready", errorCode: "uv_missing", reason: INSTALL_UV };
  }
  return null;
}

/** sidecar 输出是系统边界：逐字段验，验不过就是「产物损坏」，不猜不补 */
function parseTranscript(raw: string): { ok: true; transcript: VideoTranscript } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "转写产物不是合法 JSON（sidecar 可能崩在写一半）" };
  }
  const obj = parsed as Partial<VideoTranscript>;
  if (!obj || typeof obj !== "object" || obj.schemaVersion !== 1 || obj.source !== "funasr") {
    return { ok: false, reason: "转写产物的 schemaVersion/source 不对，sidecar 与主进程版本不一致" };
  }
  if (!Array.isArray(obj.segments)) return { ok: false, reason: "转写产物缺少 segments 数组" };
  for (const seg of obj.segments as TranscriptSegment[]) {
    const shapeOk =
      seg && typeof seg.id === "string" && typeof seg.text === "string" &&
      Number.isFinite(seg.startMs) && Number.isFinite(seg.endMs) && Array.isArray(seg.words);
    if (!shapeOk) return { ok: false, reason: `转写产物里有结构不对的分句：${JSON.stringify(seg)?.slice(0, 120)}` };
  }
  return { ok: true, transcript: { schemaVersion: 1, source: "funasr", segments: obj.segments } };
}

function classifyExit(result: { code: number | null; timedOut: boolean; stderr: string }, timeoutMs: number): AsrOutcome {
  if (result.timedOut) {
    return {
      ok: false,
      errorCode: "asr_timeout",
      reason: `转写超时（${Math.round(timeoutMs / 60_000)} 分钟未返回），已终止进程组：${stderrTail(result.stderr, 3) || "无输出"}`,
    };
  }
  if (result.code === ASR_EXIT_MODEL_NOT_READY) {
    return { ok: false, blockedReason: "asr_not_ready", errorCode: "asr_model_missing", reason: NEED_WARMUP };
  }
  return {
    ok: false,
    errorCode: `asr_exit_${String(result.code)}`,
    reason: `转写失败（sidecar 退出码 ${String(result.code)}）：${stderrTail(result.stderr) || "无输出"}`,
  };
}

export async function runAsr(req: AsrRequest, deps?: VideoDeps): Promise<AsrOutcome> {
  const blocked = await preflight(deps);
  if (blocked) return blocked;
  const timeoutMs = req.timeoutMs ?? ASR_TIMEOUT_MS;
  await fs.mkdir(path.dirname(req.outFile), { recursive: true });
  await fs.rm(req.outFile, { force: true });

  const result = await runProcess({
    command: "uv",
    args: sidecarArgs(["--audio", req.audioFile, "--out", req.outFile]),
    cwd: REPO_ROOT,
    timeoutMs,
    ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
    ...(deps?.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
  });
  if (result.spawnError) {
    return { ok: false, blockedReason: "asr_not_ready", errorCode: "uv_missing", reason: `${INSTALL_UV}（${result.spawnError}）` };
  }
  if (result.code !== 0) return classifyExit(result, timeoutMs);

  let raw: string;
  try {
    raw = await fs.readFile(req.outFile, "utf-8");
  } catch {
    return { ok: false, errorCode: "asr_no_output", reason: "sidecar 退出码为 0 却没写出转写文件——契约被破坏，请查 stderr 日志" };
  }
  const parsed = parseTranscript(raw);
  if (!parsed.ok) return { ok: false, errorCode: "asr_bad_output", reason: parsed.reason };
  return { ok: true, transcript: parsed.transcript };
}

// ---------------------------------------------------------------------------
// 与口播稿的对齐度（§4.4）
// ---------------------------------------------------------------------------

/** 只留文字与数字：标点、空格、换行在两侧的出现规律完全不同，算进去等于给噪音投票 */
function bigrams(text: string): Set<string> {
  const chars = [...text.replace(/[^\p{L}\p{N}]/gu, "")];
  const set = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i++) set.add(chars[i] + chars[i + 1]);
  return set;
}

/**
 * 「照着稿子念了多少」= 稿件的字符二元组里有多少在转写里出现过。
 *
 * 为什么是二元组而不是逐字：逐字重合率对中文永远虚高（常用字满天飞），
 * 二元组能区分「念了这段话」和「念了另一段但用词相近」。
 * 这个数只用来判断要不要给 LLM 建议权（V0b，<0.5 不给），不参与任何自动决策。
 */
export function scriptMatchRatio(transcript: VideoTranscript, body: string): number {
  const script = bigrams(body);
  if (script.size === 0) return 0;
  const spoken = bigrams(transcript.segments.map((s) => s.text).join(""));
  let hit = 0;
  for (const gram of script) if (spoken.has(gram)) hit += 1;
  return Math.round((hit / script.size) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// 预热与状态
// ---------------------------------------------------------------------------

function asrStatusFile(dataDir: string): string {
  return path.join(dataDir, "video", "asr-status.json");
}

async function writeAsrStatus(dataDir: string, record: AsrStatusRecord, deps?: VideoDeps): Promise<AsrStatusRecord> {
  const next: AsrStatusRecord = { ...record, updatedAt: nowIso(deps) };
  await fs.mkdir(path.dirname(asrStatusFile(dataDir)), { recursive: true });
  await writeJsonAtomic(asrStatusFile(dataDir), next);
  return next;
}

export async function readAsrStatus(dataDir: string): Promise<AsrStatusRecord> {
  try {
    const parsed = JSON.parse(await fs.readFile(asrStatusFile(dataDir), "utf-8")) as AsrStatusRecord;
    const known: AsrStatusValue[] = ["absent", "warming", "ready", "failed"];
    if (parsed && known.includes(parsed.status)) return parsed;
    return { status: "absent", detail: "预热状态文件内容不认识，按「未预热」处理" };
  } catch {
    return { status: "absent" };
  }
}

/** 同一进程内只许有一次预热在跑——1GB 下载重复两遍纯属浪费带宽 */
const warmingUp = new Set<string>();

/**
 * 后台预热：投出去立刻返回 `warming`，进程退出时把 ready/failed 落盘。
 * 调用方（doctor / 设置页）轮 `asrStatus()` 看结果。
 */
export async function warmupAsr(dataDir: string, deps?: VideoDeps): Promise<AsrStatusRecord> {
  if (warmingUp.has(dataDir)) return readAsrStatus(dataDir);
  const blocked = await preflight(deps);
  if (blocked && !blocked.ok) {
    return writeAsrStatus(dataDir, { status: "failed", detail: blocked.reason }, deps);
  }
  warmingUp.add(dataDir);
  const pending = await writeAsrStatus(dataDir, { status: "warming", detail: "正在下载/加载模型（约 1GB），可以先干别的" }, deps);
  void runProcess({
    command: "uv",
    args: sidecarArgs(["--warmup"]),
    cwd: REPO_ROOT,
    timeoutMs: 60 * 60_000,
    ...(deps?.spawnImpl ? { spawnImpl: deps.spawnImpl } : {}),
  })
    .then((result) => {
      const ok = !result.spawnError && result.code === 0;
      return writeAsrStatus(
        dataDir,
        ok
          ? { status: "ready", detail: "模型已就绪" }
          : { status: "failed", detail: result.spawnError ?? `预热失败（退出码 ${String(result.code)}）：${stderrTail(result.stderr, 4) || "无输出"}` },
        deps,
      );
    })
    .catch((err: unknown) => writeAsrStatus(dataDir, { status: "failed", detail: String(err) }, deps))
    .finally(() => warmingUp.delete(dataDir));
  return pending;
}
