import { afterEach, describe, expect, it, vi } from "vitest";

// 全体测试把本模块换成了假的（src/test-setup）；这里要测真的通知窗起不来时的反馈
const real = await vi.importActual<typeof import("./desktop-open.js")>("./desktop-open.js");
const savedPath = process.env.PATH;
afterEach(() => { process.env.PATH = savedPath; });

describe("osascriptNotifier", () => {
  it.skipIf(process.platform !== "darwin")("找不到 osascript：回失败原因，不假装弹出来了", async () => {
    process.env.PATH = "/nonexistent-autocrew-test";
    const r = await real.osascriptNotifier({ title: "t", message: "m", url: "http://127.0.0.1:1/" });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toMatch(/osascript/);
  });
});
