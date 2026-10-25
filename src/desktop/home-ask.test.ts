/**
 * 首页「让 AI 看看」（管线重规划 §8-11）：三种指令点名对的工具；三种交接结果如实；没 AI 没钥匙明说；复盘要有稿件。
 * 资料库是临时目录，宿主选择与打开都注入，不碰真实的 ~/.autocrew 和桌面 App。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { initializeProjectLayout } from "../storage/content-project.js";
import { saveContent } from "../storage/local-store.js";
import { askAI, insightsPrompt, meetingPrompt, retroPrompt } from "./home-ask.js";

let dir: string;
const spawnImpl = vi.fn(() => { const c = new EventEmitter(); setImmediate(() => c.emit("exit", 0)); return c; }) as unknown as typeof spawn;
const host = (h: "claude" | "codex", label: string) => ({ platform: "darwin" as const, spawnImpl, programDir: "/opt/autocrew", writer: () => ({ ok: true as const, host: h, label }) });
const none = (engine: boolean) => ({ platform: "darwin" as const, spawnImpl, writer: () => ({ ok: false as const, code: "no_writer" as const, error: "没接 AI" }), engineReady: async () => engine });

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "autocrew-home-ask-")));
  await initializeProjectLayout(dir, "lib-deadbeef", "default");
  vi.mocked(spawnImpl).mockClear();
});
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

describe("指令", () => {
  it("账号洞察走 autocrew_insights prepare / submit；排期会走 schedule-meeting + meeting_brief；复盘带 content_id 和 calib_retro", () => {
    expect(insightsPrompt()).toMatch(/autocrew_insights[\s\S]*prepare[\s\S]*submit/);
    expect(meetingPrompt()).toMatch(/schedule-meeting[\s\S]*meeting_brief/);
    const r = retroPrompt("刚发那条", "content-1-a");
    for (const s of ["content-1-a", "autocrew_content summary", "calib_status", "calib_retro"]) expect(r).toContain(s);
    for (const p of [insightsPrompt(), meetingPrompt(), r]) expect(p).toContain("不编数字");
  });
});

describe("交接结果", () => {
  it("Claude 预填（不用粘贴）/ Codex 要粘贴 / 总编辑填进对话框", async () => {
    expect(await askAI({ kind: "insights" }, dir, host("claude", "Claude Code"))).toMatchObject({ ok: true, kind: "insights", host: "claude", opened: true, paste: false });
    expect(await askAI({ kind: "meeting" }, dir, host("codex", "Codex"))).toMatchObject({ ok: true, host: "codex", paste: true });
    expect(await askAI({ kind: "meeting" }, dir, none(true))).toMatchObject({ ok: true, host: "chief", paste: false, opened: false });
  });

  it("没本机 AI 也没模型钥匙：no_writer，不假装交出去", async () => {
    expect(await askAI({ kind: "insights" }, dir, none(false))).toMatchObject({ ok: false, code: "no_writer" });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("复盘：没有稿件 id / 稿不存在都明说；有稿时指令带标题", async () => {
    expect(await askAI({ kind: "retro" }, dir, host("claude", "Claude Code"))).toMatchObject({ ok: false, code: "no_latest" });
    expect(await askAI({ kind: "retro", content_id: "content-1-zzzzzz" }, dir, host("claude", "Claude Code"))).toMatchObject({ ok: false });
    const c = await saveContent({ title: "垫底的不是最难用的", body: "", platform: "douyin", status: "drafting", tags: [] }, dir);
    const r = await askAI({ kind: "retro", content_id: c.id }, dir, host("codex", "Codex"));
    expect(r).toMatchObject({ ok: true, kind: "retro" });
    expect((r as { prompt: string }).prompt).toContain("垫底的不是最难用的");
  });

  it("不认识的类型拒掉", async () => {
    expect(await askAI({ kind: "rm -rf" }, dir, host("claude", "Claude Code"))).toMatchObject({ ok: false, code: "bad_request" });
  });
});
