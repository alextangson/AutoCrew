/**
 * 原片内容比对的校准（1b §2.1）：**只读**扫资料库里已有 accepted 原片 / 成片的稿，
 * 用和比对器同一套打分（开头 120 秒转写 × 池内正文），算「对自己稿的分」「对最像的别条稿的分」「差距」与有效字数。
 *
 * - 不写资料库、不写 ~/.autocrew：不调会顺手恢复 / 建项目的读口（getContent / listContents），直接读注册表、meta.json、production.json。
 * - 不存转写文本、不存正文：输出只有内容 id、标题和数字，落到 ~/.cache/autocrew-yt/ontology-1b/calibration.json。
 * - 串行、nice 10；临时音频放 ~/.cache/autocrew-yt/ontology-1b/tmp，用完即删。
 *
 * 用法：npx tsx scripts/calibrate-aroll-match.mts [--asr-dir <sidecars/asr 目录>] [--asr-timeout-ms 90000] [--limit N]
 * （worktree 里没有 .venv 时，把 --asr-dir 指到主仓库的 sidecars/asr）
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectFile, readProjectRegistry, resolveContentProject } from "../src/storage/content-project.js";
import { readProductionDoc } from "../src/storage/production-store.js";
import type { Fact } from "../src/storage/production-types.js";
import { readLibraryLocation } from "../src/storage/storage-roots.js";
import { isVideoPlatform } from "../src/storage/stage-guard.js";
import { extractAsrWav, ASR_SIDECAR_DIR } from "../src/modules/video/asr.js";
import { runProcess } from "../src/modules/video/proc.js";
import { CLIP_SECONDS, MATCH_ASR_TIMEOUT_MS, MATCH_FFMPEG_TIMEOUT_MS, scoreTranscript, speechChars } from "../src/modules/production/match/l2.js";
import { MATCH_NICENESS } from "../src/modules/production/match/transcribe.js";

const OUT_DIR = path.join(os.homedir(), ".cache", "autocrew-yt", "ontology-1b");
const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const ASR_DIR = path.resolve(arg("asr-dir") ?? ASR_SIDECAR_DIR);
const ASR_TIMEOUT = Number(arg("asr-timeout-ms") ?? MATCH_ASR_TIMEOUT_MS);
const LIMIT = Number(arg("limit") ?? Infinity);

interface Doc { id: string; title: string; status: string; body: string }
interface Sample { content_id: string; title: string; kind: "aroll" | "cut"; fact_id: string; file: string }

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { return null; }
}

/** 池：未删除、未归档、有正文的视频稿；正文取冻结副本（有）否则当前正文 */
async function loadLibrary(dataDir: string): Promise<{ docs: Doc[]; samples: Sample[] }> {
  const registry = readProjectRegistry(dataDir);
  if (!registry) throw new Error(`${dataDir} 不是 layout v2 资料库工作区`);
  const docs: Doc[] = [];
  const samples: Sample[] = [];
  for (const id of Object.keys(registry.projects)) {
    const root = resolveContentProject(id, dataDir)!.project_root;
    const meta = await readJson<{ title: string; status: string; body?: string; platform?: string; deletedAt?: string | null }>(projectFile(root, "meta.json"));
    if (!meta || meta.deletedAt || meta.status === "archived" || !isVideoPlatform(meta.platform)) continue;
    const doc = await readProductionDoc(id, dataDir).catch(() => null);
    const frozen = doc?.frozen ? await fs.readFile(path.join(root, doc.frozen.path), "utf8").catch(() => null) : null;
    const body = frozen ?? meta.body ?? "";
    if (!body.trim()) continue;
    docs.push({ id, title: meta.title, status: meta.status, body });
    for (const kind of ["aroll", "cut"] as const) {
      const f = pickFact(doc?.facts ?? [], kind);
      if (f?.path) samples.push({ content_id: id, title: meta.title, kind, fact_id: f.id, file: path.isAbsolute(f.path) ? f.path : path.join(root, f.path) });
    }
  }
  return { docs, samples };
}

/** 每条稿每种取一份：最新的 accepted、文件还在的 */
function pickFact(facts: Fact[], kind: "aroll" | "cut"): Fact | undefined {
  return facts.filter((f) => f.kind === kind && f.state === "accepted" && f.availability === "present" && !f.replaced_at).sort((a, b) => b.at.localeCompare(a.at))[0];
}

