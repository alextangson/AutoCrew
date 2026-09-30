/**
 * 读 ChatCut 存在本机的工程文件（spec §3、§5「选时间线」、§12-2 快照）。只读：绝不写 ChatCut 目录，也不调 ChatCut 的 MCP。
 *
 * 工程目录：`<projectsRoot>/<projectId>/project.chatcutproject/`；`project.json` 列时间线与素材（各带 resourcePath），
 * 时间线文件名不是时间线 id，要读文件内的 id 对上。读不了一律返回原因（归类的人话，不透传带路径的底层报错）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isWithin } from "../../../storage/storage-roots.js";
import { runProcess } from "../../video/proc.js";
import { SUPPORTED_SCHEMA, type Fps, type Json, type Snapshot, type SnapshotAsset } from "./snapshot-types.js";

/** 读不了：reason 给创始人看；transient = 临时读错（权限、文件写到一半），下次触发重试 */
export type Read<T> = { ok: true; value: T } | { ok: false; reason: string; transient?: true };

export interface MediaInfo { pix_fmt?: string; r_frame_rate?: string; nb_frames?: number; duration_s?: number }
export type MediaProbe = (file: string) => Promise<MediaInfo | { error: string }>;

export interface ChatcutDeps { projectsRoot?: () => string; media?: MediaProbe }
let deps: ChatcutDeps = {};
/** 测试注入：假的 ChatCut 目录与探针；null 复原 */
export function setChatcutDeps(patch: ChatcutDeps | null): void { deps = patch ? { ...deps, ...patch } : {}; }

export const defaultProjectsRoot = () => path.join(os.homedir(), "Library", "Application Support", "ChatCut", "projects");
const projectsRoot = () => (deps.projectsRoot ?? defaultProjectsRoot)();

const ffprobeMedia: MediaProbe = async (file) => {
  const r = await runProcess({ command: "ffprobe", args: ["-v", "error", "-select_streams", "v:0", "-print_format", "json", "-show_streams", "-show_format", file], timeoutMs: 30_000 });
  if (r.spawnError) return { error: "找不到 ffprobe" };
  if (r.code !== 0) return { error: "ffprobe 读不了这个文件" };
  try {
    const j = JSON.parse(r.stdout) as { streams?: Json[]; format?: Json };
    const s = j.streams?.[0] ?? {};
    const nb = Number(s.nb_frames), dur = Number(s.duration ?? j.format?.duration);
    return { ...(typeof s.pix_fmt === "string" ? { pix_fmt: s.pix_fmt } : {}), ...(typeof s.r_frame_rate === "string" ? { r_frame_rate: s.r_frame_rate } : {}),
      ...(Number.isInteger(nb) && nb > 0 ? { nb_frames: nb } : {}), ...(Number.isFinite(dur) && dur > 0 ? { duration_s: dur } : {}) };
  } catch { return { error: "ffprobe 输出读不出" }; }
};
export const mediaInfo: MediaProbe = (file) => (deps.media ?? ffprobeMedia)(file);

/** r_frame_rate「30000/1001」→ 有理数；读不出 → null */
export function parseRate(v: string | undefined): Fps | null {
  const m = /^(\d+)\/(\d+)$/.exec(v ?? "");
  if (!m || !Number(m[1]) || !Number(m[2])) return null;
  return { num: Number(m[1]), den: Number(m[2]) };
}

/** 成片 / 原片的帧率与帧数（帧数：nb_frames 优先，否则按时长 × 帧率取整） */
export async function videoTiming(file: string): Promise<Read<{ fps: Fps; frames: number | null }>> {
  const info = await mediaInfo(file);
  if ("error" in info) return { ok: false, reason: `读不出成片帧率（${info.error}）`, transient: true };
  const fps = parseRate(info.r_frame_rate);
  if (!fps) return { ok: false, reason: "读不出成片帧率" };
  const frames = info.nb_frames ?? (info.duration_s ? Math.round((info.duration_s * fps.num) / fps.den) : null);
  return { ok: true, value: { fps, frames } };
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

async function readJson(file: string): Promise<Read<Json>> {
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { ok: false, reason: "missing" } : { ok: false, reason: "读 ChatCut 工程文件出错（权限或磁盘）", transient: true };
  }
  try { const v = JSON.parse(raw) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? { ok: true, value: v as Json } : { ok: false, reason: "ChatCut 工程文件格式认不出" }; }
  catch { return { ok: false, reason: "ChatCut 工程文件读出来不是完整的 JSON（可能正在保存）", transient: true }; }
}

