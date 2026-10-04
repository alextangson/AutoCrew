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
  pageId?: string;
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
  rerun: boolean;
  takeover: boolean;
  citations: unknown;
  claimToken?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const bool = (v: unknown): boolean => v === true || v === "true";

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
    pageId: str(p.page_id),
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
    rerun: bool(p.rerun),
    takeover: bool(p.takeover),
    citations: p.citations,
    claimToken: str(p.claim_token),
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
