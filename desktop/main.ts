import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import { IPC_CHANNELS, buildIpcHandlers } from "../src/desktop/ipc.js";

// __dirname comes from Node's CJS module wrapper in the bundled output
declare const __dirname: string;

const handlers = buildIpcHandlers();

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
