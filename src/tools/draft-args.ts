/** autocrew_draft 的参数整理：模型传来的参数不保证类型对（中转会把数组变成字符串），这里统一归一 */
import { LOCAL_HOST } from "../storage/local-store.js";
import { maybeJson, UNPARSABLE } from "../modules/publish/review-gate/plan.js";

export interface DraftArgs {
  action: string;
  host: string;
  session: string;
  dataDir?: string;
  contentId?: string;
  inspiration?: string;
  platform?: string;
  url?: string;
  quote?: string;
  claim?: string;
  mainLine?: string;
  forWhom?: string;
  opening?: string;
  whyViral?: string;
  chain: unknown;
  founderWords?: string;
  title?: string;
  body?: string;
  note?: string;
  citations: unknown;
  /** 读到的版本号；save / angle / prepare_final 必带 */
  baseVersion?: number;
  /** Codex 审稿意见（文字或结构）；INVALID = 传了但解析不了 */
  reviewNotes?: string | Record<string, unknown> | unknown[] | typeof INVALID;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** 版本号：数字或数字字符串（中转会把数字变字符串）；别的当没传 */
const intOf = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined;
};
export const INVALID: unique symbol = Symbol("invalid-arg");
const NOTES_MAX = 20_000;
/** 审稿意见：对象 / 数组直接用；像 JSON 的字符串解析（修引号重试）；普通文字照存；别的类型或解析不了 → INVALID */
function notesOf(raw: unknown): DraftArgs["reviewNotes"] {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const v = maybeJson(raw);
  if (v === UNPARSABLE) return INVALID;
  if (typeof v === "string") return v.slice(0, NOTES_MAX);
  if (typeof v === "object" && v !== null && JSON.stringify(v).length <= NOTES_MAX) return v as Record<string, unknown> | unknown[];
  return INVALID;
}

export function draftArgs(p: Record<string, unknown>): DraftArgs {
  return {
    action: String(p.action ?? ""),
    host: str(p._host) ?? LOCAL_HOST,
    session: str(p._session) ?? "unknown",
    dataDir: str(p._dataDir),
    contentId: str(p.content_id),
    inspiration: str(p.inspiration),
    platform: str(p.platform),
    url: str(p.url),
    quote: typeof p.quote === "string" ? p.quote : undefined,
    claim: str(p.claim),
    mainLine: str(p.main_line),
    forWhom: str(p.for_whom),
    opening: str(p.opening),
    whyViral: str(p.why_viral),
    chain: p.chain,
    founderWords: str(p.founder_words),
    title: str(p.title),
    body: typeof p.body === "string" ? p.body : undefined,
    note: str(p.note),
    citations: p.citations,
    baseVersion: intOf(p.base_version),
    reviewNotes: notesOf(p.review_notes),
  };
}

/** 论证链：数组直接用；像 JSON 的字符串解析（修引号重试），普通字符串按行切；别的类型报错（不悄悄当空） */
export function normalizeChain(raw: unknown): string[] | null {
  let v = maybeJson(raw);
  if (v === UNPARSABLE) return null;
  if (typeof v === "string") v = v.split(/\n+/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, ""));
  if (!Array.isArray(v)) return null;
  return v.map((x) => String(x ?? "").trim()).filter(Boolean);
}
