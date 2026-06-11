/**
 * IPC 边界纵深防御测试 — desktop/main.ts 在 ipcMain.handle 转交 handler 前
 * 调用的守卫逻辑（终审 2026-06-11：纵深防御项）。
 *
 *   sanitizePayload        — 剥掉 renderer payload 中所有 _ 前缀键，封死
 *                            _dataDir 测试注入 seam（settings:set 任意目录写）
 *   createPickedFileRegistry — dialog:pick_file 选过的路径白名单，
 *                            flywheel:import_csv 的 csv_path 必须命中
 *                            （封死 renderer→主进程任意文件读取面）
 */
import path from "node:path";
import { describe, it, expect } from "vitest";
import { sanitizePayload, createPickedFileRegistry } from "./ipc-guard.js";

// ── sanitizePayload ──────────────────────────────────────────────────────────

describe("sanitizePayload", () => {
  it("剥掉 _dataDir 和所有 _ 前缀键，保留正常键", () => {
    const clean = sanitizePayload({
      topic: "选题",
      platform: "douyin",
      _dataDir: "/tmp/evil",
      _anything: true,
    });
    expect(clean).toEqual({ topic: "选题", platform: "douyin" });
  });

  it("无 _ 前缀键时原样保留全部内容", () => {
    expect(sanitizePayload({ id: "c1", index: 0 })).toEqual({ id: "c1", index: 0 });
  });

  it("空对象返回空对象", () => {
    expect(sanitizePayload({})).toEqual({});
  });

  it("非对象 payload 原样透传 — handler 自己的 invalid-payload 守卫必须仍能触发", () => {
    expect(sanitizePayload(null)).toBeNull();
    expect(sanitizePayload(undefined)).toBeUndefined();
    expect(sanitizePayload("str")).toBe("str");
    expect(sanitizePayload(42)).toBe(42);
    const arr = [1, 2];
    expect(sanitizePayload(arr)).toBe(arr);
  });
});

// ── createPickedFileRegistry ─────────────────────────────────────────────────

describe("createPickedFileRegistry", () => {
  it("未选择过的路径一律拒绝", () => {
    const reg = createPickedFileRegistry();
    expect(reg.isAllowed("/etc/passwd")).toBe(false);
    expect(reg.isAllowed(path.join(import.meta.dirname, "ipc-guard.test.ts"))).toBe(false);
  });

  it("record 过的路径精确命中放行", () => {
    const reg = createPickedFileRegistry();
    reg.record("/tmp/exports/douyin.csv");
    expect(reg.isAllowed("/tmp/exports/douyin.csv")).toBe(true);
  });

  it("归一化等价路径（./ 与 ../ 折叠）也命中", () => {
    const reg = createPickedFileRegistry();
    reg.record("/tmp/exports/douyin.csv");
    expect(reg.isAllowed("/tmp/exports/./douyin.csv")).toBe(true);
    expect(reg.isAllowed("/tmp/other/../exports/douyin.csv")).toBe(true);
  });

  it("借白名单条目做目录穿越逃逸 → 拒绝", () => {
    const reg = createPickedFileRegistry();
    reg.record("/tmp/exports/douyin.csv");
    expect(reg.isAllowed("/tmp/exports/douyin.csv/../../../etc/passwd")).toBe(false);
    expect(reg.isAllowed("/tmp/exports/other.csv")).toBe(false);
  });

  it("非字符串 csv_path 一律拒绝", () => {
    const reg = createPickedFileRegistry();
    reg.record("/tmp/exports/douyin.csv");
    expect(reg.isAllowed(undefined)).toBe(false);
    expect(reg.isAllowed(null)).toBe(false);
    expect(reg.isAllowed(42)).toBe(false);
    expect(reg.isAllowed(["/tmp/exports/douyin.csv"])).toBe(false);
  });

  it("多次 record 全部保留（用户先后选过的文件都可重复导入）", () => {
    const reg = createPickedFileRegistry();
    reg.record("/a/1.csv");
    reg.record("/b/2.csv");
    expect(reg.isAllowed("/a/1.csv")).toBe(true);
    expect(reg.isAllowed("/b/2.csv")).toBe(true);
  });
});