/**
 * 工程里 resourcePath 指的文件：真实路径（跟随符号链接之后）必须留在工程目录的真实路径里（Codex 审 sliver P2）。
 * 文件不存在 → 返回词法路径（由读的那一步报「不见了」）；存在但链到工程外 → null。
 */
async function inside(realDir: string, rel: unknown): Promise<string | null> {
  if (typeof rel !== "string" || !rel) return null;
  const abs = path.resolve(realDir, rel);
  if (!isWithin(realDir, abs)) return null;
  const real = await fs.realpath(abs).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? abs : null));
  return real && isWithin(realDir, real) ? real : null;
}

/** 工程目录本身：真实路径必须在 ChatCut 工程根的真实路径下 */
async function projectDir(projectId: string): Promise<Read<string>> {
  const rootReal = await fs.realpath(projectsRoot()).catch(() => null);
  if (!rootReal) return { ok: false, reason: "本机找不到这个 ChatCut 工程（不是 ChatCut 剪的，或本机没装 ChatCut）" };
  const real = await fs.realpath(path.join(rootReal, projectId, "project.chatcutproject")).catch(() => null);
  if (!real) return { ok: false, reason: "本机找不到这个 ChatCut 工程（不是 ChatCut 剪的，或本机没装 ChatCut）" };
  return isWithin(rootReal, real) ? { ok: true, value: real } : { ok: false, reason: "ChatCut 工程目录链到了工程根以外，不读" };
}

export interface LiveTimeline { dir: string; file: string; project: Json; timeline: Json; timeline_id: string; mtime_ms: number }

/** 找工程、认格式版本、选时间线（有 timeline_id 用它；只有一条用它；多条 → 不知道是哪条） */
export async function readTimeline(projectId: string, timelineId?: string): Promise<Read<LiveTimeline>> {
  if (!SAFE_ID.test(projectId)) return { ok: false, reason: "ChatCut 工程 id 不对" };
  const located = await projectDir(projectId);
  if (!located.ok) return located;
  const dir = located.value;
  const projectFile = await inside(dir, "project.json");
  if (!projectFile) return { ok: false, reason: "ChatCut 工程文件链到了工程目录以外，不读" };
  const project = await readJson(projectFile);
  if (!project.ok) return project.reason === "missing" ? { ok: false, reason: "本机找不到这个 ChatCut 工程（不是 ChatCut 剪的，或本机没装 ChatCut）" } : project;
  if (project.value.schemaVersion !== SUPPORTED_SCHEMA) return { ok: false, reason: `ChatCut 工程格式版本（${String(project.value.schemaVersion)}）不认识` };
  const entries = Array.isArray(project.value.timelines) ? (project.value.timelines as Json[]) : null;
  if (!entries?.length) return { ok: false, reason: "ChatCut 工程里没有时间线" };
  if (!timelineId && entries.length > 1) return { ok: false, reason: `ChatCut 工程里有 ${entries.length} 条时间线，不知道是哪条（报工程时带上 timeline_id）` };
  for (const e of entries) {
    const file = await inside(dir, e.resourcePath);
    if (!file) return { ok: false, reason: "ChatCut 时间线路径不对（指到工程目录以外）" };
    const tl = await readJson(file);
    if (!tl.ok) return tl.reason === "missing" ? { ok: false, reason: "ChatCut 时间线文件不见了" } : tl;
    const id = typeof tl.value.id === "string" ? tl.value.id : String(e.id ?? "");
    if (timelineId && id !== timelineId && e.id !== timelineId) continue;
    const st = await fs.stat(file).catch(() => null);
    if (!st) return { ok: false, reason: "ChatCut 时间线文件读不了", transient: true };
    return { ok: true, value: { dir, file, project: project.value, timeline: tl.value, timeline_id: id, mtime_ms: st.mtimeMs } };
  }
  return { ok: false, reason: "ChatCut 工程里没有这条时间线（timeline_id 对不上）" };
}

