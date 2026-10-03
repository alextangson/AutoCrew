/**
 * ego-session.test.ts — ego lite 通道：输出判定、超时杀进程、会话收尾、抓取器经通道的端到端判定。
 * 全程注入假执行器 / 假二进制，不碰真 ego lite。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EGO_PAGE_MARKER, EGO_RESULT_MARKER, EGO_SPACE_MARKER } from "./ego-scripts.js";
import { pullWechatMpStats } from "./wechat-mp-stats.js";
import { EgoChannelError, EgoSession, parseEgoOutput, parsePageLines, probeEgoLite, resolveEgoBinary, spawnEgoRunner, type EgoRunner } from "./ego-session.js";
import { pullDouyinStats } from "./douyin-stats.js";
import { pullWechatVideoStats } from "./wechat-video-stats.js";
import { classifyThrown } from "./pull-shared.js";

const line = (o: unknown) => `${EGO_RESULT_MARKER}${JSON.stringify(o)}\n`;
const out = (stdout: string, over: Partial<Parameters<typeof parseEgoOutput>[0]> = {}) => ({
  stdout,
  stderr: "",
  exitCode: 0,
  timedOut: false,
  ...over,
});

/** 读脚本第一行 `const P = …` 里的参数，按参数形状路由假结果 */
const paramsOf = (script: string): Record<string, unknown> => JSON.parse(script.split("\n")[0].replace(/^const P = /, "").replace(/;$/, ""));

describe("parseEgoOutput — 输出不是预期 JSON 一律当通道故障", () => {
  const codeOf = (o: ReturnType<typeof out>) => {
    try {
      parseEgoOutput(o);
      return "no-throw";
    } catch (err) {
      return classifyThrown(err);
    }
  };

  it("正常结果行（stdout 或 stderr 都认，别的输出忽略）", () => {
    expect(parseEgoOutput(out(`[ego-browser:notice] update\n${line({ ok: true, spaceId: 3 })}`))).toMatchObject({ spaceId: 3 });
    expect(parseEgoOutput(out("", { stderr: line({ ok: true, x: 1 }) }))).toMatchObject({ x: 1 });
  });

  it("乱码 / 没有结果行 / 结果行不是 JSON / 缺 ok → error(ego_bad_output),零行", () => {
    expect(codeOf(out("garbage\n{not json"))).toEqual({ status: "error", rows: [], errorCode: "ego_bad_output" });
    expect(codeOf(out(`${EGO_RESULT_MARKER}{oops\n`))).toMatchObject({ errorCode: "ego_bad_output" });
    expect(codeOf(out(line({ spaceId: 1 })))).toMatchObject({ errorCode: "ego_bad_output" });
  });

  it("ego-browser 不在 → browser_unreachable(ego_missing);非零退出且无结果行 → ego_unreachable", () => {
    expect(codeOf(out("", { spawnError: "ENOENT", exitCode: null }))).toMatchObject({ status: "browser_unreachable", errorCode: "ego_missing" });
    expect(codeOf(out("", { exitCode: 1, stderr: "cannot connect" }))).toMatchObject({ status: "browser_unreachable", errorCode: "ego_unreachable" });
  });

  it("脚本里连不上 ego lite(stage connect) → browser_unreachable", () => {
    expect(codeOf(out(line({ ok: false, stage: "connect", error: "x" })))).toMatchObject({ status: "browser_unreachable" });
  });

  it("超时被杀 → timeout(ego_timeout)", () => {
    expect(codeOf(out("", { timedOut: true, exitCode: null }))).toMatchObject({ status: "timeout", errorCode: "ego_timeout" });
  });
});

describe("spawnEgoRunner — 真子进程（假二进制）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-ego-"));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const fakeBin = (name: string, body: string): string => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  };

  it("脚本走 stdin、参数是 nodejs", async () => {
    const bin = fakeBin("echo-ego", `[ "$1" = "nodejs" ] || exit 9\nread first\necho "${EGO_RESULT_MARKER}{\\"ok\\":true,\\"first\\":\\"$first\\"}"`);
    const r = await spawnEgoRunner(bin)("hello-script\n", 5_000);
    expect(parseEgoOutput(r)).toMatchObject({ ok: true, first: "hello-script" });
  });

  it("卡死 → 到点杀掉并记超时，不等它自己醒", async () => {
    const bin = fakeBin("hang-ego", "sleep 30");
    const started = Date.now();
    const r = await spawnEgoRunner(bin)("x", 200);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("二进制不存在 → spawnError，判 ego_missing", async () => {
    const r = await spawnEgoRunner(null)("x", 200);
    expect(r.spawnError).toBe("ENOENT");
  });

  it("resolveEgoBinary：PATH 里没有时也找 ~/.local/bin", () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    const p = path.join(home, ".local", "bin", "ego-browser");
    fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveEgoBinary({ PATH: "/nonexistent" }, home)).toBe(p);
    expect(resolveEgoBinary({ PATH: "/nonexistent" }, path.join(tmp, "nobody"))).toBeNull();
  });
});

