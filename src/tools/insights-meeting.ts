/** autocrew_insights 的选题会动作（选题会 spec §2–§5）：简报、读会议记录、落库、补作品标签 */
import { buildMeetingBrief } from "../modules/meetings/meeting-brief.js";
import { getMeeting, saveMeeting } from "../modules/meetings/meeting-save.js";
import { MEETING_FORMATS, PERSONA_TIER_KEYS, MeetingConflictError } from "../modules/meetings/meeting-store.js";
import { setWorkTag } from "../modules/flywheel/platform-items.js";
import { decodeArg } from "../modules/meetings/meeting-args.js";

export const MEETING_ACTIONS = ["meeting_brief", "meeting_get", "meeting_save", "meeting_tag"] as const;

export const MEETING_DESCRIPTION = [
  "排期会（可选，技能 schedule-meeting，不拦写稿）：meeting_brief 出确定性简报（回流健康度、作品 D+3/D+7、按形式/画像分组、同平台同龄基线 n<5 标 insufficient、上次下注对账），不调模型；读失败直接报原始错误，停会。",
  "meeting_get{date?} 读会议记录与 revision；meeting_save{date?,meeting:{expected_revision,slots,rejected,reviews,notes?}} 落会议记录（CAS）+ 每个选中位一条假设 + 选题标进本周片单（选中≠开工）；单题会（临时蹭热点）meeting 里带 append:true 只追加新位到最近一场会（expected_revision 用 meeting_get 回的 latest_meeting.revision），照样要 bet/probability，不要求对账；meeting_tag{tag:{work_key,format?,persona_key?}} 给已发作品补形式/画像。",
].join("\n");

type Obj = Record<string, unknown>;
/** 对象参数：JSON 串照收；缺了或解析不成对象就打回，绝不当成空会议/空标签继续 */
function objOf(v: unknown, field: string): Obj {
  const d = decodeArg(v);
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error(`${field} 必须是对象（收到 ${v === undefined ? "空" : typeof d}）`);
  return d as Obj;
}

async function tag(raw: unknown, dir: string) {
  const args = objOf(raw, "tag");
  const key = typeof args.work_key === "string" ? args.work_key.trim() : "";
  const format = typeof args.format === "string" ? args.format.trim() : "";
  const personaKey = typeof args.persona_key === "string" ? args.persona_key.trim() : "";
  if (!key) return { ok: false, error: "meeting_tag 需要 work_key（简报 works/untagged 里的 key）" };
  if (!format && !personaKey) return { ok: false, error: "meeting_tag 至少给 format 或 persona_key 之一" };
  if (format && !(MEETING_FORMATS as readonly string[]).includes(format)) return { ok: false, error: `format 只能是 ${MEETING_FORMATS.join("/")}` };
  if (personaKey && !(PERSONA_TIER_KEYS as readonly string[]).includes(personaKey)) return { ok: false, error: "persona_key 只能是 core/adjacent/surprise" };
  const brief = await buildMeetingBrief(dir);
  if (![...brief.works, ...brief.outliers].some((w) => w.key === key)) {
    return { ok: false, error: `work_key「${key}」不在当前简报的作品里——用 meeting_brief 返回的 works/outliers/untagged 里的 key` };
  }
  const saved = await setWorkTag(key, { ...(format ? { format } : {}), ...(personaKey ? { personaKey } : {}) }, dir);
  return { ok: true, work_key: key, tag: saved };
}

export async function executeMeetingAction(action: string, args: Record<string, unknown>, dir: string): Promise<Record<string, unknown>> {
  try {
    if (action === "meeting_brief") return { ok: true, model_invoked: false, brief: await buildMeetingBrief(dir) };
    if (action === "meeting_get") return await getMeeting(typeof args.date === "string" ? args.date : undefined, dir);
    if (action === "meeting_tag") return await tag(args.tag, dir);
    return await saveMeeting({ ...objOf(args.meeting, "meeting"), date: args.date }, dir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof MeetingConflictError) return { ok: false, error: message, conflict: true, current_revision: err.current, next_action: "meeting_get 重读后再改" };
    return { ok: false, error: message, next_action: "排期会停在这里：把原始错误告诉创始人，修好数据源再开，不凭记忆开会。" };
  }
}
