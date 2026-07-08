import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, CHAT_PROGRESS_EVENT, ENGINE_EVENT, chToMethod } from "../src/desktop/channels.js";

// Imports channels.ts (dependency-free), NOT ipc.ts — the sandboxed preload
// cannot require node builtins, so the engine must stay out of this bundle.
// chToMethod exposes the window.autocrew invoke methods (count = IPC_CHANNELS，见 channels.ts docs),
// plus onChatProgress / onEngineEvent — the only push listeners (fixed event name whitelist).

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

autocrew.onEngineEvent = (cb: (e: Record<string, unknown>) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) => cb(data);
  ipcRenderer.on(ENGINE_EVENT, handler);
  return () => ipcRenderer.removeListener(ENGINE_EVENT, handler);
};

contextBridge.exposeInMainWorld("autocrew", autocrew);