const BROWSE_ARGS = {
  url: "https://x.test", patterns: ["p"], gates: {}, next: { kind: "scroll" as const }, inspectSrc: "() => ({})",
  cutoffMs: 0, maxPages: 3, waitMs: 1, nextWaitMs: 1, settleMs: 0, navTimeoutMs: 1, pauseMinMs: 0, pauseMaxMs: 0,
};
const spaceLine = (id: number) => `${EGO_SPACE_MARKER}${id}\n`;
const pageLine = (index: number, body = '{"errCode":0,"data":{"list":[]}}') =>
  `${EGO_PAGE_MARKER}${JSON.stringify({ index, responses: [{ url: "u", status: 201, body }] })}\n`;

describe("EgoSession.browse — 总超时与收尾", () => {
  it("正常结束：交回页与 end/gate，只跑一个子进程（脚本自己 finish）", async () => {
    const calls: string[] = [];
    const runner: EgoRunner = async (script) => (calls.push(script), out(spaceLine(3) + pageLine(0) + line({ ok: true, spaceId: 3, pages: 1, end: "no_more", gate: null })));
    const r = await new EgoSession({ label: "t", runner }).browse(BROWSE_ARGS);
    expect(r).toMatchObject({ end: "no_more", gate: null, pages: [{ index: 0 }] });
    expect(calls).toHaveLength(1);
  });

  it("总超时（子进程被杀）→ 已打出的完整页照样交回，半截页丢弃，父进程按 spaceId 兜底 finish", async () => {
    const calls: Array<{ script: string; timeoutMs: number }> = [];
    const runner: EgoRunner = async (script, timeoutMs) => {
      calls.push({ script, timeoutMs });
      if (calls.length === 1) return out(spaceLine(17) + pageLine(0) + `${EGO_PAGE_MARKER}{"index":1,"respo`, { timedOut: true, exitCode: null });
      return out(line({ ok: true, spaceId: 17 }));
    };
    const r = await new EgoSession({ label: "wechat_video", runner, totalTimeoutMs: 5_000 }).browse(BROWSE_ARGS);
    expect(r.end).toBe("error");
    expect(r.pages.map((p) => p.index)).toEqual([0]);
    expect(r.error).toMatchObject({ status: "timeout", code: "ego_timeout" });
    expect(calls[0].timeoutMs).toBeLessThanOrEqual(5_000);
    expect(calls[1].script).toContain("task.finish({ keep: [] })");
    expect(paramsOf(calls[1].script)).toEqual({ space: 17 });
  });

  it("总时长已用完 → 不开子进程，直接 timeout", async () => {
    let t = 0;
    const calls: string[] = [];
    const s = new EgoSession({ label: "t", runner: async (x) => (calls.push(x), out("")), totalTimeoutMs: 10, now: () => t });
    t = 20;
    await expect(s.browse(BROWSE_ARGS)).rejects.toMatchObject({ status: "timeout" });
    expect(calls).toHaveLength(0);
  });

  it("没报出 spaceId 就被杀 → 不猜，错误码里写明没能兜底", async () => {
    const calls: string[] = [];
    const runner: EgoRunner = async (script) => (calls.push(script), out("", { timedOut: true, exitCode: null }));
    const r = await pullDouyinStats({ runner });
    expect(r).toMatchObject({ status: "timeout", rows: [], errorCode: "ego_timeout:cleanup_skipped_no_space_id" });
    expect(calls).toHaveLength(1);
  });

  it("脚本自己报了结果（已自行 finish）→ 父进程不重复关", async () => {
    const calls: string[] = [];
    const runner: EgoRunner = async (script) => (calls.push(script), out(spaceLine(5) + line({ ok: false, stage: "op", spaceId: 5, error: "x" })));
    const r = await new EgoSession({ label: "douyin", runner }).browse(BROWSE_ARGS);
    expect(r.end).toBe("error");
    expect(calls).toHaveLength(1);
  });

  it("结果行缺 end → ego_bad_output", async () => {
    const r = await new EgoSession({ label: "t", runner: async () => out(line({ ok: true, spaceId: 1 })) }).browse(BROWSE_ARGS);
    expect(r).toMatchObject({ end: "error", error: { code: "ego_bad_output" } });
  });

  it("parsePageLines：stdout/stderr 都认，同页去重，按页序排", () => {
    const pages = parsePageLines(out(pageLine(1), { stderr: pageLine(0) + pageLine(1) }));
    expect(pages.map((p) => p.index)).toEqual([0, 1]);
  });
});

