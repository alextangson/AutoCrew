/**
 * 把作品拼成数据页的行（数据页规格 §F.33–36）。纯函数：输入作品、稿件、手动决定，输出行。
 */
import type { LinkDecision } from "./outcome-links.js";
import {
  effectiveDecisions, latest, matchScore, titlesSimilar,
  type ContentRef, type DataRow, type Work,
} from "./data-rows.js";

interface Group { works: Work[]; contentId: string | null; manual: boolean; auto: boolean; decisions: LinkDecision[] }

class Groups {
  readonly byContent = new Map<string, Group>();
  readonly loose: Group[] = [];
  private readonly byWork = new Map<string, Group>();

  forContent(id: string): Group {
    let g = this.byContent.get(id);
    if (!g) { g = { works: [], contentId: id, manual: false, auto: false, decisions: [] }; this.byContent.set(id, g); }
    return g;
  }
  newLoose(): Group {
    const g: Group = { works: [], contentId: null, manual: false, auto: false, decisions: [] };
    this.loose.push(g);
    return g;
  }
  add(g: Group, w: Work, how: "manual" | "auto" | "none", d?: LinkDecision): void {
    g.works.push(w);
    if (how === "manual") g.manual = true;
    if (how === "auto") g.auto = true;
    if (d && !g.decisions.includes(d)) g.decisions.push(d);
    this.byWork.set(w.key, g);
  }
  of(key: string): Group | undefined { return this.byWork.get(key); }
}

/** 一条作品最像哪条稿件；两条稿件一样像 = 不猜，留给人 */
function bestContent(w: Work, contents: ContentRef[]): { id: string; score: number } | null {
  if (w.importedContentId && contents.some((c) => c.id === w.importedContentId)) return { id: w.importedContentId, score: 4 };
  let best: { id: string; score: number } | null = null, tie = false;
  for (const c of contents) {
    const s = matchScore(w, c);
    if (s === 0) continue;
    if (!best || s > best.score) { best = { id: c.id, score: s }; tie = false; }
    else if (s === best.score) tie = true;
  }
  return tie ? null : best;
}

/** 自动关联：分高的先占位；同一稿件同一平台只挂一条作品。返回没挂上的 */
function autoLink(works: Work[], contents: ContentRef[], groups: Groups): Work[] {
  const scored = works.map((w) => ({ w, m: bestContent(w, contents) }));
  scored.sort((a, b) => (b.m?.score ?? 0) - (a.m?.score ?? 0));
  const left: Work[] = [];
  for (const { w, m } of scored) {
    if (!m || groups.byContent.get(m.id)?.works.some((x) => x.platform === w.platform)) { left.push(w); continue; }
    groups.add(groups.forContent(m.id), w, "auto");
  }
  return left;
}

/** 没稿件的老视频：同一天 + 标题相近合成一行，同一行里一个平台只放一条（§35） */
function groupOld(works: Work[], groups: Groups): void {
  const sorted = [...works].sort((a, b) => (a.day ?? "").localeCompare(b.day ?? "") || a.platform.localeCompare(b.platform));
  const made: Group[] = [];
  for (const w of sorted) {
    const g = w.day ? made.find((x) => x.works[0].day === w.day
      && !x.works.some((y) => y.platform === w.platform)
      && x.works.some((y) => titlesSimilar(y.title, w.title))) : undefined;
    if (g) { groups.add(g, w, "none"); continue; }
    const fresh = groups.newLoose();
    groups.add(fresh, w, "none");
    made.push(fresh);
  }
}

/** 「和上一行是同一条」：并到目标作品所在那一行；目标自己也在等合并时多轮处理，环或目标不在 → 自成一行 */
function applyMerges(pending: Array<{ w: Work; d: LinkDecision }>, groups: Groups): void {
  let rest = pending;
  while (rest.length) {
    const next = rest.filter(({ w, d }) => {
      const g = groups.of(d.target!);
      if (!g) return true;
      groups.add(g, w, "manual", d);
      if (g.contentId) g.manual = true;
      return false;
    });
    if (next.length === rest.length) {
      for (const { w, d } of next) groups.add(groups.newLoose(), w, "none", d);
      return;
    }
    rest = next;
  }
}

function placeDecided(works: Work[], decisions: LinkDecision[], contents: ContentRef[], groups: Groups) {
  const eff = effectiveDecisions(decisions);
  const known = new Set(contents.map((c) => c.id));
  const undecided: Work[] = [], merges: Array<{ w: Work; d: LinkDecision }> = [];
  for (const w of works) {
    const d = eff.get(w.key);
    if (!d) undecided.push(w);
    else if (d.op === "link" && known.has(d.contentId!)) groups.add(groups.forContent(d.contentId!), w, "manual", d);
    else if (d.op === "merge") merges.push({ w, d });
    else groups.add(groups.newLoose(), w, "none", d); // 拆开，或关联的稿件已经不在了（仍可撤销）
  }
  return { undecided, merges };
}

function toRow(g: Group, contents: Map<string, ContentRef>): DataRow {
  const c = g.contentId ? contents.get(g.contentId) ?? null : null;
  const byViews = [...g.works].sort((a, b) => (latest(b).metrics.views ?? 0) - (latest(a).metrics.views ?? 0));
  const days = g.works.map((w) => w.day).filter((d): d is string => Boolean(d)).sort();
  const lastDecision = [...g.decisions].sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
  return {
    id: c ? `c:${c.id}` : `w:${[...g.works].map((w) => w.key).sort()[0]}`,
    contentId: c?.id ?? null, contentTitle: c?.title ?? null,
    title: c?.title ?? byViews[0]?.title ?? "",
    // 按真实发布时间排：有平台数据就取最早那条的发布日，没有才用稿件自己的日期
    day: days[0] ?? c?.day ?? null,
    works: g.works,
    publishedOn: c ? c.platforms.filter((p) => p.published).map((p) => p.platform) : [],
    link: !c ? "none" : g.manual ? "manual" : "auto",
    decisionId: lastDecision?.id ?? null,
  };
}

export function buildRows(works: Work[], contents: ContentRef[], decisions: LinkDecision[]): DataRow[] {
  const groups = new Groups();
  const { undecided, merges } = placeDecided(works, decisions, contents, groups);
  groupOld(autoLink(undecided, contents, groups), groups);
  applyMerges(merges, groups);
  // 发了但一条数据都没回来的稿件也要占一行，才看得见「未回流」（§39）
  for (const c of contents) if (c.platforms.some((p) => p.published)) groups.forContent(c.id);
  const byId = new Map(contents.map((c) => [c.id, c]));
  const all = [...groups.byContent.values(), ...groups.loose].filter((g) => g.works.length > 0 || g.contentId);
  return all.map((g) => toRow(g, byId)).sort((a, b) => (b.day ?? "").localeCompare(a.day ?? "") || a.id.localeCompare(b.id));
}
