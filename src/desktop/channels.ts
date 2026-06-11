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
  "chat:turn",
  "settings:get",
  "settings:set",
  "style:update_rule",
  "onboarding:status",
  "onboarding:init",
  "flywheel:import_csv",
  "dialog:pick_file",
  "knowledge:status",
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

/**
 * Converts an IPC channel name to a camelCase method name.
 * e.g. "flywheel:report" → "flywheelReport"
 *
 * All 18 methods exposed on window.autocrew:
 *   flywheelReport / generateScript / styleDistill / styleAbsorb / styleRules /
 *   contentList / contentGet / publishClipboard / publishConfirm / chatTurn /
 *   settingsGet / settingsSet / styleUpdateRule /
 *   onboardingStatus / onboardingInit / flywheelImportCsv / dialogPickFile /
 *   knowledgeStatus
 */
export function chToMethod(ch: string): string {
  const [ns, action] = ch.split(":");
  const camel = action.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return ns + camel.charAt(0).toUpperCase() + camel.slice(1);
}
