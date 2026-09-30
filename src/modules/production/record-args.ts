/**
 * record 参数正规化（spec §3、E11；AGENTS.md「模型的工具参数不保证类型对」）：
 * 中转端点会把数组 / 数字序列化成字符串，有时内层引号还没转义。数组照用；字符串先 JSON 解析、
 * 修引号再试、最后按逗号拆；只有真解析不了才拒——绝不把解析失败当成空数组。
 */
import type { CoverRatio, FactKind } from "../../storage/production-types.js";

export const RECORD_KINDS: readonly FactKind[] = ["aroll", "cut", "srt", "cover", "chatcut_project", "publish", "storyboard"];

export interface RecordArgs {
  content_id: string;
  kind: FactKind;
  request_id: string;
  path?: string;
  ratio?: CoverRatio;
  version?: number;
  cover_text?: string;
  for_cut?: string;
  uses_aroll?: string[];
  chatcut_project_id?: string;
  timeline_id?: string;
  note?: string;
  /** kind=publish（模型报的发布回执 = 待核） */
  platform?: string;
  account?: string;
  url?: string;
  item_id?: string;
  host: string;
  session?: string;
  /** kind=cut：agent 标「可以审了」（review-inbox §7-1） */
  review?: boolean;
  /** kind=cover：一次记一组 [3:4, 4:3]（§6.1） */
  paths?: string[];
  /** kind=cover：和这条封面事实成对（§6.1） */
  pair_with?: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: string; error: string };

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);