describe("抓取器经 ego 通道的端到端判定（假执行器）", () => {
  it("视频号跳了登录页 → needs_login，零行", async () => {
    const runner: EgoRunner = async () => out(line({ ok: true, spaceId: 1, pages: 0, end: "gate", gate: "login" }));
    expect(await pullWechatVideoStats({ runner })).toEqual({ status: "needs_login", rows: [], errorCode: "login_page" });
  });

  it("ego-browser 吐乱码 → error(ego_bad_output)，零行，不当空数据", async () => {
    const runner: EgoRunner = async () => out("Segmentation fault\n");
    expect(await pullDouyinStats({ runner })).toEqual({ status: "error", rows: [], errorCode: "ego_bad_output:cleanup_skipped_no_space_id" });
  });

  it("ego lite 没开 → browser_unreachable(ego_unreachable)", async () => {
    const runner: EgoRunner = async () => out(line({ ok: false, stage: "connect", error: "ECONNREFUSED" }));
    expect(await pullDouyinStats({ runner })).toMatchObject({ status: "browser_unreachable", errorCode: "ego_unreachable" });
  });

  it("公众号没登录（首页没跳出 token，页面是登录页）→ needs_login", async () => {
    const runner: EgoRunner = async () => out(line({ ok: true, spaceId: 2, pages: 0, end: "no_response", gate: "login" }));
    expect(await pullWechatMpStats({ runner })).toMatchObject({ status: "needs_login", rows: [] });
  });
});

describe("probeEgoLite（doctor）", () => {
  it("命令不在 → 给出安装指引", async () => {
    const r = await probeEgoLite(async () => out(""), null);
    expect(r).toMatchObject({ reachable: false, fix: expect.stringContaining("ego lite") });
  });

  it("连不上 → 给出打开 ego lite 的指引；连得上 → reachable", async () => {
    const down = await probeEgoLite(async () => out("", { exitCode: 1 }), "/x/ego-browser");
    expect(down).toMatchObject({ reachable: false, fix: expect.stringContaining("打开 ego lite") });
    const up = await probeEgoLite(async () => out(line({ ok: true, spaces: 0 })), "/x/ego-browser");
    expect(up).toEqual({ binary: "/x/ego-browser", reachable: true });
  });

  it("EgoChannelError 是 Error（classifyThrown 认得）", () => {
    expect(new EgoChannelError("timeout", "ego_timeout", "x")).toBeInstanceOf(Error);
  });
});

describe("P2-2 多字节 UTF-8 跨 chunk 不乱码", () => {
  it("中文字被拆在两个 chunk 里也完整还原", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-ego-utf8-"));
    const bin = path.join(tmp, "split-ego");
    // 「中」= e4 b8 ad：第一块只写 e4，停一下再写剩下两个字节
    fs.writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\nprintf '${EGO_RESULT_MARKER}{"ok":true,"t":"\\344'\nsleep 0.2\nprintf '\\270\\255文"}\\n'\nprintf '\\344' >&2\nsleep 0.2\nprintf '\\270\\255' >&2\n`, { mode: 0o755 });
    const r = await spawnEgoRunner(bin)("x", 5_000);
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(parseEgoOutput(r)).toMatchObject({ t: "中文" });
    expect(r.stderr).toBe("中");
  });
});

describe("P2-3 结果行 ok:true 但进程异常退出 → 不算成功", () => {
  it("非零退出码 / 被信号杀掉 → error(ego_abnormal_exit)", () => {
    for (const exitCode of [1, null]) {
      expect(() => parseEgoOutput(out(line({ ok: true, spaceId: 1 }), { exitCode }))).toThrow(
        expect.objectContaining({ status: "error", code: "ego_abnormal_exit" }),
      );
    }
  });
});
