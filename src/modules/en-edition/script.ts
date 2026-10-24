/**
 * 英文版的双语脚本（全媒体 spec §3.1 第 1–2 条、§3.3「Script」）：逐段对上源成片的字幕时间槽，
 * 每段 = 中文原句（取自审过的成片字幕，不由宿主改写）+ 英文 + 时间槽 + 换掉的例子（原例 → 替换例 + 理由）。
 *
 * 落在英文版稿件项目里的 `en-script.json`。批准 = 整份脚本的指纹（artifact-approval）：任何一段的中英文、
 * 时间槽、换例、关键词变了，批准就失效；配音只按批过的那份做。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { contentRoot, projectFile } from "../../storage/content-project.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { artifactHash, type ArtifactApproval } from "../lineage/artifact-approval.js";

export const SCRIPT_ARTIFACT = "英文版双语脚本";
/** 英文口播语速估算（词 / 秒）：约 156 词每分钟，放松的口播语速 */
export const EN_WORDS_PER_SECOND = 2.6;
/** 估算时长超过时间槽这么多倍就提醒（和画面最多放慢 1.15 倍同一个口径） */
export const BUDGET_TOLERANCE = 1.15;

export interface Swap {
  /** 原例（中文观众熟悉的） */
  from: string;
  /** 替换例（西方观众熟悉的） */
  to: string;
  reason: string;
  /** 替换例带了事实（数字、谁做了什么、产品功能）：要有核过的出处 */
  factual?: boolean;
  /** 出处：英文版稿件或源视频证据台账里的编号（verify_quote 回的 evidence_id） */
  evidenceId?: string;
}

export interface Segment {
  /** 1 起 */
  index: number;
  /** 对应源字幕第几条到第几条（1 起，含两端） */
  cueFrom: number;
  cueTo: number;
  zh: string;
  en: string;
  startMs: number;
  endMs: number;
  swaps: Swap[];
  /** 字幕里标黄的那一个词组（必须出现在 en 里）；每段最多一个 */
  keyword?: string;
  /** 源成片换版后 rebind 标的：这段对应的中文变了 / 是新的一段（人话）；宿主按新中文重写、重交 set_script 后就没有了 */
  changed?: string;
}

export interface EnScript {
  /** 写这份脚本时源成片的身份：和派生时记的不一样就是过期 */
  sourceCutHash: string;
  segments: Segment[];
  approval?: ArtifactApproval;
}

function file(contentId: string, dataDir?: string): string {
  return projectFile(contentRoot(contentId, dataDir), "en-script.json");
}

export async function readEnScript(contentId: string, dataDir?: string): Promise<EnScript | null> {
  try {
    return JSON.parse(await fs.readFile(file(contentId, dataDir), "utf-8")) as EnScript;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`英文脚本读不出来（${(e as Error).message}）`);
  }
}

export async function writeEnScript(contentId: string, script: EnScript, dataDir?: string): Promise<void> {
  const target = file(contentId, dataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await writeJsonAtomic(target, script);
}

/** 批准绑定的指纹：只算内容（批准本身不进指纹） */
export function scriptHash(script: Pick<EnScript, "sourceCutHash" | "segments">): string {
  return artifactHash({ sourceCutHash: script.sourceCutHash, segments: script.segments as unknown as Record<string, unknown>[] });
}

/** 英文版稿件的正文 = 各段英文（认稿 / 成片审核的正文指纹都按它算） */
export function scriptBody(script: Pick<EnScript, "segments">): string {
  return script.segments.map((s) => s.en).join("\n\n");
}

export const wordCount = (en: string): number => en.split(/\s+/).filter(Boolean).length;

/** 这段英文念出来大概多少秒 */
export function estimatedSeconds(en: string): number {
  return wordCount(en) / EN_WORDS_PER_SECOND;
}

/** 每段的时间预算：槽长、估算时长、是不是大概率超 */
export function segmentBudget(s: Segment): { slotS: number; estimatedS: number; over: boolean } {
  const slotS = (s.endMs - s.startMs) / 1000;
  const estimatedS = Math.round(estimatedSeconds(s.en) * 100) / 100;
  return { slotS, estimatedS, over: estimatedS > slotS * BUDGET_TOLERANCE };
}

/** 不能批的原因（逐条人话）；evidence = 能当出处的台账编号 */
export function scriptProblems(script: EnScript, evidence: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (!script.segments.length) out.push("脚本是空的：先 set_script");
  for (const s of script.segments) {
    const at = `第 ${s.index} 段`;
    if (s.changed) out.push(`${at}${s.changed}：按新中文核一遍英文，重交 set_script（没改的段原样交）`);
    if (!s.en.trim()) out.push(`${at}没有英文`);
    if (/[一-鿿]/.test(s.en)) out.push(`${at}英文里夹着中文：配音会念错，改成英文`);
    if (s.keyword && !s.en.includes(s.keyword)) out.push(`${at}的标黄词「${s.keyword}」不在英文里`);
    for (const w of s.swaps) {
      if (!w.from.trim() || !w.to.trim() || !w.reason.trim()) out.push(`${at}有一处换例缺原例 / 替换例 / 理由`);
      else if (w.factual && !(w.evidenceId && evidence.has(w.evidenceId))) {
        out.push(`${at}的替换例「${w.to}」带了事实但没有核过的出处（unverified）：先 verify_quote 拿 evidence_id 填上，或者去掉这处替换`);
      }
    }
  }
  return out;
}

const locks = new Map<string, Promise<unknown>>();

/** 同一条英文版的脚本改动、配音与批准排队执行：批的那一刻脚本不会被另一个调用改掉 */
export function withEnLock<T>(contentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(contentId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(contentId, tail);
  void tail.then(() => { if (locks.get(contentId) === tail) locks.delete(contentId); });
  return run;
}