/** 数组参数：数组 / JSON 字符串 / 引号坏了的 JSON / 逗号分隔都认 */
export function parseList(v: unknown): Parsed<string[] | undefined> {
  if (v === undefined || v === null || v === "") return { ok: true, value: undefined };
  if (Array.isArray(v)) return { ok: true, value: v.map((x) => String(x).trim()).filter(Boolean) };
  if (typeof v !== "string") return { ok: false, code: "bad_param", error: `uses_aroll 要是 fact id 数组，收到的是 ${typeof v}` };
  const s = v.trim();
  for (const attempt of [s, s.replace(/'/g, '"'), s.replace(/\\"/g, '"')]) {
    try {
      const parsed = JSON.parse(attempt) as unknown;
      if (Array.isArray(parsed)) return { ok: true, value: parsed.map((x) => String(x).trim()).filter(Boolean) };
      if (typeof parsed === "string") return { ok: true, value: [parsed.trim()].filter(Boolean) };
    } catch { /* 换下一种修法 */ }
  }
  const loose = s.replace(/^\[|\]$/g, "").split(/[,，\s]+/).map((x) => x.replace(/^["']+|["']+$/g, "").trim()).filter(Boolean);
  if (loose.length && loose.every((x) => /^[A-Za-z0-9_-]+$/.test(x))) return { ok: true, value: loose };
  return { ok: false, code: "bad_param", error: `uses_aroll 解析不了：${s.slice(0, 80)}` };
}

export function parseRatio(v: unknown): Parsed<CoverRatio | undefined> {
  const s = str(v);
  if (!s) return { ok: true, value: undefined };
  const m = /^\s*([34])\s*[:：xX×/]\s*([34])\s*$/.exec(s);
  const r = m ? `${m[1]}:${m[2]}` : null;
  if (r === "3:4" || r === "4:3") return { ok: true, value: r };
  return { ok: false, code: "bad_param", error: `ratio 只能是 3:4 或 4:3，收到 ${s}` };
}

function parseVersion(v: unknown): Parsed<number | undefined> {
  const s = str(v);
  if (!s) return { ok: true, value: undefined };
  const n = Number(s.replace(/^v0*/i, ""));
  return Number.isInteger(n) && n > 0 && n < 1000 ? { ok: true, value: n } : { ok: false, code: "bad_param", error: `version 要是正整数，收到 ${s}` };
}

/** 布尔参数可能被当字符串传来 */
export function parseBool(v: unknown): boolean | undefined {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  return undefined;
}

/** 路径数组：数组照用；字符串先 JSON 解析（修引号），解析不了才拒，不按逗号拆（路径里可能有逗号） */
export function parsePaths(v: unknown): Parsed<string[] | undefined> {
  if (v === undefined || v === null || v === "") return { ok: true, value: undefined };
  if (Array.isArray(v)) return { ok: true, value: v.map((x) => String(x).trim()).filter(Boolean) };
  if (typeof v !== "string") return { ok: false, code: "bad_param", error: `paths 要是路径数组，收到的是 ${typeof v}` };
  for (const attempt of [v.trim(), v.trim().replace(/'/g, '"'), v.trim().replace(/\\"/g, '"')]) {
    try { const j = JSON.parse(attempt) as unknown; if (Array.isArray(j)) return { ok: true, value: j.map((x) => String(x).trim()).filter(Boolean) }; } catch { /* 换下一种 */ }
  }
  return { ok: false, code: "bad_param", error: `paths 解析不了（要是 ["3:4 路径","4:3 路径"]）：${v.slice(0, 80)}` };
}

export function normalizeRecordArgs(params: Record<string, unknown>): Parsed<RecordArgs> {
  const content_id = str(params.content_id) ?? str(params.id);
  if (!content_id) return { ok: false, code: "bad_param", error: "record 要带 content_id" };
  const kind = str(params.kind) as FactKind | undefined;
  if (!kind || !RECORD_KINDS.includes(kind)) return { ok: false, code: "bad_param", error: `kind 只能是 ${RECORD_KINDS.join(" / ")}` };
  const request_id = str(params.request_id);
  if (!request_id || !/^[A-Za-z0-9_.:-]{1,100}$/.test(request_id)) return { ok: false, code: "bad_param", error: "record 要带 request_id（1–100 位字母数字 _ - . :），重试时用同一个" };
  const ratio = parseRatio(params.ratio);
  if (!ratio.ok) return ratio;
  const version = parseVersion(params.version);
  if (!version.ok) return version;
  const uses = parseList(params.uses_aroll);
  if (!uses.ok) return uses;
  const host = typeof params._host === "string" && params._host.trim() ? params._host.trim() : "local-user";
  const out: RecordArgs = { content_id, kind, request_id, host };
  const opt = { path: str(params.path), cover_text: str(params.cover_text), for_cut: str(params.for_cut), chatcut_project_id: str(params.chatcut_project_id), timeline_id: str(params.timeline_id), note: str(params.note), session: str(params._session),
    platform: str(params.platform), account: str(params.account), url: str(params.url), item_id: str(params.item_id) };
  for (const [k, v] of Object.entries(opt)) if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  if (ratio.value) out.ratio = ratio.value;
  if (version.value) out.version = version.value;
  if (uses.value) out.uses_aroll = uses.value;
  const paths = parsePaths(params.paths);
  if (!paths.ok) return paths;
  if (paths.value) {
    if (kind !== "cover") return { ok: false, code: "bad_param", error: "paths 只用于 kind=cover（一次记一组 3:4 + 4:3）" };
    if (paths.value.length !== 2) return { ok: false, code: "bad_param", error: `paths 要正好两张：[3:4 路径, 4:3 路径]，收到 ${paths.value.length} 张` };
    out.paths = paths.value;
  }
  const pair = str(params.pair_with);
  if (pair) {
    if (kind !== "cover" || out.paths) return { ok: false, code: "bad_param", error: "pair_with 只用于单张 kind=cover（和 paths 二选一）" };
    out.pair_with = pair;
  }
  if (parseBool(params.review) === true) {
    if (kind !== "cut") return { ok: false, code: "bad_param", error: "review=true 只用于 kind=cut（成片可以审了）" };
    out.review = true;
  }
  return { ok: true, value: out };
}
