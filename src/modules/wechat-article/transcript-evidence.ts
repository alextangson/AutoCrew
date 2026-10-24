/**
 * 派生公众号文章的数字出处（全媒体 verifier P2）：写手被要求「数字只用底稿里有的」，底稿就是源视频审过的成片字幕——
 * 字幕里逐字出现的数字（如 370 次）要能过数字门。做法：交稿过门时，把底稿里带数字的那几行字幕各记一条账（own_claim，
 * id 写明来自哪条源视频的成片字幕第几行），数字门照常按「同值同单位」比对，别的数字照旧拦。
 * 底稿不是成片字幕（旧流程 / 没登记字幕而退回定稿正文）时一条都不加——那不是成片转写。
 */
import type { Content } from "../../storage/local-store.js";
import type { EvidenceLedger } from "../research/evidence-ledger.js";
import { articleSource } from "./source.js";

export const TRANSCRIPT_CLAIM = "源视频审过的成片字幕（公众号文章的底稿）原句";

export async function seedLedgerFromSourceTranscript(content: Pick<Content, "derivedFrom">, ledger: EvidenceLedger, dataDir: string): Promise<number> {
  if (content.derivedFrom?.kind !== "wechat_article") return 0;
  const s = await articleSource(content, dataDir);
  if (!s.ok || s.source.kind !== "srt") return 0;
  let n = 0;
  s.source.text.split("\n").forEach((line, i) => {
    if (!/\d/.test(line)) return;
    ledger.add({ id: `srt:${s.sourceId}:${i + 1}`, source: "own_claim", claim: TRANSCRIPT_CLAIM, quote: line.trim() });
    n++;
  });
  return n;
}
