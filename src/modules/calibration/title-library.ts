/**
 * 标题方法库的生效版本（规格 §四「同一套门用于标题方法库的留 / 删 / 改」）。
 *
 * 内置库（title-method-library.ts）是起点；过了门的改动作为事件追加进 rubric-memo.jsonl（哈希链、只追加），
 * 当前生效的库 = 内置库依次叠加未被撤销的改动。所以每次改动都可审计、可撤销（追加 title_revert）。
 *   title_change  {id, proposal_id, removed, changed, restored}
 *   title_revert  {change_id, reason}
 * 被删的方法留墓碑：没有新证据（new_evidence）不能再加回来。
 */
import { TITLE_METHODS, type TitleMethod } from "../writing/title-method-library.js";
import { readLog, type ChainRecord } from "./store.js";

export const PATCH_FIELDS = ["name", "formula", "why", "fits", "notFor", "example", "redLine"] as const;
export type MethodPatch = Partial<Pick<TitleMethod, (typeof PATCH_FIELDS)[number]>> & { id: string };
export interface TitleChange { id: string; proposal_id: string; removed: string[]; changed: MethodPatch[]; restored: string[]; at: string }
export interface TitleTombstone { method: string; change_id: string; at: string }
export interface TitleLibraryState {
  methods: TitleMethod[];
  tombstones: TitleTombstone[];
  applied: TitleChange[];
  /** 每次改动 / 撤销 +1；提议审过之后版本变了 = 过期，不能落 */
  version: number;
}

function applyChange(methods: TitleMethod[], c: TitleChange): TitleMethod[] {
  const out = methods.filter((m) => !c.removed.includes(m.id)).map((m) => {
    const patch = c.changed.find((p) => p.id === m.id);
    return patch ? { ...m, ...patch, id: m.id, category: m.category } : m;
  });
  for (const id of c.restored) {
    const builtin = TITLE_METHODS.find((m) => m.id === id);
    if (builtin && !out.some((m) => m.id === id)) out.push(builtin);
  }
  return out;
}

export function foldTitleLibrary(records: ChainRecord[]): TitleLibraryState {
  const changes: TitleChange[] = [];
  const reverted = new Set<string>();
  let version = 0;
  for (const r of records) {
    if (r.type === "title_change") { changes.push(r as unknown as TitleChange); version++; }
    if (r.type === "title_revert") { reverted.add(String(r.change_id)); version++; }
  }
  const applied = changes.filter((c) => !reverted.has(c.id));
  let methods = [...TITLE_METHODS];
  const tombs = new Map<string, TitleTombstone>();
  for (const c of applied) {
    methods = applyChange(methods, c);
    for (const id of c.removed) tombs.set(id, { method: id, change_id: c.id, at: c.at });
    for (const id of c.restored) tombs.delete(id);
  }
  return { methods, tombstones: [...tombs.values()], applied, version };
}

export async function readTitleLibrary(dataDir?: string): Promise<TitleLibraryState> {
  return foldTitleLibrary((await readLog("rubric-memo", dataDir)).records);
}

/** 写标题、校验发布包时读的方法列表 */
export async function activeTitleMethods(dataDir?: string): Promise<TitleMethod[]> {
  return (await readTitleLibrary(dataDir)).methods;
}
