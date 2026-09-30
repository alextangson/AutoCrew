/**
 * 抽帧缝判定（spec 2026-09-30 §4 + §12）：纯函数，零 I/O。输入是时间线快照、成片帧率、A-roll 身份、成片帧数。
 *
 * 1 先建 A-roll 实际显示的帧区间（按 A-roll 素材身份，可跨轨、多段）；没有 A-roll 的空洞（黑帧）不算缝（§12-6）
 * 2 每帧看 A-roll 之上的条目：cover / unknown / 淡入淡出（算露出，E7）；转场期间一律按可能露出（§12-7）
 * 3 露出段长度 1 帧到不足 1 秒（frames × den < num），且前后紧邻的帧都被盖住 → 缝；片头片尾不算（E10）
 * 4 读不准的条目（unknown）分别按「盖住」「没盖住」各算一遍：两种结果一样就是结论，不一样 → 未检查并点名是哪一条（§12-4）
 */
import type { Sliver } from "../../../storage/production-types.js";
import { classifyCover, COVER_TYPES, type Cover } from "./cover-rules.js";
import type { ArollIdentity, Fps, Json, Snapshot } from "./snapshot-types.js";

export interface DetectInput { snap: Snapshot; fps: Fps | null; aroll: ArollIdentity; /** 成片帧数；null = 不做时长对齐（agent 自查） */ cutFrames: number | null }
export interface DetectOutcome { status: "clean" | "slivers" | "unchecked"; slivers: Sliver[]; reason?: string; timeline_frames?: number }

const VISUAL = ["videoItems", "imageItems", "motionGraphicItems", "gifItems", "svgItems", "solidItems", "textItems"];
const HANDLED = new Set([...VISUAL, "audioItems", "audioTransitionItems", "audioEffectItems", "pixelEffectItems", "pixelTransitionItems", "timelineItems"]);
/** A-roll 身份按时长兜底时的容差（微秒）：ChatCut 素材时长与 ffprobe 读数的舍入差 */
const DURATION_TOLERANCE_US = 20_000;

interface Placed { group: string; it: Json; id: string; start: number; end: number; order: number; name: string }
interface Parsed { items: Placed[]; effects: Json[]; transitions: Json[]; orders: Map<string, number> }

const unchecked = (reason: string): DetectOutcome => ({ status: "unchecked", slivers: [], reason });
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const arr = (v: unknown): Json[] | null => (v === undefined ? [] : Array.isArray(v) && v.every((x) => x && typeof x === "object") ? (v as Json[]) : null);

