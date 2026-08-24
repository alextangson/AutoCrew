/**
 * IPC channel contract — dependency-free on purpose.
 *
 * preload.ts bundles this module; it must NOT pull in the engine (execute*
 * modules use node builtins, which the sandboxed preload cannot require).
 * ipc.ts re-exports from here so the contract has a single source.
 */

export const IPC_CHANNELS = [
  "flywheel:report",
  "generate:script",
  // 中断稿原地重写：在**原稿件 id** 上重跑生成，不新建——重试不该往看板堆重复卡
  "generate:retry",
  "style:distill",
  "style:absorb",
  "style:rules",
  "content:list",
  "content:get",
  "publish:clipboard",
  "publish:preflight",
  "publish:digest",
  "publish:confirm",
  // 发布前检查(任意平台)：GUI 的「进入发布检查」CTA 走它——全过自动流转 publish_ready
  "publish:pre_check",
  "publish:request_wechat",
  "publish:wechat_draft",
  "article_images:get",
  "article_images:generate",
  "article_images:regenerate",
  "article_images:remove",
  "article_images:suggest",
  "article_images:add_slot",
  "article_images:remove_slot",
  "article_images:upload",
  "chat:turn",
  // 对话控制面设计 §Phase 3：turn 寻址与中止链路 + 断线恢复
  "chat:abort",
  "chat:turn_status",
  // 右栏模型切换器的只读数据源：模型名 + 档位字，绝不含 apiKey/baseUrl
  "chat:model_options",
  "settings:get",
  "settings:set",
  // 端点配置的逃生门（设计 §Phase 4）：用系统默认应用打开实际生效的 engine.json
  "settings:open_config",
  // 配置面的反馈闭环：拿**已保存的**配置真发一次极小调用，回耗时与上游实际回的模型名
  "settings:test_route",
  "settings:search_get",
  "settings:search_set",
  "settings:publish_get",
  "settings:publish_set",
  "style:update_rule",
  "persona:generate",
  "persona:save",
  "cover:create",
  "cover:get",
  "cover:approve",
  "cover:revise",
  "cover:ratios",
  "cover:identity",
  "settings:cover_get",
  "settings:cover_set",
  "logs:list",
  "logs:get_run",
  "skills:list",
  "goal:get",
  "goal:set",
  "retro:generate",
  "retro:list",
  "retro:get",
  "onboarding:status",
  "onboarding:init",
  "flywheel:import_csv",
  "flywheel:record",
  "flywheel:wechat_pull",
  // 三平台自动回流控制面（回流 spec §4.4）：状态 / 手动抓 / 开关，
  // 三条与定时 tick 共用后端 single-flight，前端置灰只是 UX
  "flywheel:pull_status",
  "flywheel:pull_now",
  "flywheel:pull_toggle",
  // 假设台账只读（spec §5.3）：open + 已裁决两组，裁决是代码算的观察性结论
  "flywheel:hypotheses_list",
  "dialog:pick_file",
  "knowledge:status",
  "radar:status",
  "radar:refresh",
  "radar:more",
  "radar:rescore",
  "radar:sources_set",
  "profile:update",
  "content:update",
  "content:transition",
  "content:allowed_transitions",
  "content:versions",
  "content:revert",
  "draft:rewrite_selection",
  "draft:adopt_revision",
  "style:record_edit",
  "conversations:list",
  "conversations:get",
  "conversations:delete",
  "library:list",
  "library:add",
  "library:update",
  "library:remove",
  "library:folder_create",
  "library:folder_remove",
  // 常备素材池开关（视频线 lifecycle spec §1）：开启前置是 description 非空，判定在 library-pool
  "library:set_reusable",
  "dialog:pick_media",
  "content:asset_add",
  "content:asset_remove",
  "content:adoption",
  "today:summary",
  "dashboard:summary",
  "events:recent",
  "workspace:list",
  "workspace:create",
  "workspace:switch",
  "campaign:list",
  "campaign:get",
  "campaign:create",
  "campaign:plan_team",
  "campaign:transition",
  "campaign:run_ready",
  "campaign:retry_task",
  "campaign:artifact_get",
  "campaign:set_autonomy",
  "campaign:patch_propose",
  "campaign:patch_decide",
  "campaign:replan",
  "topics:list",
  "topic:create",
  "topic:update",
  "topic:delete",
  "topic:restore",
  // 角度点选（角度卡 spec §1.4）：点选 = 只带 angle_id；改写 = 额外带改写后的 card
  "topic:select_angle",
  "topic:clear_angle",
  "content:delete",
  "content:restore",
  "content:open_folder",
  "trash:list",
  "doctor:inbox",
  "inbox:list",
  "inbox:retry",
  "inbox:delete",
  "inbox:reingest",
  "inbox:settings_get",
  "inbox:settings_set",
  "inbox:status",
  "patterns:list",
  "patterns:update",
  "patterns:delete",
  "research:deep_dive",
  "research:status",
  "research:brief_get",
  "research:list_assets",
  "research:import_asset",
  // 视频生产线 V0a（设计 spec §8.2）：全部投递即返回，进度走 SSE `video:updated` + 重拉 status
  "video:build_start",
  "video:status",
  "video:transcript_get",
  "video:cut_confirm",
  "video:rough_cut_rerun",
  "video:editor_plan_get",
  "video:editor_confirm",
  "video:editor_rerun",
  "video:editor_slot_fill",
  // 槽位精修与门二回退（lifecycle spec §2.2 / §2.3）：删槽与填槽共用同一个派生函数
  "video:editor_slot_remove",
  "video:editor_back_to_cut",
  "video:cut_preview",
  "video:reassemble",
  "video:review_confirm",
  "video:retry",
  "video:asr_warmup",
  "video:asr_status",
  "video:settings_get",
  "video:settings_set",
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

/** 主进程 → renderer 推送事件名（preload 白名单监听；不走 invoke）。 */
export const CHAT_PROGRESS_EVENT = "chat:progress";

/** 引擎事件推送（P1 一期：工作日志/presence 的实时通道；回放走 events:recent）。 */
export const ENGINE_EVENT = "engine:event";

/**
 * Converts an IPC channel name to a camelCase method name.
 * e.g. "flywheel:report" → "flywheelReport"
 *
 * All 50 methods exposed on window.autocrew:
 *   flywheelReport / generateScript / styleDistill / styleAbsorb / styleRules /
 *   contentList / contentGet / publishClipboard / publishConfirm / publishWechatDraft / chatTurn /
 *   settingsGet / settingsSet / styleUpdateRule /
 *   onboardingStatus / onboardingInit / flywheelImportCsv / dialogPickFile /
 *   knowledgeStatus / radarStatus / radarRefresh / profileUpdate /
 *   contentUpdate / contentTransition / contentAllowedTransitions /
 *   contentVersions / contentRevert / draftRewriteSelection / styleRecordEdit /
 *   conversationsList / conversationsGet / conversationsDelete /
 *   libraryList / libraryAdd / libraryUpdate / libraryRemove /
 *   libraryFolderCreate / libraryFolderRemove / dialogPickMedia /
 *   contentAssetAdd / contentAssetRemove / contentAdoption / todaySummary / eventsRecent /
 *   topicsList / topicCreate / topicDelete / topicRestore / contentDelete / contentRestore / trashList
 */
export function chToMethod(ch: string): string {
  const [ns, action] = ch.split(":");
  const camel = action.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return ns + camel.charAt(0).toUpperCase() + camel.slice(1);
}
