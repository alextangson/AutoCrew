import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "path";
import { IPC_CHANNELS, buildIpcHandlers, type IpcHandlerContext } from "../src/desktop/ipc.js";
import { CHAT_PROGRESS_EVENT, ENGINE_EVENT } from "../src/desktop/channels.js";
import { initEventHub, emitEngineEvent, type EngineEventRole } from "../src/desktop/event-hub.js";
import { sanitizePayload, createPickedFileRegistry } from "../src/desktop/ipc-guard.js";
import { refreshTopicRadar } from "../src/modules/radar/topic-radar.js";
import { MEDIA_EXTENSIONS } from "../src/storage/library-store.js";

// __dirname comes from Node's CJS module wrapper in the bundled output
declare const __dirname: string;

// csv_path 白名单：只有 dialog:pick_file 真实返回过的路径才能进 import_csv
const pickedFiles = createPickedFileRegistry();
// 媒体路径白名单：只有 dialog:pick_media 真实返回过的路径才能进 library:add / library:update path
const pickedMedia = createPickedFileRegistry();

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
  "dialog:pick_media": async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "媒体文件", extensions: [...MEDIA_EXTENSIONS.video, ...MEDIA_EXTENSIONS.image, ...MEDIA_EXTENSIONS.audio] },
        { name: "全部文件", extensions: ["*"] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: true, data: { paths: [] } };
    for (const p of res.filePaths) pickedMedia.record(p);
    return { ok: true, data: { paths: res.filePaths } };
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
  ipcMain.handle(ch, (event, payload: unknown) => {
    const clean = sanitizePayload(payload) as Record<string, unknown>;
    if (ch === "flywheel:import_csv" && !pickedFiles.isAllowed(clean?.csv_path)) {
      return { ok: false, error: "csv_path 必须是通过文件选择对话框选中的文件" };
    }
    if (ch === "library:add") {
      const paths = Array.isArray(clean?.paths) ? (clean.paths as unknown[]) : [];
      if (paths.length === 0 || !paths.every((p) => pickedMedia.isAllowed(p))) {
        return { ok: false, error: "素材路径必须来自文件选择对话框" };
      }
    }
    if (ch === "library:update" && clean?.path !== undefined) {
      if (!pickedMedia.isAllowed(clean.path)) {
        return { ok: false, error: "重新定位的路径必须来自文件选择对话框" };
      }
    }
    const ctx: IpcHandlerContext = {
      onProgress: (e) => {
        try {
          event.sender.send(CHAT_PROGRESS_EVENT, e);
        } catch {
          /* 窗口已销毁 */
        }
        // 工作日志桥（P1 一期）：工具开工线是真实事件；end 由 presence 消费，不重复记日志
        const pe = e as { phase?: string; role?: string | null; label?: string };
        if (pe.phase === "start") {
          void emitEngineEvent({
            role: (pe.role as EngineEventRole) || "system",
            kind: "work",
            label: pe.label || "工作中",
          });
        }
      },
    };
    return handlers[ch](clean, ctx);
  });
}

app.whenReady().then(() => {
  // 事件总线广播：推给所有窗口（单窗应用；窗口销毁的 send 失败在 hub 内吞掉）
  initEventHub((e) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(ENGINE_EVENT, e);
    }
  });

  createWindow();

  // 选题雷达：启动 fire-and-forget 刷新（PRD §7.1——定期抓取归外层调度，v1=启动时）
  void refreshTopicRadar()
    .then((r) => {
      if (r.failedSources.length > 0) console.warn("[topic-radar] 部分源失败：", r.failedSources.join(", "));
    })
    .catch((err) => {
      console.error("[topic-radar] 启动刷新失败：", err instanceof Error ? err.message : err);
    });

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
