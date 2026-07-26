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
  "style:distill",
  "style:absorb",
  "style:rules",
  "content:list",
  "content:get",
  "publish:clipboard",
  "publish:digest",
  "publish:confirm",
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
  "settings:get",
  "settings:set",
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
