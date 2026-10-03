/** autocrew_insights 的作品归属动作（回流认领规格 2026-10-03 ③④）：人工绑定、补历史作品记录、删历史记录 */
import { bindWorkManually, createHistoryRecord, deleteHistoryRecord } from "../modules/flywheel/work-binding.js";
import { decodeArg } from "../modules/meetings/meeting-args.js";

export const WORK_ACTIONS = ["work_bind", "history_create", "history_delete"] as const;

export const WORK_DESCRIPTION =
  "作品归属（创始人确认过才调）：work_bind{work:{content_id,platform,item_id}} 把平台作品人工绑到稿子并补归属已入账数据；" +
  "history_create{work:{title,published_date,items:[{platform,item_id}]}} 补一条历史作品记录（无正文、不进任何生产流程）；history_delete{work:{content_id}}。作品 id 一律传字符串。";

type Obj = Record<string, unknown>;

/** 对象参数：JSON 串照收（中转端点会把对象串成字符串）；解析不成对象就打回 */
function workArg(raw: unknown): Obj {
  const d = decodeArg(raw);
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error(`work 必须是对象（收到 ${raw === undefined ? "空" : typeof d}）`);
  const obj = d as Obj;
  // items 也可能被单独串成字符串
  if (obj.items !== undefined) obj.items = decodeArg(obj.items);
  return obj;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export async function executeWorkAction(action: string, raw: unknown, dir: string): Promise<Record<string, unknown>> {
  try {
    const work = workArg(raw);
    if (action === "work_bind") return await bindWorkManually(text(work.content_id), work.platform, work.item_id, dir);
    if (action === "history_create") return await createHistoryRecord(work, dir);
    return await deleteHistoryRecord(text(work.content_id), dir);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), next_action: "把原始错误告诉创始人；绑定和历史记录都没有写入。" };
  }
}
