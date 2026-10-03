/**
 * 标题方法库留 / 删 / 改的回测件（规格 §四末段 + 原 ② 规则）：纯函数，不碰盘。
 *   - 提议 = 明确写出新库组成（每个现有方法恰好在 keep / remove / change 之一）；
 *   - 回测预测器 = 留一均值（见 methodScore 注释）；排序门复用 rank-gate.ts，不重写门的数学；
 *   - 单条异常（≥3× 基线）只能记观察，不能单独撑起一次改库。
 */
import { decodeArg } from "../meetings/meeting-args.js";
import type { TitleMethod } from "../writing/title-method-library.js";
import { SELF_WRITTEN } from "../writing/title-methods.js";
import { UNTAGGED, type TitlePostSample } from "../writing/title-method-stats.js";
import type { GateSample } from "./rank-gate.js";
import { PATCH_FIELDS, type MethodPatch, type TitleLibraryState } from "./title-library.js";

export const OUTLIER_RATIO = 3;
export const ONE_SAMPLE_NOTE = "样本 1 条，不下结论";

export interface Composition { keep: string[]; remove: string[]; change: MethodPatch[]; restore: string[] }

function idList(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  const d = decodeArg(raw);
  if (!Array.isArray(d) || d.some((x) => typeof x !== "string" || !x.trim())) throw new Error(`${field} 必须是方法 id 数组`);
  return (d as string[]).map((x) => x.trim());
}

function readPatch(raw: unknown, i: number): MethodPatch {
  const o = decodeArg(raw) as Record<string, unknown>;
  if (!o || typeof o !== "object" || Array.isArray(o) || typeof o.id !== "string") throw new Error(`change[${i}] 要是 {id, 要改的字段}`);
  const patch: MethodPatch = { id: o.id.trim() };
  for (const k of PATCH_FIELDS) {
    if (o[k] === undefined) continue;
    const v = k === "redLine" ? decodeArg(o[k]) : o[k];
    const ok = k === "redLine" ? Array.isArray(v) && v.every((x) => typeof x === "string") : typeof v === "string" && v.trim();
    if (!ok) throw new Error(`change[${i}].${k} 格式不对`);
    (patch as Record<string, unknown>)[k] = v;
  }
  if (Object.keys(patch).length === 1) throw new Error(`change[${i}] 没写要改什么（可改：${PATCH_FIELDS.join("/")}；id 与类别不能改）`);
  return patch;
}

/** 读提议的完整新库组成并校验覆盖、墓碑、剩余类别 */
export function readComposition(raw: unknown, state: TitleLibraryState, newEvidence: unknown): Composition {
  const o = decodeArg(raw) as Record<string, unknown>;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("composition 要是 {keep, remove, change, restore?} 完整新库组成");
  const changeRaw = decodeArg(o.change ?? []);
  if (!Array.isArray(changeRaw)) throw new Error("composition.change 必须是数组");
  const c: Composition = { keep: idList(o.keep, "keep"), remove: idList(o.remove, "remove"), change: changeRaw.map(readPatch), restore: idList(o.restore, "restore") };
  const current = state.methods.map((m) => m.id);
  const listed = [...c.keep, ...c.remove, ...c.change.map((p) => p.id)];
  const dup = listed.filter((id, i) => listed.indexOf(id) !== i);
  if (dup.length) throw new Error(`方法 ${[...new Set(dup)].join("、")} 出现在不止一个列表里`);
  const unknown = listed.filter((id) => !current.includes(id));
  if (unknown.length) throw new Error(`方法 ${unknown.join("、")} 不在当前库里`);
  const missing = current.filter((id) => !listed.includes(id));
  if (missing.length) throw new Error(`新库组成要写全：${missing.join("、")} 没说留、删还是改`);
  for (const id of c.restore) {
    if (!state.tombstones.some((t) => t.method === id)) throw new Error(`restore 的 ${id} 不是被删过的方法`);
  }
  if (c.restore.length && !(typeof newEvidence === "string" && newEvidence.trim())) {
    throw new Error(`${c.restore.join("、")} 被删过（留了墓碑）：没有新证据 new_evidence 不能加回来`);
  }
  if (!c.remove.length && !c.change.length && !c.restore.length) throw new Error("这个提议什么都没改");
  return c;
}

