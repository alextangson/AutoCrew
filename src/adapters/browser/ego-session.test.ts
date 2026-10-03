/**
 * ego-session.test.ts — ego lite 通道：输出判定、超时杀进程、会话收尾、抓取器经通道的端到端判定。
 * 全程注入假执行器 / 假二进制，不碰真 ego lite。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EGO_RESULT_MARKER } from "./ego-scripts.js";
import { EgoChannelError, EgoSession, parseEgoOutput, probeEgoLite, resolveEgoBinary, spawnEgoRunner, type EgoRunner } from "./ego-session.js";
import { pullDouyinStats } from "./douyin-stats.js";
import { pullXhsStats } from "./xhs-stats.js";
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

describe("EgoSession — 总超时与收尾", () => {
  it("总超时用完：后续步骤直接判 timeout，但 closeTarget 照样 finish", async () => {
    let t = 0;
    const scripts: string[] = [];
    const runner: EgoRunner = async (script) => {
      scripts.push(script);
      t += 1_000; // 每步耗 1 秒
      return out(line({ ok: true, spaceId: 9, value: "x" }));
    };
    const s = new EgoSession({ label: "t", runner, totalTimeoutMs: 1_500, now: () => t });
    const tab = await s.openTab("https://x.test");
    await s.eval("1", tab.sessionId);
    await expect(s.eval("1", tab.sessionId)).rejects.toMatchObject({ status: "timeout", code: "ego_timeout" });
    await s.closeTarget(tab.targetId);
    expect(scripts.at(-1)).toContain("task.finish({ keep: [] })");
    expect(paramsOf(scripts.at(-1)!)).toEqual({ space: 9 });
  });

  it("子进程被杀（超时）后也关 TaskSpace：抓取器 withTab 的 finally 照跑", async () => {
    const calls: string[] = [];
    const runner: EgoRunner = async (script) => {
      const p = paramsOf(script);
      if (typeof p.space === "string") return calls.push("open"), out(line({ ok: true, spaceId: 5 }));
      if ("expression" in p) return calls.push("eval"), out("", { timedOut: true, exitCode: null });
      calls.push("finish");
      return out(line({ ok: true, spaceId: 5 }));
    };
    const r = await pullXhsStats({ connect: async () => ({ session: new EgoSession({ label: "xhs", runner }) }), navTimeoutMs: 50 });
    expect(r).toMatchObject({ status: "timeout", rows: [] });
    expect(calls.at(-1)).toBe("finish");
  });
});

describe("抓取器经 ego 通道的端到端判定（假执行器）", () => {
  it("抖音跳了登录页（页面文本是登录墙）→ needs_login", async () => {
    const runner: EgoRunner = async () => out(line({ ok: true, spaceId: 1, matched: 0, bodies: [], domText: "扫码登录 抖音创作者中心" }));
    const r = await pullDouyinStats({ connect: () => new EgoSession({ label: "douyin", runner }) });
    expect(r).toMatchObject({ status: "needs_login", rows: [], errorCode: "dom_login_wall" });
  });

  it("小红书登录 ping 401（登录过期）→ needs_login，并且关了 TaskSpace", async () => {
    const ops: string[] = [];
    const runner: EgoRunner = async (script) => {
      const p = paramsOf(script);
      if (typeof p.space === "string") return ops.push("open"), out(line({ ok: true, spaceId: 7 }));
      if ("expression" in p) return ops.push("eval"), out(line({ ok: true, spaceId: 7, value: "creator.xiaohongshu.com|complete" }));
      if ("init" in p) {
        ops.push("fetch");
        return out(line({ ok: true, spaceId: 7, response: { httpStatus: 401, finalUrl: "https://creator.xiaohongshu.com/login", contentType: "application/json", bodyText: "{}" } }));
      }
      ops.push("finish");
      return out(line({ ok: true, spaceId: 7 }));
    };
    const r = await pullXhsStats({ connect: async () => ({ session: new EgoSession({ label: "xhs", runner }) }) });
    expect(r).toMatchObject({ status: "needs_login", rows: [] });
    expect(ops[0]).toBe("open");
    expect(ops.at(-1)).toBe("finish");
  });

  it("ego-browser 吐乱码 → error(ego_bad_output)，零行，不当空数据", async () => {
    const runner: EgoRunner = async () => out("Segmentation fault\n");
    const r = await pullDouyinStats({ connect: () => new EgoSession({ label: "douyin", runner }) });
    expect(r).toEqual({ status: "error", rows: [], errorCode: "ego_bad_output" });
  });

  it("ego lite 没开 → browser_unreachable(ego_unreachable)", async () => {
    const runner: EgoRunner = async () => out(line({ ok: false, stage: "connect", error: "ECONNREFUSED" }));
    const r = await pullDouyinStats({ connect: () => new EgoSession({ label: "douyin", runner }) });
    expect(r).toMatchObject({ status: "browser_unreachable", errorCode: "ego_unreachable" });
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
