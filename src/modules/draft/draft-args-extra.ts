/**
 * 范文锁、开头候选、观众试读、升级出处这几样参数的归一（仓库约定：中转会把数组 / 对象变成字符串）。
 * 数组 → 用；像 JSON 的字符串 → 解析（修引号重试）；真解析不了才拒。返回 string = 拒绝原因；undefined = 没传。
 * 不是数组的绝不当空数组。
 */
import { maybeJson, UNPARSABLE } from "../publish/review-gate/plan.js";
import type { ExemplarPin } from "../exemplar/types.js";
import type { TestReadRecord } from "./draft-types.js";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const absent = (raw: unknown) => raw === undefined || raw === null || raw === "";
const intOf = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : undefined;
};

function arrayOf(raw: unknown, name: string): unknown[] | string {
  const v = maybeJson(raw);
  if (v === UNPARSABLE) return `${name} 看着是 JSON，但修过引号也解析不了：检查括号与逗号`;
  if (!Array.isArray(v)) return `${name} 要是数组`;
  return v;
}

/** angle.exemplars：[{id, version}]；空数组 = 这篇明确不带范文（本体裁无范文） */
export function parsePins(raw: unknown): ExemplarPin[] | string | undefined {
  if (absent(raw)) return undefined;
  const list = arrayOf(raw, "exemplars");
  if (typeof list === "string") return list;
  const out: ExemplarPin[] = [];
  for (const [i, x] of list.entries()) {
    const o = maybeJson(x);
    const id = isObj(o) && typeof o.id === "string" ? o.id.trim() : "";
    const version = isObj(o) ? intOf(o.version) : undefined;
    if (!id || !version) return `exemplars[${i}] 要是 {id, version}（exemplars 预览回执里给的）`;
    if (!out.some((p) => p.id === id)) out.push({ id, version });
  }
  return out;
}

/** opening.candidates：3 个开头（字符串数组；一整段字符串按空行切） */
export function parseCandidates(raw: unknown): string[] | string | undefined {
  if (absent(raw)) return undefined;
  let v = maybeJson(raw);
  if (v === UNPARSABLE) return "candidates 看着是 JSON，但修过引号也解析不了";
  if (typeof v === "string") v = v.split(/\n\s*\n/);
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return "candidates 要是字符串数组：每个是一个开头的前 15 秒原话";
  const list = (v as string[]).map((x) => x.trim()).filter(Boolean);
  if (list.length < 2 || list.length > 5) return `candidates 要 3 个开头（2–5 个都收），现在是 ${list.length} 个`;
  return list;
}

export type TestReadInput = Pick<TestReadRecord, "status" | "notes">;
const STATUSES = ["ok", "failed", "unsupported"];

/** save.test_read：{status: ok|failed|unsupported, notes}；notes 是试读原文（失败时写原因） */
export function parseTestRead(raw: unknown): TestReadInput | string | undefined {
  if (absent(raw)) return undefined;
  const v = maybeJson(raw);
  if (v === UNPARSABLE) return "test_read 看着是 JSON，但修过引号也解析不了";
  if (!isObj(v)) return "test_read 要是对象 {status: ok | failed | unsupported, notes}";
  if (typeof v.status !== "string" || !STATUSES.includes(v.status)) return "test_read.status 只能是 ok / failed / unsupported";
  const notes = typeof v.notes === "string" ? v.notes : isObj(v.notes) || Array.isArray(v.notes) ? JSON.stringify(v.notes) : "";
  if (!notes.trim()) return "test_read.notes 必填：试读结果原文；失败或不支持就写原因";
  return { status: v.status as TestReadRecord["status"], notes: notes.slice(0, 20_000) };
}

export interface Cite { content_id: string; index: number }

/** propose_promotion.cites：[{content_id, index}]，index 是 feedback_history 里那条意见的编号 */
export function parseCites(raw: unknown): Cite[] | string | undefined {
  if (absent(raw)) return undefined;
  const list = arrayOf(raw, "cites");
  if (typeof list === "string") return list;
  const out: Cite[] = [];
  for (const [i, x] of list.entries()) {
    const o = maybeJson(x);
    const id = isObj(o) && typeof o.content_id === "string" ? o.content_id.trim() : "";
    const index = isObj(o) ? intOf(o.index) : undefined;
    if (!id || !index) return `cites[${i}] 要是 {content_id, index}（feedback_history 回执里给的）`;
    out.push({ content_id: id, index });
  }
  return out;
}