async function transcribeHead(file: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const dir = await fs.mkdtemp(path.join(OUT_DIR, "tmp-"));
  try {
    const wav = path.join(dir, "head.wav");
    const clipped = await extractAsrWav(file, wav, undefined, { maxSeconds: CLIP_SECONDS, timeoutMs: MATCH_FFMPEG_TIMEOUT_MS, niceness: MATCH_NICENESS });
    if (!clipped.ok) return { ok: false, reason: clipped.reason };
    const out = path.join(dir, "head.json");
    const r = await runProcess({ command: "uv", args: ["run", "--project", ASR_DIR, path.join(ASR_DIR, "asr.py"), "--audio", wav, "--out", out], cwd: ASR_DIR, timeoutMs: ASR_TIMEOUT, niceness: MATCH_NICENESS });
    if (r.timedOut) return { ok: false, reason: `转写超时（${ASR_TIMEOUT / 1000} 秒）` };
    if (r.code !== 0) return { ok: false, reason: `转写退出码 ${String(r.code)}：${r.stderr.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200)}` };
    const json = await readJson<{ segments?: Array<{ text?: string }> }>(out);
    if (!json?.segments) return { ok: false, reason: "转写产物读不出 segments" };
    return { ok: true, text: json.segments.map((s) => s.text ?? "").join("") };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface Row {
  content_id: string; title: string; kind: string; fact_id: string; chars: number; pool: number;
  self: number; best_other: number; best_other_id: string | null; best_other_title: string | null; margin: number; self_is_top: boolean; ms: number;
}

function scoreRow(s: Sample, text: string, docs: Doc[], ms: number): Row {
  const scores = scoreTranscript(text, docs.map((d) => d.body));
  const selfIdx = docs.findIndex((d) => d.id === s.content_id);
  let bestIdx = -1;
  scores.forEach((v, i) => { if (i !== selfIdx && (bestIdx < 0 || v > scores[bestIdx])) bestIdx = i; });
  const self = scores[selfIdx] ?? 0, other = bestIdx >= 0 ? scores[bestIdx] : 0;
  return { content_id: s.content_id, title: s.title, kind: s.kind, fact_id: s.fact_id, chars: speechChars(text), pool: docs.length, self, best_other: other,
    best_other_id: bestIdx >= 0 ? docs[bestIdx].id : null, best_other_title: bestIdx >= 0 ? docs[bestIdx].title : null,
    margin: Math.round((self - other) * 1000) / 1000, self_is_top: self > other, ms };
}

function quantiles(xs: number[]): Record<string, number> | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return { n: s.length, min: s[0], p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), max: s[s.length - 1] };
}

async function main(): Promise<void> {
  const location = readLibraryLocation();
  if (!location) throw new Error("本机没配资料库（~/.autocrew/storage.json）");
  const dataDir = path.join(location.root, "workspaces", "default");
  await fs.mkdir(OUT_DIR, { recursive: true });
  const { docs, samples } = await loadLibrary(dataDir);
  console.error(`池 ${docs.length} 条稿；样本 ${samples.length} 个（原片 ${samples.filter((s) => s.kind === "aroll").length}、成片 ${samples.filter((s) => s.kind === "cut").length}）；ASR ${ASR_DIR}`);
  const rows: Row[] = [];
  const failures: Array<{ content_id: string; title: string; kind: string; reason: string }> = [];
  for (const s of samples.slice(0, LIMIT)) {
    const t0 = Date.now();
    const heard = await fs.access(s.file).then(() => transcribeHead(s.file), () => ({ ok: false as const, reason: "文件不在了" }));
    if (!heard.ok) { failures.push({ content_id: s.content_id, title: s.title, kind: s.kind, reason: heard.reason }); console.error(`✕ ${s.kind} ${s.title}：${heard.reason}`); continue; }
    const row = scoreRow(s, heard.text, docs, Date.now() - t0);
    rows.push(row);
    console.error(`✓ ${s.kind} ${s.title}：自己 ${row.self} / 别条最高 ${row.best_other} / 差 ${row.margin}（${row.chars} 字，${Math.round(row.ms / 1000)} 秒）`);
  }
  const long = rows.filter((r) => r.chars >= 80);
  const report = {
    at: new Date().toISOString(), library_id: location.id, pool_size: docs.length, clip_seconds: CLIP_SECONDS, asr_timeout_ms: ASR_TIMEOUT,
    samples: samples.length, scored: rows.length, failed: failures.length,
    summary: { self: quantiles(long.map((r) => r.self)), best_other: quantiles(long.map((r) => r.best_other)), margin: quantiles(long.map((r) => r.margin)),
      chars: quantiles(rows.map((r) => r.chars)), self_not_top: rows.filter((r) => !r.self_is_top).map((r) => r.content_id), short_transcripts: rows.filter((r) => r.chars < 80).length },
    rows, failures,
  };
  const out = path.join(OUT_DIR, "calibration.json");
  await fs.writeFile(out, JSON.stringify(report, null, 2) + "\n");
  console.error(`写好了：${out}`);
}

await main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
