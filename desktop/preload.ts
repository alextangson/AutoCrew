import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, chToMethod } from "../src/desktop/channels.js";

// Imports channels.ts (dependency-free), NOT ipc.ts — the sandboxed preload
// cannot require node builtins, so the engine must stay out of this bundle.
// chToMethod exposes the 17 window.autocrew methods (see channels.ts docs).

const autocrew = Object.fromEntries(
  IPC_CHANNELS.map((ch) => [
    chToMethod(ch),
    (payload?: Record<string, unknown>) =>
      ipcRenderer.invoke(ch, payload ?? {}),
  ]),
);

contextBridge.exposeInMainWorld("autocrew", autocrew);
