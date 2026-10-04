import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getDataDir, LOCAL_HOST } from "../storage/local-store.js";
import { CLIPBOARD_PLATFORMS } from "../modules/publish/clipboard-publisher.js";
import { insightsReportSchema } from "../modules/insights/report.js";
import { prepareInsights, submitInsights, getInsights, listInsights } from "../modules/insights/store.js";
import { executeMeetingAction, MEETING_ACTIONS, MEETING_DESCRIPTION } from "./insights-meeting.js";
import { CALIB_ACTIONS, CALIB_DESCRIPTION, executeCalibrationAction } from "./insights-calibration.js";
import { WORK_ACTIONS, WORK_DESCRIPTION, executeWorkAction } from "./insights-works.js";

export const insightsSchema = Type.Object({
  action: Type.Optional(Type.Union(["prepare", "submit", "list", "get", ...MEETING_ACTIONS, ...CALIB_ACTIONS, ...WORK_ACTIONS].map((action) => Type.Literal(action)), { description: "默认prepare冻结账号事实；宿主分析后submit保存；list/get回读。选题会：meeting_brief/meeting_get/meeting_save/meeting_tag。" })),
  days: Type.Optional(Type.Integer({ minimum: 1, maximum: 366, default: 30, description: "prepare的观察窗口天数；累计背景另列，不冒充本期新增。" })),
  platform: Type.Optional(Type.Union([...CLIPBOARD_PLATFORMS, "xhs"].map((platform) => Type.Literal(platform)), { description: "只分析指定平台；不填则分平台展示全部。" })),
  focus: Type.Optional(Type.String({ maxLength: 500, description: "用户本次关注的问题，例如留存、账号定位、下一批选题。" })),
  pack_id: Type.Optional(Type.String({ pattern: "^insights-[a-f0-9-]{36}$", description: "prepare返回的ID，submit/get必填。" })),
  evidence_hash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$", description: "submit必填，来自同一个prepare，防止混用事实包。" })),
  report: Type.Optional(insightsReportSchema),
  date: Type.Optional(Type.String({ description: "选题会日期 YYYY-MM-DD（北京时间），缺省今天。" })),
  meeting: Type.Optional(Type.Unknown({ description: "meeting_save：{expected_revision（读到的 revision，新会 0；CAS 冲突即报错重读）, slots:[{slot_id?,topic_id,persona:{key,name},payoff,format,line?,why_now,data_basis,bet,watch:{platform,metric,day},probability,premortem,angle_decision?}], rejected:[{topic_id?,title,reason}], reviews:[{hypothesis_id,would_repeat}], notes?}" })),
  calib: Type.Optional(Type.Unknown({ description: "calib_* 动作的参数对象，见 tool-guide。" })),
  tag: Type.Optional(Type.Unknown({ description: "meeting_tag：{work_key, format?, persona_key?}；work_key 取简报 works/untagged 的 key。" })),
  work: Type.Optional(Type.Unknown({ description: "work_bind / work_claim / history_create / history_delete 的参数对象。" })),
}, { additionalProperties: false });

export const INSIGHTS_DESCRIPTION = [
  "账号洞察（类似 /insights）：基于已有内容、创作者规划、各平台回流和工作进度，交付账号数据报告及新媒体团队下一步建议。",
  "prepare{days?:30,platform?,focus?}冻结证据，返回pack_id/evidence_hash/facts。由当前宿主解释数据、诊断内容，并分配建议给主编、选题、写稿、剪辑、封面、发布运营或数据复盘岗位。",
  "submit{pack_id,evidence_hash,report}保存报告。每项team_actions须含owner/priority/action/rationale/deliverable/success_metric/timeframe/prerequisite/evidence_refs。报告最多3项判断、8项行动；只引用本包真实ref。",
  "必须继续到submit并把报告交给用户；prepare成功只是备料完成。list/get可回看历史或恢复未完成的包。",
  "除 calib_* 的盲评与审计通道外无后台模型调用、无自动浏览器采集、无自动派工或发布。报告是建议；用户当前要求优先，缺数据就说明，不能编造趋势或把累计当月增。",
  MEETING_DESCRIPTION,
  CALIB_DESCRIPTION,
  WORK_DESCRIPTION,
].join("\n");

export async function executeInsights(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const publicArgs = Object.fromEntries(Object.entries(params).filter(([k]) => !k.startsWith("_")));
  if (!Value.Check(insightsSchema, publicArgs)) return { ok: false, error: `账号洞察参数不符合契约：${[...Value.Errors(insightsSchema, publicArgs)].slice(0, 3).map((e) => `${e.path} ${e.message}`).join("；")}` };
  const args = publicArgs as Static<typeof insightsSchema>;
  const action = args.action ?? "prepare";
  const dir = getDataDir(typeof params._dataDir === "string" ? params._dataDir : undefined);
  try {
    if ((MEETING_ACTIONS as readonly string[]).includes(action)) return await executeMeetingAction(action, args, dir);
    if ((WORK_ACTIONS as readonly string[]).includes(action)) return await executeWorkAction(action, args.work, dir);
    if ((CALIB_ACTIONS as readonly string[]).includes(action)) return await executeCalibrationAction(action, args.calib, dir, typeof params._host === "string" ? params._host : LOCAL_HOST);
    if (action === "prepare") return await prepareInsights({ days: args.days ?? 30, platform: args.platform, focus: args.focus }, dir);
    if (action === "list") return { ok: true, reports: await listInsights(dir) };
    if (!args.pack_id) return { ok: false, error: `${action}需要prepare返回的pack_id` };
    if (action === "get") return await getInsights(args.pack_id, dir);
    if (!args.evidence_hash || !args.report) return { ok: false, error: "submit需要evidence_hash与完整report，先prepare再由宿主分析" };
    return await submitInsights(args.pack_id, args.evidence_hash, args.report,
      typeof params._host === "string" ? params._host : LOCAL_HOST, dir);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), next_action: "核对数据源、pack_id与报告字段后重试；不会切换后台模型或执行建议。" };
  }
}
