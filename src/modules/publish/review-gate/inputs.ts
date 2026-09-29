/**
 * check 的外来参数归一（系统边界）：原话、例外可能被宿主传成 JSON 字符串；能解析就解析，真解析不了才拒，
 * 绝不把「不是数组」当成空数组放过去（AGENTS.md 不变量）。
 */
import { maybeJson } from "./plan.js";
import { normalizePlatform } from "./platforms.js";
import type { Override } from "./types.js";

export type Parsed<T> = { ok: true; value: T } | { ok: false; code: string; error: string };

export function readQuotes(raw: unknown): Parsed<string[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  const v = maybeJson(raw);
  if (typeof v === "string") return { ok: true, value: v.trim() ? [v.trim()] : [] };
  if (!Array.isArray(v) || v.some((q) => typeof q !== "string")) return { ok: false, code: "bad_founder_quotes", error: "founder_quotes 要是字符串数组：创始人关于这次发布的原话，逐字" };
  return { ok: true, value: (v as string[]).map((q) => q.trim()).filter(Boolean) };
}

export function readOverrides(raw: unknown): Parsed<Override[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  const v = maybeJson(raw);
  if (!Array.isArray(v)) return { ok: false, code: "bad_overrides", error: "overrides 要是数组 [{platform, rule, founder_quote}]" };
  const out: Override[] = [];
  for (const [i, o] of v.entries()) {
    const x = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
    const platform = normalizePlatform(x.platform);
    const rule = typeof x.rule === "string" ? x.rule.trim() : "";
    const quote = typeof x.founder_quote === "string" ? x.founder_quote.trim() : "";
    if (!platform || !rule || !quote) return { ok: false, code: "bad_overrides", error: `overrides[${i}] 要有 platform、rule（拦截项里的 rule 名）和 founder_quote（创始人原话，逐字）` };
    out.push({ platform, rule, founder_quote: quote });
  }
  return { ok: true, value: out };
}
