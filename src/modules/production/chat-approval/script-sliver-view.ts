/**
 * 对话里的认稿（draft）与画面闪帧（sliver）：给 agent 看的事实、点名哪一处、服务端写好的 brief。
 * 认稿 brief 里贴全文（创始人 10-11 定：在对话里直接看稿，不给文件链接）。
 */
import { getContent } from "../../../storage/local-store.js";
import { readArticlePackage } from "../../wechat-article/package.js";
import { readEnScript } from "../../en-edition/script.js";
import type { InboxItem } from "../inbox.js";

export interface SliverPoint { key: string; start_tc?: string; frames?: number; prev_name?: string | null; next_name?: string | null; suggestion?: string | null; waived?: boolean; action?: { params?: Record<string, unknown> } }

/** 还没放行的那几处，按检查结果的顺序编号（「第 N 处」就是这里的 number） */
export function openPoints(item: InboxItem): Array<SliverPoint & { number: number }> {
  const all = (item.detail.items as SliverPoint[] | undefined) ?? [];
  return all.filter((p) => !p.waived).map((p, i) => ({ ...p, number: i + 1 }));
}

/** 这件闪帧此刻能做的决定：整条不查只在条目自己给了（没跑成且可整条放行）时有；逐处放行要还有没放行的 */
export function sliverActions(item: InboxItem, all: readonly string[]): string[] {
  return all.filter((d) => d === "waive_sliver_check" ? item.actions.some((a) => a.action === d) : d === "waive_sliver" ? openPoints(item).length > 0 : true);
}

type Sel = { ok: true; params: Record<string, string>; factIds: string[]; label: string } | { ok: false; code: string; error: string };

/** 「第 N 处是故意的」必须点名哪一处（sliver_key）；不止一处又没点名 → 问他，绝不猜 */
export function sliverSelection(item: InboxItem, decision: string, key: string | undefined): Sel {
  const cutFact = String(item.detail.cut_fact_id ?? "");
  if (decision === "reject_cut") return { ok: true, params: { fact_id: cutFact }, factIds: [cutFact], label: "去剪辑里改" };
  if (decision !== "waive_sliver") return { ok: true, params: {}, factIds: [], label: "这条不查了" };
  const open = openPoints(item);
  if (key) {
    const p = open.find((x) => x.key === key);
    return p ? { ok: true, params: { sliver_key: p.key }, factIds: [], label: `第 ${p.number} 处` } : { ok: false, code: "stale", error: `这件事里没有这一处（${key}）还没放行：重新 list 看现在的样子` };
  }
  if (open.length === 1) return { ok: true, params: { sliver_key: open[0].key }, factIds: [], label: "第 1 处" };
  return { ok: false, code: "selector_required", error: `还有 ${open.length} 处没放行：说清是第几处（带 sliver_key）；他说「都是故意的」就逐处各定一次，别猜` };
}

export function sliverFacts(item: InboxItem): Record<string, unknown> {
  const d = item.detail;
  return { status: d.status, reason: d.reason ?? null, cut_fact_id: d.cut_fact_id,
    points: openPoints(item).map((p) => ({ number: p.number, sliver_key: p.key, start_tc: p.start_tc, frames: p.frames, prev_name: p.prev_name ?? null, next_name: p.next_name ?? null, suggestion: p.suggestion ?? null })) };
}

export function draftFacts(item: InboxItem): Record<string, unknown> {
  const d = item.detail;
  return { platform: d.platform ?? null, words: d.words ?? null, ...(d.waiting_behind ? { waiting_behind: d.waiting_behind } : {}) };
}

const BEHIND: Record<string, string> = { cut_review: "成片", cover_pick: "封面" };

const pointLine = (p: SliverPoint & { number: number }) =>
  `第 ${p.number} 处：${p.start_tc ?? "时间未知"}，露出 ${p.frames ?? "?"} 帧真人（${p.prev_name ?? "前一段"} → ${p.next_name ?? "后一段"}）${p.suggestion ? `；建议：${p.suggestion}` : ""}`;

/** 闪帧：查出了什么（或为什么没查成）、逐处列出、怎么回 */
export function sliverBrief(item: InboxItem): string {
  const d = item.detail;
  const open = openPoints(item);
  const waivable = item.actions.some((a) => a.action === "waive_sliver_check");
  const head = d.status === "slivers"
    ? [`《${item.title}》最新一版成片：B-roll 之间有 ${open.length} 处露出了零点几秒的真人画面，看起来像闪了一下。`, ...open.map(pointLine)]
    : [`《${item.title}》最新一版成片：画面闪帧检查没跑成（${String(d.reason ?? "原因不明")}），所以不知道有没有闪一下的地方。`];
  const replies = [waivable ? "「不查了」" : "", open.length ? (open.length > 1 ? "「第 N 处是故意的」/「都是故意的」" : "「这处是故意的」") : "", "「去改：……」"].filter(Boolean);
  return [...head, "这件不处理，成片就不能通过。", `回我${replies.join(" / ")}`].join("\n");
}

/** 认稿：标题、平台、字数、全文；成片 / 封面在等认稿就说一声 */
export async function draftBrief(item: InboxItem, dataDir: string): Promise<string> {
  const c = item.content_id ? await getContent(item.content_id, dataDir) : null;
  const d = item.detail;
  const behind = ((d.waiting_behind as string[] | undefined) ?? []).map((x) => BEHIND[x] ?? x);
  const derived = c?.derivedFrom?.kind;
  const head = derived === "wechat_article" ? await articleHead(c!.id, item.title, dataDir) : `《${item.title}》`;
  const text = derived === "en_edition" ? await bilingualText(c!.id, dataDir) : null;
  return [
    `${head}稿子写好了，过一眼（${String(d.platform ?? "平台未定")}，${String(d.words ?? "?")} 字）`,
    ...(behind.length ? [`${behind.join("和")}已经做好了，在等这份稿认了才能审。`] : []),
    "要你判断：念起来顺不顺、有没有说错的、是不是你想说的。",
    text ? "———— 中英对照（逐段）————" : "———— 全文 ————",
    text ?? (c?.body?.trim() || "（正文是空的）"),
    "———— 完 ————",
    "回我「稿子没问题」/「还要改：……」",
  ].join("\n");
}

/** 派生公众号文章：推送时用的是选定的标题，不是写稿时的工作标题；没选就列候选 */
async function articleHead(id: string, workingTitle: string, dataDir: string): Promise<string> {
  const pkg = await readArticlePackage(id, dataDir).catch(() => null);
  if (pkg?.chosenTitle) return `《${pkg.chosenTitle}》（选定的公众号标题）`;
  const options = pkg?.titleOptions ?? [];
  return options.length ? `《${workingTitle}》（标题还没选，候选：${options.map((t, i) => `${i + 1}. ${t}`).join(" / ")}）` : `《${workingTitle}》（还没有标题候选）`;
}

const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

/** 英文版：逐段中文原句 + 英文 + 换掉的例子（他看中文判断，不只看英文） */
async function bilingualText(id: string, dataDir: string): Promise<string | null> {
  const script = await readEnScript(id, dataDir).catch(() => null);
  if (!script?.segments.length) return null;
  return script.segments.map((g) => [
    `第 ${g.index} 段（${clock(g.startMs)}–${clock(g.endMs)}）${g.changed ? `【成片换版后有变化：${g.changed}】` : ""}`,
    `中：${g.zh}`, `英：${g.en}`,
    ...g.swaps.map((w) => `换例：${w.from} → ${w.to}（${w.reason}）`),
  ].join("\n")).join("\n\n");
}