/** 删完剩下的方法至少覆盖 3 个类（候选要分属 3 个不同类） */
export function remainingCategories(methods: TitleMethod[], builtin: TitleMethod[], c: Composition): number {
  const kept = methods.filter((m) => !c.remove.includes(m.id));
  const back = builtin.filter((m) => c.restore.includes(m.id));
  return new Set([...kept, ...back].map((m) => m.category)).size;
}

export interface Eligibility { samples: TitlePostSample[]; withData: TitlePostSample[]; flagged: number; noData: number; oneSample: string[]; untagged: number }

/** 参与回测的稿：带方法 id（未标记/自拟不算）、方法在库里、点击率没被复核剔掉、同方法至少 2 条 */
export function eligiblePosts(posts: TitlePostSample[], methodIds: string[]): Eligibility {
  const tagged = posts.filter((p) => p.method !== UNTAGGED && p.method !== SELF_WRITTEN && methodIds.includes(p.method));
  const withData = tagged.filter((p) => p.clickRate !== undefined);
  const count = new Map<string, number>();
  for (const p of withData) count.set(p.method, (count.get(p.method) ?? 0) + 1);
  const oneSample = [...count.entries()].filter(([, n]) => n === 1).map(([m]) => m);
  return {
    samples: withData.filter((p) => !oneSample.includes(p.method)),
    withData,
    flagged: tagged.filter((p) => p.flagged).length,
    noData: tagged.filter((p) => p.clickRate === undefined && !p.flagged).length,
    oneSample,
    untagged: posts.length - tagged.length,
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * 预测器：某条稿在某个方法库下「该有多少点击率」。
 * 取留一均值：同方法其它稿的平均点击率（不含自己，否则就是拿答案预测答案）；
 * 方法不在这个库里（被删）或同方法没有别的稿 → 全库其它稿的平均。
 * 为什么这么简单：试用期最多十来条稿，方法 id 是唯一可用的解释变量；「按方法分组的均值」正是
 * 「这个方法有没有区分度」的最直接表达——删掉一个方法 = 承认它和全库平均没区别，回测就看这样排序会不会更贴实绩。
 */
export function methodScore(p: TitlePostSample, all: TitlePostSample[], libIds: Set<string>): number {
  const others = all.filter((x) => x.id !== p.id);
  const same = others.filter((x) => x.method === p.method);
  const pool = libIds.has(p.method) && same.length ? same : others;
  return mean(pool.map((x) => x.clickRate as number));
}

export function backtestSamples(samples: TitlePostSample[], oldIds: string[], newIds: string[]): GateSample[] {
  const o = new Set(oldIds), n = new Set(newIds);
  return samples.map((p) => ({ id: p.id, label: p.title, oldScore: methodScore(p, samples, o), newScore: methodScore(p, samples, n), actual: p.clickRate as number }));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface Outlier { id: string; method: string; clickRate: number; baseline: number; ratio: number }

/** 基线 = 其它带数据的稿点击率中位数；≥3 倍算单条异常 */
export function findOutliers(samples: TitlePostSample[]): Outlier[] {
  const out: Outlier[] = [];
  for (const p of samples) {
    const rest = samples.filter((x) => x.id !== p.id).map((x) => x.clickRate as number);
    if (!rest.length) continue;
    const baseline = median(rest);
    if (baseline > 0 && (p.clickRate as number) >= OUTLIER_RATIO * baseline) {
      out.push({ id: p.id, method: p.method, clickRate: p.clickRate as number, baseline, ratio: Math.round(((p.clickRate as number) / baseline) * 10) / 10 });
    }
  }
  return out;
}

/** 判断级提议：被动到的方法如果去掉异常稿后一条数据都没有，就是拿单条异常当唯一依据 */
export function outlierOnlyMethods(c: Composition, samples: TitlePostSample[], outliers: Outlier[]): string[] {
  const touched = [...c.remove, ...c.change.map((p) => p.id), ...c.restore];
  const bad = new Set(outliers.map((o) => o.id));
  return touched.filter((m) => outliers.some((o) => o.method === m) && !samples.some((p) => p.method === m && !bad.has(p.id)));
}

export function newLibraryIds(state: TitleLibraryState, c: Composition): string[] {
  return [...state.methods.map((m) => m.id).filter((id) => !c.remove.includes(id)), ...c.restore];
}
