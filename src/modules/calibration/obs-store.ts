/**
 * 观察的事件存储（observation-lifecycle.md）：都在 rubric-memo.jsonl 里追加事件，当前状态靠折叠。
 *   observation  新观察（stage 起点 observation）
 *   obs_stage    换阶段（cross_video / hypothesis / settled）
 *   obs_delete   删除：被吸收 / 被推翻 / 已沉淀为规则——留墓碑防重提
 */
import { readLog, type ChainRecord } from "./store.js";

export type ObsStage = "observation" | "cross_video" | "hypothesis" | "settled";
export interface Observation { id: string; stage: ObsStage; text: string; sample_ids: string[]; source: string; soft_notes: string[] }
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

/** 投影进 rubric.json 观察区：只放 id + 阶段 + 一句抽象规则；含数据的留在 memo 不进白名单 */
export function projectObservations(live: Observation[], leaks: (t: string) => boolean): Array<{ id: string; stage: string; text: string }> {
  return live.filter((o) => !leaks(o.text)).map((o) => ({ id: o.id, stage: o.stage, text: o.text }));
}
