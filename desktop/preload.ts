import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, CHAT_PROGRESS_EVENT, chToMethod } from "../src/desktop/channels.js";

// Imports channels.ts (dependency-free), NOT ipc.ts — the sandboxed preload
// cannot require node builtins, so the engine must stay out of this bundle.
// chToMethod exposes the 18 window.autocrew invoke methods (see channels.ts docs),
// plus onChatProgress — the only push listener (fixed event name whitelist).

const autocrew = Object.fromEntries(
  IPC_CHANNELS.map((ch) => [
    chToMethod(ch),
    (payload?: Record<string, unknown>) =>
      ipcRenderer.invoke(ch, payload ?? {}),
  ]),
) as Record<string, unknown>;

autocrew.onChatProgress = (cb: (e: Record<string, unknown>) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) => cb(data);
  ipcRenderer.on(CHAT_PROGRESS_EVENT, handler);
  return () => ipcRenderer.removeListener(CHAT_PROGRESS_EVENT, handler);
};

contextBridge.exposeInMainWorld("autocrew", autocrew);
