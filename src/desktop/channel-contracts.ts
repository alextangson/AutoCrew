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
  // 可选键 use_patterns（boolean）：false = 本次不注入对标拆解卡（收件箱设计 §3.5）
  "generate:script": ["topic", "platform"],
  "style:distill": [],
  "style:absorb": ["samples"],
  "style:rules": [],
  "content:list": [],
  "content:get": ["id"],
  "publish:clipboard": ["content_id"],
  "publish:preflight": ["content_id"],
  "publish:digest": ["content_id"],
  // 可选键 publish_url（发布后的平台地址）：省略/空串 = 保留稿件上已有的链接，不清空
  "publish:confirm": ["content_id"],
  "publish:pre_check": ["content_id"],
  "publish:request_wechat": ["content_id"],
  "publish:wechat_draft": ["content_id", "approval_token"],
  "article_images:get": ["content_id"],
  "article_images:generate": ["content_id"],
  "article_images:regenerate": ["content_id", "index", "prompt"],
  "article_images:remove": ["content_id", "index"],
  "article_images:suggest": ["content_id"],
  "article_images:add_slot": ["content_id"],
  "article_images:remove_slot": ["content_id", "index"],
  "article_images:upload": ["content_id", "index", "data_base64"],
  // turn_id / client_id / model_choice 都是可选的 additive 扩展：老前端不传照常对话，
  // 只是那一轮不可中止、且用缺省的主端点快档
  "chat:turn": ["message"],
  "chat:abort": ["turn_id", "client_id"],
  "chat:turn_status": ["turn_id"],
  "chat:model_options": [],
  "settings:get": [],
  // providers 是可选数组（字段存在性判定：未提交保留、空数组清空、有数组走 merge）
  "settings:set": [],
  "settings:open_config": [],
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
  "cover:identity": ["action"],
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
  "flywheel:import_csv": ["platform"],
  "flywheel:record": ["content_id", "metrics"],
  "flywheel:wechat_pull": [],
  // 自动回流控制面：platform 只认 douyin/wechat_video/xiaohongshu（深校验在 handler）；
  // pull_toggle 的 enabled 是布尔，false 也算「给了值」，所以列必填不会误拒关开关
  "flywheel:pull_status": [],
  "flywheel:pull_now": ["platform"],
  "flywheel:pull_toggle": ["platform", "enabled"],
  "flywheel:hypotheses_list": [],
  "dialog:pick_file": [],
  "knowledge:status": [],
  "radar:status": [],
  "radar:refresh": [],
  "radar:more": [],
  "radar:rescore": [],
  "radar:sources_set": ["sources"],
  // 可选键 industry / platforms / focusKeywords（雷达粗筛关键词），至少给一个由 handler 判
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
  "topic:update": ["id"],
  "topic:delete": ["id"],
  "topic:restore": ["id"],
  "trash:list": [],
  "content:versions": ["id"],
  "content:revert": ["id", "version"],
  "draft:rewrite_selection": ["body", "selection", "instruction"],
  "draft:adopt_revision": ["content_id", "body"],
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
  // reusable 是布尔，可能为 false——必填校验按「键存在」判不了它，深校验在 handler
  "library:set_reusable": ["id"],
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
  "campaign:set_autonomy": ["id", "autonomy"],
  "campaign:patch_propose": ["id", "base_revision", "reason", "operations"],
  "campaign:patch_decide": ["id", "patch_id", "approved"],
  "campaign:replan": ["id"],
  "doctor:inbox": [],
  // 灵感收件箱工作台（收件箱设计 §4）。id 之外的键全可选，深校验在 handler
  "inbox:list": [],
  "inbox:retry": ["id"],
  "inbox:delete": ["id"],
  "inbox:reingest": ["id"],
  "inbox:settings_get": [],
  "inbox:settings_set": [],
  "inbox:status": [],
  "patterns:list": [],
  "patterns:update": ["id"],
  "patterns:delete": ["id"],
  // 深调研（deep-research spec §8）。brief_get 的可选键 revision（正整数）= 回溯指定版本
  "research:deep_dive": ["topic_id"],
  "research:status": ["topic_id"],
  "research:brief_get": ["topic_id"],
  "research:list_assets": ["topic_id"],
  // 可选键 index（非负整数）= 落到第几个插图位；不给则落第一个空位（§7 放置即导入）
  "research:import_asset": ["topic_id", "asset_id", "content_id"],
  // 视频生产线（设计 spec §8.2）。乐观锁的 base revision 是必填——少一个就等于
  // 允许「不带版本就确认」，两个窗口并发确认时后到者会默默覆盖（codex #11）。
  // keeps/flags/overlays 的深校验（分句是否存在、槽位是否越界）在 handler 与 service。
  "video:build_start": ["content_id"],
  "video:status": ["content_id"],
  "video:transcript_get": ["content_id"],
  "video:cut_confirm": ["content_id", "keeps", "base_transcript_revision", "base_cut_revision"],
  // 重跑 AI 粗剪（粗剪 spec §3.4）：不带版本——它只是把 cut 的计算步重排一次，
  // 会不会覆盖由 service 按当前 cut.origin 判（人工终裁过的一律拒）
  "video:rough_cut_rerun": ["content_id"],
  // 成片计划（横屏 spec §3.1）。确认必须带 plan_revision（乐观锁）与 kept_overlay_ids
  // ——空数组是合法的「全删，出纯口播」，所以校验只看键在不在，不看长度
  "video:editor_plan_get": ["content_id"],
  "video:editor_confirm": ["content_id", "plan_revision", "kept_overlay_ids"],
  "video:editor_rerun": ["content_id"],
  "video:editor_slot_fill": ["content_id", "plan_revision", "overlay_id", "library_id"],
  // 删槽与门二回退（lifecycle spec §2.2 / §2.3）：两条都带 plan_revision 当乐观锁，
  // 它们改的是同一份 plan 派生链，不带版本就等于允许覆盖别人刚做的编排
  "video:editor_slot_remove": ["content_id", "plan_revision", "overlay_id"],
  "video:editor_back_to_cut": ["content_id", "plan_revision"],
  "video:cut_preview": ["content_id", "keeps", "base_transcript_revision", "base_cut_revision"],
  "video:reassemble": ["content_id"],
  "video:review_confirm": ["content_id", "rendered_revision", "verdict"],
  "video:retry": ["content_id"],
  "video:asr_warmup": [],
  "video:asr_status": [],
  "video:settings_get": [],
  "video:settings_set": [],
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
