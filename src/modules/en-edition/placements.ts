/**
 * 英文时间线上每段配音的实际摆放（2026-10-26 安克首跑）：剪辑补 B-roll 时会在段间插时间，
 * 真实起点 ≠ 配音清单的 startS。字幕和章节按这里登记的起点排；没登记才退回清单（并如实说「按清单排的」）。
 *
 * 文件 en-dub/placements.json：{ dubHash, placements:[{line, start_s}] }，绑配音清单指纹——重新配音后旧摆放作废。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { parseArrayArg } from "../video/tool-args.js";
import { dubDir, type DubManifest } from "./dub.js";

export interface Placement { line: number; start_s: number }
export interface PlacementsFile { dubHash: string; placements: Placement[]; at: string }

/** 配音清单指纹（生成时间不算：同样的配音重排一次不算变） */
export const manifestHash = (m: DubManifest): string => createHash("sha256").update(JSON.stringify({ ...m, createdAt: undefined })).digest("hex");
const file = (id: string, dataDir: string) => path.join(dubDir(id, dataDir), "placements.json");

export async function readPlacements(id: string, dataDir: string): Promise<PlacementsFile | null> {
  try { return JSON.parse(await fs.readFile(file(id, dataDir), "utf8")) as PlacementsFile; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}

/** 解析 + 核对：清单里每段都要有、且只有一次；起点 ≥0 且按段序递增 */
export function parsePlacements(raw: unknown, m: DubManifest): Placement[] | string {
  const list = parseArrayArg(raw, "placements", "交 [{line:段号, start_s:这段在英文时间线上的实际起点秒数}]，每段一条");
  if (typeof list === "string") return list;
  const out: Placement[] = [];
  for (const x of list) {
    const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const line = Number(o.line ?? o.index ?? o.segment), start = Number(o.start_s ?? o.startS ?? o.start);
    if (!Number.isInteger(line) || !Number.isFinite(start) || start < 0) return `每条要 {line:段号, start_s:≥0 的秒数}，收到 ${JSON.stringify(x)}`;
    out.push({ line, start_s: Math.round(start * 1000) / 1000 });
  }
  const want = m.lines.map((l) => l.index);
  const got = out.map((p) => p.line);
  if (got.length !== want.length || want.some((i) => !got.includes(i))) return `要给配音清单里全部 ${want.length} 段（${want.join(",")}）各一条，收到 ${got.join(",") || "空"}`;
  out.sort((a, b) => a.line - b.line);
  for (let i = 1; i < out.length; i++) {
    if (out[i].start_s < out[i - 1].start_s) return `第 ${out[i].line} 段起点 ${out[i].start_s}s 早于第 ${out[i - 1].line} 段 ${out[i - 1].start_s}s：按段序递增`;
  }
  return out;
}

export async function savePlacements(id: string, m: DubManifest, placements: Placement[], dataDir: string): Promise<string> {
  const f = file(id, dataDir);
  await writeJsonAtomic(f, { dubHash: manifestHash(m), placements, at: new Date().toISOString() } satisfies PlacementsFile);
  return f;
}

export type PlacedManifest = { m: DubManifest; source: "placements" | "dub_manifest"; placementsHash: string | null } | { error: string };

/**
 * 字幕 / 章节要用的清单：登记了摆放 → 每段（连同字级时间）平移到实际起点；没登记 → 原清单；
 * 登记了但配音后来重做过 → 报错（旧摆放对不上新音频，不静默退回清单）。
 */
export async function placedManifest(id: string, m: DubManifest, dataDir: string): Promise<PlacedManifest> {
  const p = await readPlacements(id, dataDir);
  if (!p) return { m, source: "dub_manifest", placementsHash: null };
  if (p.dubHash !== manifestHash(m)) return { error: "登记的实际摆放是按旧配音做的（之后重新配过音）：按现在的英文时间线重新 op:\"set_placements\"" };
  const lines = m.lines.map((l) => {
    const at = p.placements.find((x) => x.line === l.index);
    if (!at) return l;
    const d = at.start_s - l.startS;
    const r = (n: number) => Math.round((n + d) * 1000) / 1000;
    return { ...l, startS: r(l.startS), endS: r(l.endS), words: l.words.map((w) => ({ ...w, startS: r(w.startS), endS: r(w.endS) })) };
  });
  const placementsHash = createHash("sha256").update(JSON.stringify(p.placements)).digest("hex");
  return { m: { ...m, lines, dubEndS: lines.at(-1)?.endS ?? m.dubEndS }, source: "placements", placementsHash };
}

export const PLACEMENT_FALLBACK_NOTE = "没登记实际摆放：时间按配音清单排（假定画面和配音同步、段间没插 B-roll）。补过 B-roll 的话先 op:\"set_placements\" 登记每段在英文时间线上的实际起点再出";