/**
 * 探素材像素格式（有没有 alpha，§12-4）。没有路径 = 读不到（null，不可重试）；探针失败 = 可重试（probe_failed），
 * 重用快照时会再探（Codex 审 sliver P2）。
 */
export async function probePixFmt(a: SnapshotAsset): Promise<void> {
  delete a.probe_failed;
  if (!a.path) { a.pix_fmt = null; return; }
  const info = await mediaInfo(a.path);
  if ("error" in info) { a.pix_fmt = null; a.probe_failed = true; return; }
  a.pix_fmt = info.pix_fmt ?? null;
}

/** 时间线里画面条目引用的素材 id */
function referencedAssets(tl: Json): Set<string> {
  const ids = new Set<string>();
  for (const [k, v] of Object.entries(tl)) {
    if (!k.endsWith("Items") || !Array.isArray(v)) continue;
    for (const it of v as Json[]) if (typeof it?.assetId === "string") ids.add(it.assetId);
  }
  return ids;
}

function shapeAsset(id: string, a: Json): SnapshotAsset {
  const props = Array.isArray(a.properties) ? (a.properties as Json[]).filter((p) => typeof p?.key === "string")
    .map((p) => ({ key: String(p.key), ...(p.defaultValue !== undefined ? { defaultValue: p.defaultValue } : {}), ...(typeof p.type === "string" ? { type: p.type } : {}) })) : undefined;
  return { id, type: typeof a.type === "string" ? a.type : "unknown", ...(typeof a.name === "string" ? { name: a.name } : {}), ...(typeof a.path === "string" ? { path: a.path } : {}),
    ...(typeof a.contentSha256 === "string" ? { contentSha256: a.contentSha256 } : {}), ...(typeof a.duration === "number" ? { duration: a.duration } : {}), ...(props ? { properties: props } : {}) };
}

/**
 * 时间线 + 它引用的素材元数据 → 快照（只存 JSON）。图片 / 视频素材探一次像素格式（有没有 alpha，§12-4）；
 * 素材文件读不到时 pix_fmt = null，判定时这一条不算盖住。
 */
export async function buildSnapshot(live: LiveTimeline, projectId: string): Promise<Read<Snapshot>> {
  const wanted = referencedAssets(live.timeline);
  const assets: Record<string, SnapshotAsset> = {};
  for (const [k, v] of Object.entries(live.project)) {
    if (!k.endsWith("Assets") || !Array.isArray(v)) continue;
    for (const entry of v as Json[]) {
      if (typeof entry?.id !== "string" || !wanted.has(entry.id)) continue;
      const file = await inside(live.dir, entry.resourcePath);
      if (entry.resourcePath && !file) return { ok: false, reason: "ChatCut 素材元数据路径不对（指到工程目录以外）" };
      const meta = file ? await readJson(file) : null;
      if (meta && !meta.ok && meta.transient) return meta;
      const shaped = shapeAsset(entry.id, meta?.ok ? meta.value : { name: entry.name });
      if (!shaped.name && typeof entry.name === "string") shaped.name = entry.name;
      if (shaped.path) shaped.real_path = await fs.realpath(shaped.path).catch(() => null);
      if (shaped.type === "image" || shaped.type === "video") await probePixFmt(shaped);
      assets[entry.id] = shaped;
    }
  }
  return { ok: true, value: { schemaVersion: Number(live.project.schemaVersion), project_id: projectId, timeline_id: live.timeline_id, timeline: live.timeline, assets } };
}
