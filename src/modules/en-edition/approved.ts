/**
 * 「批过的那份」的统一核对：配音、字幕、章节、英文发布包都只认——脚本已批、指纹对得上、源没过期、
 * 稿件正文就是脚本的英文；配音清单是按这份脚本做的且没被拒。
 */
import { readDubManifest, type DubManifest } from "./dub.js";
import { enReviewState, type EnReviewState } from "./review.js";
import { scriptBody } from "./script.js";

export type Refusal = { ok: false; code: string; error: string };
const no = (code: string, error: string): { no: Refusal } => ({ no: { ok: false, code, error } });

export async function approvedEnState(id: string, dataDir: string): Promise<{ s: EnReviewState } | { no: Refusal }> {
  const s = await enReviewState(id, dataDir, { fresh: true });
  if ("error" in s) return no(s.code, s.error);
  if (s.stale) return no("derived_stale", `这条英文版过期了：${s.stale}`);
  if (!s.approval.ok) return no("script_not_approved", `英文脚本${s.script.approval ? `的批准已失效：${s.approval.reason}` : "还没批"}：先在「等你拍板」里请创始人批`);
  if ((s.content.body ?? "") !== scriptBody(s.script)) return no("body_script_mismatch", "稿件正文和批过的英文脚本对不上（正文被别的写口改过）：重新 set_script 并重新请创始人批");
  return { s };
}

export async function currentEnManifest(id: string, s: EnReviewState, dataDir: string): Promise<{ m: DubManifest } | { no: Refusal }> {
  let m: DubManifest | null;
  try { m = await readDubManifest(id, dataDir); }
  catch (e) { return no("dub_unreadable", `配音清单读不出来（${e instanceof Error ? e.message : String(e)}）：重新 op:"dub"`); }
  if (!m) return no("no_dub", "还没配音：先 op:\"dub\"");
  if (m.scriptHash !== s.hash) return no("dub_stale", "配音是按旧脚本做的（脚本批准后改过）：重新 op:\"dub\"");
  if (m.refused) return no("overrun_too_long", m.refused);
  return { m };
}
