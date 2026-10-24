/**
 * 英文版的 rebind（spec §9.1）：源视频成片换版后，英文脚本按新成片的字幕重新对位——
 * 中文没变的段原样留着（英文、换例、标黄词都在，时间槽换成新成片的），中文变了 / 新加的段标出来要宿主按新中文核英文；
 * 缩略图留着。脚本批准撤掉、退回「等你拍板」；画面换了，口型对齐和字幕要在新成片上重做：
 * 英文版这条稿的制作轮次结束（旧的英文成片、参考片转入历史），重新配音只会配英文变了的段（按段缓存）。
 */
import { getContent, updateContent } from "../../storage/local-store.js";
import { isOntologyActive, latestScriptDecision, readProductionDoc } from "../../storage/production-store.js";
import { backToReview, commitRebind, noopResult, planRebind } from "../lineage/rebind.js";
import { cutSrtText, diffBriefLines, matchCues } from "../lineage/rebind-diff.js";
import { reopenScript } from "../production/reopen.js";
import { withFileOwnership } from "../production/mutex.js";
import { parseTimedSrt, type SourceCue } from "./source.js";
import { readEnScript, scriptBody, withEnLock, writeEnScript, type Segment } from "./script.js";

type Result = Record<string, unknown>;

/**
 * 每条新字幕归哪一段：对上旧句的跟着旧句那段。没对上的一串新句：夹在两段之间、且中间有整段都没对上的旧段（那段整句改了）→
 * 按顺序分给那几段；没有这样的段就并进前一段（开头的并进后一段）。最后一个都对不上 = -1（整条新加）。
 */
function ownersOf(segs: Segment[], newCues: SourceCue[], m: Map<number, number>): number[] {
  const owner = new Map<number, number>();
  segs.forEach((s, p) => { for (let o = s.cueFrom; o <= s.cueTo; o++) if (m.has(o)) owner.set(m.get(o)!, p); });
  const matched = new Set(owner.values());
  const out = newCues.map((c) => owner.get(c.index) ?? null);
  for (let k = 0; k < out.length;) {
    if (out[k] !== null) { k++; continue; }
    let e = k;
    while (e < out.length && out[e] === null) e++;
    const prev = k > 0 ? out[k - 1]! : -1, next = e < out.length ? out[e]! : segs.length;
    const gap = segs.map((_, p) => p).filter((p) => p > prev && p < next && !matched.has(p));
    for (let j = k; j < e; j++) out[j] = gap.length ? gap[Math.min(Math.floor(((j - k) * gap.length) / (e - k)), gap.length - 1)] : prev >= 0 ? prev : next < segs.length ? next : -1;
    k = e;
  }
  return out as number[];
}

export function remapSegments(segs: Segment[], oldCues: SourceCue[], newCues: SourceCue[]): { segments: Segment[]; dropped: number[] } {
  const m = matchCues(oldCues, newCues);
  const owners = ownersOf(segs, newCues, m);
  const out: Segment[] = [];
  const dropped: number[] = [];
  segs.forEach((s, p) => {
    const mine = newCues.filter((_, k) => owners[k] === p);
    if (!mine.length) { dropped.push(s.index); return; }
    const lostOld = Array.from({ length: s.cueTo - s.cueFrom + 1 }, (_, k) => s.cueFrom + k).some((o) => !m.has(o));
    const gotNew = mine.some((c) => ![...m.values()].includes(c.index));
    const zh = mine.map((c) => c.text).join(" ");
    const { changed: _c, ...rest } = s;
    void _c;
    out.push({ ...rest, index: out.length + 1, cueFrom: mine[0].index, cueTo: mine.at(-1)!.index, zh, startMs: mine[0].startMs, endMs: mine.at(-1)!.endMs,
      ...(lostOld || gotNew || zh !== s.zh ? { changed: "成片换版后这段中文变了" } : {}) });
  });
  if (owners.includes(-1)) {
    const orphan = newCues.filter((_, k) => owners[k] === -1);
    out.push({ index: out.length + 1, cueFrom: orphan[0].index, cueTo: orphan.at(-1)!.index, zh: orphan.map((c) => c.text).join(" "), en: "", startMs: orphan[0].startMs, endMs: orphan.at(-1)!.endMs, swaps: [], changed: "成片换版后新加的一段" });
  }
  return { segments: out, dropped };
}

