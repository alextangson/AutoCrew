/**
 * IPC 通道契约（IA v4.2 工程线:renderer/engine 边界的类型与校验单一事实源）。
 *
 * 为什么:54 个通道的 payload 形状此前全靠两头默契——改一头忘另一头就是运行时 bug。
 * 本表做两件事:
 *   1. REQUIRED_FIELDS:每通道必填字段,server 在 sanitize 后统一校验,缺失即拒
 *      （替代散落在各 handler 里有一搭没一搭的 "id is required"——那些保留作纵深防御）。
 *   2. ChannelPayload 类型表:renderer TS 化（frontend v2 A 期）时的现成消费面;
 *      当下作为通道文档——新增通道必须在这里登记,否则校验中间件直接拒。
 *
 * 纪律:改任何通道的 payload 形状,先改这里。
 */
import type { IpcChannel } from "./channels.js";

/** 每通道必填字段（string 键存在且非空/非 undefined 即过;深校验留给 handler） */
export const REQUIRED_FIELDS: Record<IpcChannel, readonly string[]> = {
  "flywheel:report": [],
  "generate:script": ["topic", "platform"],
  "style:distill": [],
  "style:absorb": ["samples"],
  "style:rules": [],
  "content:list": [],
  "content:get": ["id"],
  "publish:clipboard": ["content_id"],
  "publish:confirm": ["content_id"],
  "publish:request_wechat": ["content_id"],
  "publish:wechat_draft": ["content_id", "approval_token"],
  "chat:turn": ["message"],
  "settings:get": [],
  "settings:set": [],
  "settings:search_get": [],
  "settings:search_set": ["provider", "api_key"],
  "settings:publish_get": [],
  "settings:publish_set": [],
  "style:update_rule": ["index"],
  "persona:generate": [],
  "persona:save": ["persona"],
  "cover:create": ["content_id"],
  "cover:get": ["content_id"],
  "cover:approve": ["content_id", "label"],
  "cover:revise": ["content_id", "label", "feedback"],
  "cover:ratios": ["content_id"],
  "settings:cover_get": [],
  "settings:cover_set": [],
  "logs:list": [],
  "logs:get_run": ["run_id"],
  "skills:list": [],
  "goal:get": [],
  "goal:set": ["statement"],
  "retro:generate": ["mode"],
  "retro:list": [],
  "retro:get": ["file"],
  "onboarding:status": [],
  "onboarding:init": [],
  "flywheel:import_csv": ["platform", "csv_path"],
  "flywheel:record": ["content_id", "metrics"],
  "dialog:pick_file": [],
  "knowledge:status": [],
  "radar:status": [],
  "radar:refresh": [],
  "radar:sources_set": ["sources"],
  "profile:update": [],
  "content:update": ["id"],
  "content:transition": ["id", "target_status"],
  "content:allowed_transitions": ["id"],
  "content:adoption": ["id", "verdict"],
  "content:delete": ["id"],
  "content:restore": ["id"],
  "content:open_folder": ["id"],
  "topics:list": [],
  "topic:create": ["title"],
  "topic:delete": ["id"],
  "topic:restore": ["id"],
  "trash:list": [],
  "content:versions": ["id"],
  "content:revert": ["id", "version"],
  "draft:rewrite_selection": ["body", "selection", "instruction"],
  "style:record_edit": ["before", "after"],
  "conversations:list": [],
  "conversations:get": ["id"],
  "conversations:delete": ["id"],
  "library:list": [],
  "library:add": [],
  "library:update": ["id"],
  "library:remove": ["id"],
  "library:folder_create": ["name"],
  "library:folder_remove": ["id"],
  "dialog:pick_media": [],
  "content:asset_add": ["content_id", "library_id"],
  "content:asset_remove": ["content_id", "filename"],
  "today:summary": [],
  "dashboard:summary": [],
  "events:recent": [],
  "workspace:list": [],
  "workspace:create": ["name"],
  "workspace:switch": ["id"],
  "campaign:list": [],
  "campaign:get": ["id"],
  "campaign:create": ["name", "mode", "goals"],
  "campaign:plan_team": ["id"],
  "campaign:transition": ["id", "target_status"],
  "campaign:run_ready": ["id"],
  "campaign:retry_task": ["id", "task_id"],
  "campaign:artifact_get": ["id", "artifact_id"],
} as const;

/**
 * 校验必填字段。返回错误消息（缺什么、哪个通道）或 null。
 * 未登记的通道一律拒——契约表是新增通道的强制登记处。
 */
export function validatePayload(channel: string, payload: Record<string, unknown>): string | null {
  const required = REQUIRED_FIELDS[channel as IpcChannel];
  if (!required) return `通道 ${channel} 未在 channel-contracts 登记`;
  const missing = required.filter((f) => {
    const v = payload[f];
    return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  });
  if (missing.length > 0) return `${channel} 缺少必填字段：${missing.join("、")}`;
  return null;
}
