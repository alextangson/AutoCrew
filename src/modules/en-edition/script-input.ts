/**
 * set_script 的参数归一（AGENTS.md：模型交的数组 / 对象可能是 JSON 字符串，序号可能是字符串数字）。
 * 每段写 `cues`（源字幕第几条，"3" / "3-5" / [3,5] / 3 都认）+ `en`；中文原句和时间槽由源字幕给，宿主不能改。
 * 段与段按字幕顺序、不重叠、不跳号（每条字幕都要归到某一段），否则整份拒。
 */
import { asIndex, parseArrayArg } from "../video/tool-args.js";
import type { Segment, Swap } from "./script.js";
import type { SourceCue } from "./source.js";

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function cueRange(v: unknown): [number, number] | null {
  if (Array.isArray(v) && v.length >= 1 && v.length <= 2) {
    const a = asIndex(v[0]), b = asIndex(v[v.length - 1]);
    return a !== null && b !== null ? [a, b] : null;
  }
  const one = asIndex(v);
  if (one !== null) return [one, one];
  const m = /^\s*(\d+)\s*[-–~]\s*(\d+)\s*$/.exec(typeof v === "string" ? v : "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function readSwaps(v: unknown, at: string): Swap[] | string {
  if (v === undefined || v === null || v === "") return [];
  const list = parseArrayArg(v, `${at} swaps`, "没有换例就不写 swaps");
  if (typeof list === "string") return list;
  const out: Swap[] = [];
  for (const x of list) {
    if (!x || typeof x !== "object") return `${at} swaps 每项要是 {from, to, reason, factual?, evidence_id?}`;
    const o = x as Raw;
    const factual = o.factual === true || o.factual === "true";
    const evidenceId = str(o.evidence_id ?? o.evidenceId);
    out.push({ from: str(o.from), to: str(o.to), reason: str(o.reason), ...(factual ? { factual } : {}), ...(evidenceId ? { evidenceId } : {}) });
  }
  return out;
}

function readOne(x: unknown, i: number, cues: SourceCue[]): Segment | string {
  const at = `第 ${i + 1} 段`;
  const o = typeof x === "string" ? (() => { try { return JSON.parse(x) as unknown; } catch { return null; } })() : x;
  if (!o || typeof o !== "object" || Array.isArray(o)) return `${at}要是 {cues, en, swaps?, keyword?}`;
  const r = o as Raw;
  const range = cueRange(r.cues ?? r.cue);
  if (!range || range[0] < 1 || range[1] < range[0] || range[1] > cues.length) return `${at}的 cues 要是源字幕的条号范围（1–${cues.length}），如 "3-5"`;
  const swaps = readSwaps(r.swaps, at);
  if (typeof swaps === "string") return swaps;
  const picked = cues.slice(range[0] - 1, range[1]);
  const keyword = str(r.keyword);
  return {
    index: i + 1, cueFrom: range[0], cueTo: range[1], zh: picked.map((c) => c.text).join(" "), en: str(r.en),
    startMs: picked[0].startMs, endMs: picked[picked.length - 1].endMs, swaps, ...(keyword ? { keyword } : {}),
  };
}

export function buildSegments(raw: unknown, cues: SourceCue[]): Segment[] | string {
  const list = parseArrayArg(raw, "segments", "按源字幕逐段给 [{cues:\"1-2\", en:\"...\"}, ...]");
  if (typeof list === "string") return list;
  const out: Segment[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = readOne(list[i], i, cues);
    if (typeof s === "string") return s;
    const expected = (out.at(-1)?.cueTo ?? 0) + 1;
    if (s.cueFrom !== expected) return `第 ${i + 1} 段从第 ${s.cueFrom} 条字幕开始，应该接着第 ${expected} 条：段要按字幕顺序、不重叠、不跳号`;
    out.push(s);
  }
  if (!out.length) return "segments 是空的";
  if (out.at(-1)!.cueTo !== cues.length) return `最后一段停在第 ${out.at(-1)!.cueTo} 条，源字幕有 ${cues.length} 条：每条都要归到某一段（不念的就并进相邻段）`;
  return out;
}