/** 锁顺序同全库：文件归属事务 → 英文版锁（见 withEnLock）。重开一轮要文件归属，所以先拿它 */
export function rebindEnEditionLocked(id: string, dataDir: string): Promise<Result> {
  return withFileOwnership(() => withEnLock(id, () => rebindEnEdition(id, dataDir)));
}

async function rebindEnEdition(id: string, dataDir: string): Promise<Result> {
  const c = (await getContent(id, dataDir))!;
  const plan = await planRebind(c, dataDir);
  if ("ok" in plan) return plan;
  if (plan.noop) return noopResult(plan.cut);
  const script = await readEnScript(id, dataDir);
  const [oldSrt, newSrt] = await Promise.all([cutSrtText(plan.source, plan.from, dataDir), cutSrtText(plan.source, plan.to, dataDir)]);
  if (script && "error" in oldSrt) return { ok: false, code: "no_source_srt", error: `旧成片的字幕读不出来（${oldSrt.error}），英文脚本没法按句对到新成片上` };
  if (script && "error" in newSrt) return { ok: false, code: "no_source_srt", error: `新成片的字幕读不出来（${newSrt.error}）：先给新成片登记字幕，再 rebind` };
  const reopened = await endProductionRound(id, dataDir);
  if (reopened) return reopened;
  await commitRebind(id, plan, dataDir);
  const remap = script && "text" in oldSrt && "text" in newSrt ? remapSegments(script.segments, parseTimedSrt(oldSrt.text), parseTimedSrt(newSrt.text)) : null;
  if (script && remap) await saveRemapped(id, plan.to, remap.segments, dataDir);
  const moved = await backToReview(id, dataDir);
  return {
    ok: true, rebound: true, diff: plan.diff.summary, diff_lines: diffBriefLines(plan.diff),
    ...(remap ? { segments: remap.segments.length, changed_segments: remap.segments.filter((s) => s.changed).map((s) => s.index), dropped_segments: remap.dropped } : {}),
    kept: "没变的段（英文、换例、标黄词）和缩略图都留着；脚本批准已撤，要重新批",
    ...(moved ? { status_warning: moved } : {}),
    next_action: "op:\"status\" 看对照页：标「成片换版」的段按新中文核英文，重交 set_script（没变的段原样交）→ 创始人重批 → dub（只重配英文变了的段）→ 在新成片上重做口型对齐和字幕（video-session 英文版做法）→ 英文成片重审 → 发布包重交重批",
  };
}

/** 画面换了：英文版这一轮的英文成片 / 参考片都作废，结束本轮（解冻正文，旧的转入历史）；还没进制作段就不用 */
async function endProductionRound(id: string, dataDir: string): Promise<Result | null> {
  const doc = await readProductionDoc(id, dataDir).catch(() => null);
  // 批过的认稿也要结束（Codex 审 P2）：只撤 en-script.json 的批准不够，留着本轮的 script_approval，对账会把状态投影回「已认稿」
  const approved = doc ? latestScriptDecision(doc)?.type === "script_approval" : false;
  const hasRound = doc && (approved || doc.frozen || doc.facts.some((f) => f.round === doc.round && f.state === "accepted"));
  if (!hasRound || !(await isOntologyActive(dataDir, id))) return null;
  const r = await reopenScript(id, dataDir, "源视频成片换版（rebind）：英文成片要在新成片上重做口型对齐和字幕", doc.round);
  return r.ok ? null : { ok: false, code: r.code ?? "reopen_failed", error: `源成片换版，英文版这一轮的英文成片要作废重做，但没能结束这一轮：${r.error ?? "没有原因"}` };
}

async function saveRemapped(id: string, cut: string, segments: Segment[], dataDir: string): Promise<void> {
  const script = { sourceCutHash: cut, segments };
  const c = (await getContent(id, dataDir))!;
  if (scriptBody(script) !== c.body) await updateContent(id, { _provenance: { kind: "model", derivedFrom: c.derivedFrom!.contentId }, body: scriptBody(script) }, dataDir);
  await writeEnScript(id, script, dataDir);
}
