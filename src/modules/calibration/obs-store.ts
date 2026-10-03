/**
 * 观察的事件存储（observation-lifecycle.md）：都在 rubric-memo.jsonl 里追加事件，当前状态靠折叠。
 *   observation  新观察（stage 起点 observation）
 *   obs_stage    换阶段（cross_video / hypothesis / settled）
 *   obs_delete   删除：被吸收 / 被推翻 / 已沉淀为规则——留墓碑防重提
 */
import { BLIND_LEAK_RE } from "./constants.js";
import { readLog, type ChainRecord } from "./store.js";

export type ObsStage = "observation" | "cross_video" | "hypothesis" | "settled";
export interface Observation { id: string; stage: ObsStage; text: string; sample_ids: string[]; source: string; soft_notes: string[]; abstract_rule?: string }
export interface Tombstone { id: string; text: string; reason: string }

export const normText = (t: string) => t.replace(/[\s，。、,.!！?？；;：:「」"']/g, "").toLowerCase();

export function foldObservations(records: ChainRecord[]): { live: Observation[]; tombstones: Tombstone[] } {
  const map = new Map<string, Observation>();
  const tombstones: Tombstone[] = [];
  for (const r of records) {
    const id = String(r.id ?? "");
    if (r.type === "observation") {
      map.set(id, { id, stage: (r.stage as ObsStage) ?? "observation", text: String(r.text ?? ""), sample_ids: (r.sample_ids as string[]) ?? [], source: String(r.source ?? ""), soft_notes: [] });
    } else if (r.type === "obs_stage" && map.has(id)) {
      const o = map.get(id)!;
      o.stage = r.stage as ObsStage;
      o.sample_ids = [...new Set([...o.sample_ids, ...((r.sample_ids as string[]) ?? [])])];
      if (typeof r.soft_note === "string") o.soft_notes.push(r.soft_note);
    } else if (r.type === "obs_publish" && map.has(id)) {
      map.get(id)!.abstract_rule = String(r.rule ?? "");
    } else if (r.type === "obs_delete" && map.has(id)) {
      tombstones.push({ id, text: map.get(id)!.text, reason: String(r.reason) });
      map.delete(id);
    }
  }
  return { live: [...map.values()], tombstones };
}

export async function readObservations(dataDir?: string) {
  return foldObservations((await readLog("rubric-memo", dataDir)).records);
}

/**
 * 投影进 rubric.json 观察区（盲评白名单）：原始观察永远只留在 memo；
 * 只有另行发布、过了 abstractRuleProblem 校验的抽象规则才进来。
 */
export function projectObservations(live: Observation[]): Array<{ id: string; stage: string; text: string }> {
  return live.filter((o) => o.abstract_rule && !abstractRuleProblem(o.abstract_rule)).map((o) => ({ id: o.id, stage: o.stage, text: o.abstract_rule as string }));
}

const RULE_CHECKS: Array<[RegExp, string]> = [
  [BLIND_LEAK_RE, "数据或实绩字样"],
  [/[《》「」『』"“”‘’]/, "书名号或引号（标题、评论原话）"],
  [/https?:\/\/|www\.|\.com|\.cn/i, "链接"],
  [/\d/, "数字（实绩、指标一律不进）"],
  [/评论|弹幕|点赞|转发|收藏|粉丝|赞/, "指标或评论"],
  [/\b(pred|obs|content|blind|bench)-/i, "样本 id"],
];

/** 抽象规则校验：返回第一个问题；null = 可以进盲评白名单 */
export function abstractRuleProblem(rule: string): string | null {
  if (!rule.trim()) return "规则是空的";
  for (const [re, what] of RULE_CHECKS) if (re.test(rule)) return `抽象规则里不能有${what}`;
  return null;
}
