/**
 * 英文版的底稿（全媒体 spec §3.1 第 1 条）：源视频审过的那版成片登记的字幕，带每条的起止时间——
 * 英文脚本逐段对这些时间槽。只看成片批准（不等封面，英文版和封面并行）；字幕字节要和登记时的 sha256 对上。
 *
 * 和公众号文章不同：没有登记字幕就不做（英文要按时间槽配音，定稿正文没有时间），原因写明，不退回别的底稿。
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { getContent, type Content } from "../../storage/local-store.js";
import { ontologyApplies } from "../production/publish-gate.js";
import { srtFor, validCutApproval } from "../production/derive.js";
import { factPath } from "../production/chat-approval/files.js";
import { cleanMasterFor } from "../production/clean-master.js";
import { cachedSha } from "../production/hash-cache.js";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import { missingAsNull } from "../publish/review-gate/plan.js";
import type { LedgerEntry } from "../research/evidence-ledger.js";

export interface SourceCue { index: number; startMs: number; endMs: number; text: string }

export interface EnSource {
  sourceId: string;
  cues: SourceCue[];
  ledger: Array<Pick<LedgerEntry, "id" | "source" | "claim" | "quote" | "sourceUrl">>;
}

export type EnSourceResult = { ok: true; source: EnSource } | { ok: false; code: string; error: string };

const TIME = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;
const ms = (m: RegExpExecArray, at: number) => ((Number(m[at]) * 60 + Number(m[at + 1])) * 60 + Number(m[at + 2])) * 1000 + Number(m[at + 3]);

/** SRT → 带起止时间的条目（编号按出现顺序 1 起，不信文件里的序号） */
export function parseTimedSrt(srt: string): SourceCue[] {
  const out: SourceCue[] = [];
  for (const block of srt.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const at = lines.findIndex((l) => TIME.test(l));
    if (at < 0) continue;
    const m = TIME.exec(lines[at])!;
    const text = lines.slice(at + 1).join(" ");
    if (text) out.push({ index: out.length + 1, startMs: ms(m, 1), endMs: ms(m, 5), text });
  }
  return out;
}

export async function enSource(item: Pick<Content, "derivedFrom">, dataDir: string): Promise<EnSourceResult> {
  const from = item.derivedFrom;
  if (from?.kind !== "en_edition") return { ok: false, code: "not_en_edition", error: "这条不是由视频派生的英文版" };
  const src = await getContent(from.contentId, dataDir).catch(missingAsNull);
  if (!src || src.deletedAt) return { ok: false, code: "source_missing", error: `源视频（${from.contentId}）不在了：没有底稿可写` };
  const srt = await registeredSrt(src, dataDir);
  if ("error" in srt) return { ok: false, code: "no_source_srt", error: `${srt.error}：英文版要按成片字幕的时间槽逐段配音，先把这版成片的字幕登记上` };
  const cues = parseTimedSrt(srt.text);
  if (!cues.length) return { ok: false, code: "no_source_srt", error: "登记字幕是空的：英文版没有时间槽可对" };
  const ledger = (src.evidenceLedger?.entries ?? []).map((e) => ({ id: e.id, source: e.source, claim: e.claim, quote: e.quote, sourceUrl: e.sourceUrl }));
  return { ok: true, source: { sourceId: src.id, cues, ledger } };
}

export interface EnPicture { path: string; sha256: string; duration_s: number; fact_id: string }

/**
 * 英文版的画面来源（2026-10-25）：源视频审过的那版成片登记的「无字幕母版」（record kind=clean_master）。
 * 带字幕的成片不能顶——中文字幕会跟着进英文版。没有就拒，next_action 指路去登记。
 */
export async function enPicture(item: Pick<Content, "derivedFrom">, dataDir: string): Promise<{ ok: true; picture: EnPicture } | { ok: false; code: string; error: string; next_action: string }> {
  const from = item.derivedFrom;
  const src = from?.kind === "en_edition" ? await getContent(from.contentId, dataDir).catch(missingAsNull) : null;
  const ask = (error: string) => ({ ok: false as const, code: "no_clean_master", error,
    next_action: `先给源视频（${from?.contentId ?? "?"}）登记无字幕母版：从审过的那条时间线关掉字幕轨、同剪辑同 B-roll 同配乐导出 1920×1080，autocrew_content record kind=clean_master content_id=${from?.contentId ?? "<源视频>"} captions_off=true path=<母版路径>；不要拿带字幕的成片顶` });
  if (!src || src.deletedAt) return ask("源视频不在了，找不到无字幕母版");
  const doc = await readProductionDocOrEmpty(src.id, dataDir);
  const cut = validCutApproval(doc, src.body ?? "");
  if (!cut?.sha256) return ask("源视频的成片现在没有有效的审片通过，无字幕母版无从绑起");
  const fact = cleanMasterFor(doc, cut.sha256);
  if (!fact?.path) return ask("源视频审过的这版成片还没有登记无字幕母版");
  if (fact.availability !== "present") return ask(`登记的无字幕母版文件现在${fact.availability === "missing" ? "不见了" : "读不了"}：找回或重新导出后再登记`);
  const abs = factPath(src.id, fact, dataDir);
  // 对账之前文件可能已被覆盖：按大小 + 修改时间缓存的现算 sha 核一遍，对不上不放行（付费配音前必核）
  let now: string;
  try { now = (await cachedSha(abs)).sha256; } catch { return ask(`登记的无字幕母版文件读不到（${abs}）：找回或重新导出后再登记`); }
  if (now !== fact.sha256) return ask(`登记的无字幕母版文件在登记之后被改过（${abs}）：从审过的时间线重新导出后重新登记`);
  return { ok: true, picture: { path: abs, sha256: fact.sha256!, duration_s: (fact.duration_ms ?? 0) / 1000, fact_id: fact.id } };
}

async function registeredSrt(src: Content, dataDir: string): Promise<{ text: string } | { error: string }> {
  if (!(await ontologyApplies(src, dataDir))) return { error: "源视频走的是旧流程，没有登记字幕" };
  const doc = await readProductionDocOrEmpty(src.id, dataDir);
  const cut = validCutApproval(doc, src.body ?? "");
  if (!cut?.sha256) return { error: "源视频的成片现在没有有效的审片通过" };
  const fact = srtFor(doc, cut.sha256);
  if (!fact?.path) return { error: "审过的这版成片没有登记字幕" };
  try {
    const bytes = await fs.readFile(factPath(src.id, fact, dataDir));
    if (createHash("sha256").update(bytes).digest("hex") !== fact.sha256) return { error: "字幕文件在登记之后被改过" };
    return { text: bytes.toString("utf8") };
  } catch (e) {
    return { error: `登记字幕读不了（${(e as NodeJS.ErrnoException).code ?? (e as Error).message}）` };
  }
}