export function timecode(frame: number, fps: Fps): string {
  const nominal = Math.max(1, Math.round(fps.num / fps.den));
  const seconds = (frame * fps.den) / fps.num;
  const whole = Math.floor(seconds + 1e-9);
  const ff = Math.min(nominal - 1, Math.floor((seconds - whole) * nominal + 1e-6));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(whole / 60))}:${p(whole % 60)}:${p(ff)}`;
}

/** 时间线结构：认得出的才往下算；分组 / 嵌套、不认识的条目类型、同轨重叠 → 未检查（§12-6） */
function parse(snap: Snapshot): Parsed | string {
  const tl = snap.timeline;
  const tracks = arr(tl.tracks);
  if (!tracks || !tracks.length) return "时间线格式认不出（没有轨道表）";
  const orders = new Map<string, number>(), hidden = new Set<string>();
  for (const t of tracks) {
    if (typeof t.id !== "string" || typeof t.order !== "number") return "时间线格式认不出（轨道缺 id / order）";
    orders.set(t.id, t.order);
    if (t.hidden === true) hidden.add(t.id);
  }
  const nested = arr(tl.timelineItems);
  if (nested === null || nested.length) return "时间线里有分组 / 嵌套条目，暂不支持";
  const odd = Object.keys(tl).find((k) => k.endsWith("Items") && !HANDLED.has(k) && Array.isArray(tl[k]) && (tl[k] as unknown[]).length);
  if (odd) return `时间线里有不认识的条目类型 ${odd}`;
  const items: Placed[] = [];
  for (const group of VISUAL) {
    const list = arr(tl[group]);
    if (!list) return `时间线格式认不出（${group} 不是列表）`;
    for (const it of list) {
      const start = int(it.startFrame), dur = int(it.durationFrames);
      if (typeof it.id !== "string" || typeof it.trackId !== "string" || !orders.has(it.trackId) || start === null || dur === null || start < 0 || dur <= 0) {
        return `时间线格式认不出（${group} 里有条目缺 id / 轨道 / 帧位置）`;
      }
      if (hidden.has(it.trackId)) continue; // E6：隐藏轨不算
      const asset = typeof it.assetId === "string" ? snap.assets[it.assetId] : undefined;
      items.push({ group, it, id: it.id, start, end: start + dur, order: orders.get(it.trackId)!, name: asset?.name ?? (typeof it.name === "string" ? it.name : it.id) });
    }
  }
  const byTrack = new Map<string, Placed[]>();
  for (const p of items) byTrack.set(String(p.it.trackId), [...(byTrack.get(String(p.it.trackId)) ?? []), p]);
  for (const list of byTrack.values()) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end) return `同一条轨道上有重叠的条目（「${sorted[i - 1].name}」和「${sorted[i].name}」），暂不支持`;
  }
  const effects = arr(tl.pixelEffectItems), transitions = arr(tl.pixelTransitionItems);
  if (!effects || !transitions) return "时间线格式认不出（特效 / 转场不是列表）";
  const live = (x: Json) => x.enabled !== false && typeof x.trackId === "string" && !hidden.has(x.trackId);
  return { items, effects: effects.filter(live), transitions: transitions.filter(live), orders };
}

/** A-roll 条目：sha 或路径对上优先；都对不上时按时长兜底（素材唯一才认） */
function arollItems(items: Placed[], snap: Snapshot, id: ArollIdentity): Placed[] | string {
  const videos = items.filter((p) => p.group === "videoItems");
  const assetOf = (p: Placed) => (typeof p.it.assetId === "string" ? snap.assets[p.it.assetId] : undefined);
  const direct = videos.filter((p) => {
    const a = assetOf(p);
    return Boolean(a && ((a.contentSha256 && id.shas.includes(a.contentSha256)) || (a.path && id.paths.includes(a.path))));
  });
  if (direct.length) return direct;
  const byDuration = videos.filter((p) => {
    const d = assetOf(p)?.duration;
    return typeof d === "number" && id.durationsUs.some((x) => Math.abs(x - d) <= DURATION_TOLERANCE_US);
  });
  const assets = new Set(byDuration.map((p) => String(p.it.assetId)));
  if (assets.size > 1) return "认不出 A-roll：有几个素材的时长都和原片一样";
  return byDuration.length ? byDuration : "认不出 A-roll：时间线里没有和本条原片对得上的素材";
}

interface Frames { end: number; aroll: Float64Array; cover: Int32Array; unknown: Int32Array; transition: Uint8Array; why: Map<number, string> }

function transitionRange(t: Json, items: Placed[]): [number, number] | string {
  const d = int(t.durationFrames);
  if (d === null || d <= 0) return "转场的时长读不出";
  const start = int(t.startFrame);
  if (start !== null) return [start, start + d];
  const incoming = items.find((p) => p.id === t.incomingItemId), outgoing = items.find((p) => p.id === t.outgoingItemId);
  if (!incoming && !outgoing) return "转场找不到两端的条目";
  // 转场与剪切点的对齐方式没有公开：按剪切点前后各一个转场长度保守算「可能露出」
  const cut = incoming ? incoming.start : outgoing!.end;
  return [cut - d, cut + d];
}

function buildFrames(input: DetectInput, parsed: Parsed, arolls: Placed[]): Frames | string {
  const { items } = parsed;
  const end = Math.max(...items.map((p) => p.end));
  const f: Frames = { end, aroll: new Float64Array(end).fill(-Infinity), cover: new Int32Array(end).fill(-1), unknown: new Int32Array(end).fill(-1), transition: new Uint8Array(end), why: new Map() };
  for (const a of arolls) for (let i = a.start; i < a.end; i++) f.aroll[i] = Math.max(f.aroll[i], a.order);
  const targeted = new Set(parsed.effects.map((e) => e.targetItemId).filter((x): x is string => typeof x === "string"));
  const arollIds = new Set(arolls.map((a) => a.id));
  items.forEach((p, idx) => {
    if (arollIds.has(p.id) || !COVER_TYPES[p.group]) return;
    const c: Cover = classifyCover(p.group, p.it, input.snap, targeted.has(p.id));
    if (c.kind === "none") return;
    if (c.kind === "unknown") f.why.set(idx, c.why);
    const fi = int(p.it.fadeInDurationFrames) ?? 0, fo = int(p.it.fadeOutDurationFrames) ?? 0;
    for (let i = p.start; i < Math.min(p.end, end); i++) {
      if (p.order <= f.aroll[i]) continue; // 在 A-roll 之下（或同层），盖不到
      if (i < p.start + fi || i >= p.end - fo) continue; // E7：淡入淡出期间真人若隐若现，算露出
      const slot = c.kind === "cover" ? f.cover : f.unknown;
      if (slot[i] < 0 || items[slot[i]].order < p.order) slot[i] = idx;
    }
  });
  for (const e of parsed.effects) {
    if (typeof e.targetItemId === "string") continue;
    const s = int(e.startFrame), d = int(e.durationFrames), order = parsed.orders.get(String(e.trackId)) ?? -Infinity;
    if (s === null || d === null) return "特效的帧位置读不出";
    // 不挂在条目上的整轨特效：压在 A-roll 之上时，这几帧盖没盖住读不准
    for (let i = Math.max(0, s); i < Math.min(end, s + d); i++) if (order > f.aroll[i] && f.cover[i] >= 0) { f.unknown[i] = f.cover[i]; f.cover[i] = -1; f.why.set(f.unknown[i], "上面压着整轨特效"); }
  }
  for (const t of parsed.transitions) {
    const r = transitionRange(t, items);
    if (typeof r === "string") return r;
    const order = parsed.orders.get(String(t.trackId)) ?? -Infinity;
    for (let i = Math.max(0, r[0]); i < Math.min(end, r[1]); i++) {
      if (order <= f.aroll[i]) continue; // A-roll 轨自己的转场被上面的 B-roll 挡着
      f.transition[i] = 1; f.cover[i] = -1; f.unknown[i] = -1;
    }
  }
  return f;
}

function findSlivers(f: Frames, parsed: Parsed, fps: Fps, optimistic: boolean): Sliver[] {
  const coverAt = (i: number) => (f.cover[i] >= 0 ? f.cover[i] : optimistic && f.unknown[i] >= 0 ? f.unknown[i] : -1);
  // 被盖住优先；没盖住时有 A-roll = 露出，没有 = 黑帧空洞（不算缝，§12-6）
  const state = (i: number) => (coverAt(i) >= 0 ? "cov" : f.aroll[i] === -Infinity ? "black" : "exp");
  const out: Sliver[] = [];
  for (let i = 0; i < f.end;) {
    if (state(i) !== "exp") { i++; continue; }
    let j = i;
    while (j < f.end && state(j) === "exp") j++;
    const n = j - i;
    if (i > 0 && j < f.end && state(i - 1) === "cov" && state(j) === "cov" && n * fps.den < fps.num) {
      const prev = parsed.items[coverAt(i - 1)], next = parsed.items[coverAt(j)];
      const transition = f.transition.subarray(i, j).some((x) => x === 1);
      out.push({ start_frame: i, end_frame: j, frames: n, start_tc: timecode(i, fps), prev_item: prev.id, next_item: next.id, prev_name: prev.name, next_name: next.name, ...(transition ? { transition: true as const } : {}) });
    }
    i = j;
  }
  return out;
}

/** 两种算法结果不一样：点名是哪条读不准的条目让结论悬着 */
function undecided(f: Frames, parsed: Parsed, fps: Fps, a: Sliver[], b: Sliver[]): string {
  const keys = new Set(a.map((s) => `${s.start_frame}-${s.end_frame}`));
  const diff = [...a.filter((s) => !new Set(b.map((x) => `${x.start_frame}-${x.end_frame}`)).has(`${s.start_frame}-${s.end_frame}`)), ...b.filter((s) => !keys.has(`${s.start_frame}-${s.end_frame}`))];
  const s = diff[0];
  let idx = -1;
  for (let i = Math.max(0, s.start_frame - 1); i <= Math.min(f.end - 1, s.end_frame) && idx < 0; i++) idx = f.unknown[i];
  const item = idx >= 0 ? parsed.items[idx] : null;
  return item ? `判断不了 ${timecode(s.start_frame, fps)} 附近是不是缝：「${item.name}」${f.why.get(idx) ?? "读不准"}` : `判断不了 ${timecode(s.start_frame, fps)} 附近是不是缝`;
}

export function detectSlivers(input: DetectInput): DetectOutcome {
  const fps = input.fps;
  if (!fps || !(fps.num > 0) || !(fps.den > 0)) return unchecked("读不出成片帧率");
  const parsed = parse(input.snap);
  if (typeof parsed === "string") return unchecked(parsed);
  if (!parsed.items.length) return unchecked("时间线上没有可见的画面条目");
  const arolls = arollItems(parsed.items, input.snap, input.aroll);
  if (typeof arolls === "string") return unchecked(arolls);
  const frames = buildFrames(input, parsed, arolls);
  if (typeof frames === "string") return unchecked(frames);
  if (input.cutFrames !== null && Math.abs(frames.end - input.cutFrames) > 1) {
    return { ...unchecked(`时间线总长 ${frames.end} 帧和成片 ${input.cutFrames} 帧对不上：导出后时间线改过，或这版成片不是从这条时间线整段导出的`), timeline_frames: frames.end };
  }
  const strict = findSlivers(frames, parsed, fps, false), loose = findSlivers(frames, parsed, fps, true);
  const same = strict.length === loose.length && strict.every((s, i) => s.start_frame === loose[i].start_frame && s.end_frame === loose[i].end_frame);
  if (!same) return { ...unchecked(undecided(frames, parsed, fps, strict, loose)), timeline_frames: frames.end };
  return { status: strict.length ? "slivers" : "clean", slivers: strict, timeline_frames: frames.end };
}
