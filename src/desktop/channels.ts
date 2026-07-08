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
  "publish:confirm",
  "publish:wechat_draft",
  "chat:turn",
  "settings:get",
  "settings:set",
  "style:update_rule",
  "onboarding:status",
  "onboarding:init",
  "flywheel:import_csv",
  "dialog:pick_file",
  "knowledge:status",
  "radar:status",
  "radar:refresh",
  "profile:update",
  "content:update",
  "content:transition",
  "content:allowed_transitions",
  "content:versions",
  "content:revert",
  "draft:rewrite_selection",
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
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

/** 主进程 → renderer 推送事件名（preload 白名单监听；不走 invoke）。 */
export const CHAT_PROGRESS_EVENT = "chat:progress";

/**
 * Converts an IPC channel name to a camelCase method name.
 * e.g. "flywheel:report" → "flywheelReport"
 *
 * All 43 methods exposed on window.autocrew:
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
 *   contentAssetAdd / contentAssetRemove / contentAdoption / todaySummary
 */
export function chToMethod(ch: string): string {
  const [ns, action] = ch.split(":");
  const camel = action.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return ns + camel.charAt(0).toUpperCase() + camel.slice(1);
}
