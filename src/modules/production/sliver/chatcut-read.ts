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

/** 工程里 resourcePath 指的文件：必须留在工程目录里 */
function inside(dir: string, rel: unknown): string | null {
  if (typeof rel !== "string" || !rel) return null;
  const abs = path.resolve(dir, rel);
  return isWithin(dir, abs) ? abs : null;
}

export interface LiveTimeline { dir: string; file: string; project: Json; timeline: Json; timeline_id: string; mtime_ms: number }

/** 找工程、认格式版本、选时间线（有 timeline_id 用它；只有一条用它；多条 → 不知道是哪条） */
export async function readTimeline(projectId: string, timelineId?: string): Promise<Read<LiveTimeline>> {
  if (!SAFE_ID.test(projectId)) return { ok: false, reason: "ChatCut 工程 id 不对" };
  const dir = path.join(projectsRoot(), projectId, "project.chatcutproject");
  const project = await readJson(path.join(dir, "project.json"));
  if (!project.ok) return project.reason === "missing" ? { ok: false, reason: "本机找不到这个 ChatCut 工程（不是 ChatCut 剪的，或本机没装 ChatCut）" } : project;
  if (project.value.schemaVersion !== SUPPORTED_SCHEMA) return { ok: false, reason: `ChatCut 工程格式版本（${String(project.value.schemaVersion)}）不认识` };
  const entries = Array.isArray(project.value.timelines) ? (project.value.timelines as Json[]) : null;
  if (!entries?.length) return { ok: false, reason: "ChatCut 工程里没有时间线" };
  if (!timelineId && entries.length > 1) return { ok: false, reason: `ChatCut 工程里有 ${entries.length} 条时间线，不知道是哪条（报工程时带上 timeline_id）` };
  for (const e of entries) {
    const file = inside(dir, e.resourcePath);
    if (!file) return { ok: false, reason: "ChatCut 工程格式认不出（时间线路径不对）" };
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
      const file = inside(live.dir, entry.resourcePath);
      const meta = file ? await readJson(file) : null;
      if (meta && !meta.ok && meta.transient) return meta;
      const shaped = shapeAsset(entry.id, meta?.ok ? meta.value : { name: entry.name });
      if (!shaped.name && typeof entry.name === "string") shaped.name = entry.name;
      if (shaped.type === "image" || shaped.type === "video") {
        const info = shaped.path ? await mediaInfo(shaped.path) : { error: "no path" };
        shaped.pix_fmt = "error" in info ? null : info.pix_fmt ?? null;
      }
      assets[entry.id] = shaped;
    }
  }
  return { ok: true, value: { schemaVersion: Number(live.project.schemaVersion), project_id: projectId, timeline_id: live.timeline_id, timeline: live.timeline, assets } };
}
