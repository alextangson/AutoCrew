import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../src/desktop/ipc.js";

/**
 * Converts an IPC channel name to a camelCase method name.
 * e.g. "flywheel:report" → "flywheelReport"
 *      "publish:confirm" → "publishConfirm"
 *
 * All 9 methods exposed on window.autocrew:
 *   flywheelReport / generateScript / styleDistill / styleAbsorb / styleRules /
 *   contentList / contentGet / publishClipboard / publishConfirm
 */
function chToMethod(ch: string): string {
  const [ns, action] = ch.split(":");
  const capitalized = action.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return ns + capitalized.charAt(0).toUpperCase() + capitalized.slice(1);
}

const autocrew = Object.fromEntries(
  IPC_CHANNELS.map((ch) => [
    chToMethod(ch),
    (payload?: Record<string, unknown>) =>
      ipcRenderer.invoke(ch, payload ?? {}),
  ]),
);

contextBridge.exposeInMainWorld("autocrew", autocrew);
