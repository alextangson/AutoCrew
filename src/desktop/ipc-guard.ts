/**
 * IPC 边界纵深防御 — desktop/main.ts 在 ipcMain.handle 转交 handler 前调用。
 *
 * 威胁模型：contextIsolation + CSP 下 renderer 不可达，但按纵深防御原则，
 * 主进程不信任任何 renderer payload（终审 2026-06-11）：
 *
 *   1. `_` 前缀键是主进程/测试内部保留 seam（_dataDir 等）——被攻陷的
 *      renderer 可借 settings:set + _dataDir 把含 apiKey 的 engine.json
 *      写到任意目录。sanitizePayload 在边界统一剥掉（镜像 chat-router.ts
 *      对模型 tool_call args 的 sanitize）。
 *   2. flywheel:import_csv 的 csv_path 是 renderer→主进程的任意文件读取面。
 *      createPickedFileRegistry 维护 dialog:pick_file 真实返回过的路径白名单，
 *      import 时 csv_path 必须命中——路径先 resolve 归一化，穿越变体无效。
 *
 * 本模块保持纯净（仅依赖 node:path），vitest 直接覆盖；electron 接线在
 * desktop/main.ts，由 scripts/smoke-desktop-load.mts 断言。
 */
import path from "node:path";

/** 剥掉 payload 中所有 `_` 前缀键。非对象原样透传，让 handler 自身的 invalid-payload 守卫继续生效。 */
export function sanitizePayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return Object.fromEntries(
    Object.entries(payload).filter(([k]) => !k.startsWith("_")),
  );
}

export interface PickedFileRegistry {
  /** dialog:pick_file 每次真实返回路径时调用 */
  record(filePath: string): void;
  /** csv_path 必须精确命中（resolve 归一化后）某条用户选过的路径 */
  isAllowed(filePath: unknown): boolean;
}

export function createPickedFileRegistry(): PickedFileRegistry {
  const picked = new Set<string>();
  return {
    record(filePath: string): void {
      picked.add(path.resolve(filePath));
    },
    isAllowed(filePath: unknown): boolean {
      return typeof filePath === "string" && picked.has(path.resolve(filePath));
    },
  };
}
