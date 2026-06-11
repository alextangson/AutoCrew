import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "path";
import { IPC_CHANNELS, buildIpcHandlers } from "../src/desktop/ipc.js";
import { sanitizePayload, createPickedFileRegistry } from "../src/desktop/ipc-guard.js";
import { refreshTopicRadar } from "../src/modules/radar/topic-radar.js";

// __dirname comes from Node's CJS module wrapper in the bundled output
declare const __dirname: string;

// csv_path 白名单：只有 dialog:pick_file 真实返回过的路径才能进 import_csv
const pickedFiles = createPickedFileRegistry();

const handlers = buildIpcHandlers({
  // 真实现只活在主进程 — ipc.ts 保持纯净可测（计划锁定决定）
  "dialog:pick_file": async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: true, data: { path: null } };
    pickedFiles.record(res.filePaths[0]);
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

// 纵深防御（终审 2026-06-11）：转交前剥掉 `_` 前缀键（_dataDir seam），
// import_csv 的 csv_path 必须命中用户选过的文件白名单。
for (const ch of IPC_CHANNELS) {
  ipcMain.handle(ch, (_event, payload: unknown) => {
    const clean = sanitizePayload(payload) as Record<string, unknown>;
    if (ch === "flywheel:import_csv" && !pickedFiles.isAllowed(clean?.csv_path)) {
      return { ok: false, error: "csv_path 必须是通过文件选择对话框选中的文件" };
    }
    return handlers[ch](clean);
  });
}

app.whenReady().then(() => {
  createWindow();

  // 选题雷达：启动 fire-and-forget 刷新（PRD §7.1——定期抓取归外层调度，v1=启动时）
  void refreshTopicRadar().catch(() => {});

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
