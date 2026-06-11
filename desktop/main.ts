import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "path";
import { IPC_CHANNELS, buildIpcHandlers } from "../src/desktop/ipc.js";

// __dirname comes from Node's CJS module wrapper in the bundled output
declare const __dirname: string;

const handlers = buildIpcHandlers({
  // 真实现只活在主进程 — ipc.ts 保持纯净可测（计划锁定决定）
  "dialog:pick_file": async () => {
    const res = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: true, data: { path: null } };
    return { ok: true, data: { path: res.filePaths[0] } };
  },
});

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return win;
}

for (const ch of IPC_CHANNELS) {
  ipcMain.handle(ch, (_event, payload: Record<string, unknown>) =>
    handlers[ch](payload),
  );
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
