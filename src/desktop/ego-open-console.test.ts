/**
 * 「打开 XX 后台」在 ego lite 里开（2026-10-25）：地址按平台在服务端查、交给用户登录（handOff，不 finish）；
 * ego lite 没装 / 没开着照实说并给地址，不退回默认浏览器。执行器全部注入，测试绝不碰真 ego lite。
 */
import { afterEach, describe, expect, it } from "vitest";
import { openConsoleHandler, setOpenConsoleRunner } from "./ego-open-console.js";
import { EGO_RESULT_MARKER, openForUserScript } from "../adapters/browser/ego-scripts.js";
import type { EgoRunOutput } from "../adapters/browser/ego-session.js";
import { validatePayload } from "./channel-contracts.js";

afterEach(() => setOpenConsoleRunner(null));

function capture(out: Partial<EgoRunOutput>) {
  const scripts: string[] = [];
  setOpenConsoleRunner(async (script) => { scripts.push(script); return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...out }; });
  return scripts;
}
const ok = { stdout: `${EGO_RESULT_MARKER}${JSON.stringify({ ok: true, spaceId: 3 })}\n` };

describe("ego:open_console", () => {
  it("视频号数据后台：在 ego lite 里打开 channels.weixin.qq.com，交给用户", async () => {
    const scripts = capture(ok);
    const r = await openConsoleHandler({ platform: "wechat_video" });
    expect(r).toMatchObject({ ok: true, data: { url: "https://channels.weixin.qq.com", message: expect.stringContaining("ego lite") } });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(JSON.stringify("https://channels.weixin.qq.com"));
    expect(scripts[0]).toContain("task.handOff()");
  });

  it("publish 目标开发布页；公众号开图文编辑页（和原来复制文案后打开的一样）", async () => {
    capture(ok);
    expect(await openConsoleHandler({ platform: "douyin", target: "publish" })).toMatchObject({ ok: true, data: { url: "https://creator.douyin.com/creator-micro/content/upload" } });
    expect(await openConsoleHandler({ platform: "wechat_mp", target: "publish" })).toMatchObject({ ok: true, data: { url: expect.stringContaining("https://mp.weixin.qq.com/cgi-bin/appmsg") } });
  });

  it("图文平台（twitter / reddit / toutiao）也开得了发布页", async () => {
    capture(ok);
    for (const [p, url] of [["twitter", "https://x.com/compose/post"], ["reddit", "https://www.reddit.com/submit"], ["toutiao", "https://mp.toutiao.com/profile_v4/graphic/publish"]]) {
      expect(await openConsoleHandler({ platform: p, target: "publish" })).toMatchObject({ ok: true, data: { url } });
    }
  });

  it("不认识的平台：拒，不起子进程；契约要 platform", async () => {
    const scripts = capture(ok);
    expect(await openConsoleHandler({ platform: "https://evil.example" })).toMatchObject({ ok: false });
    expect(scripts).toEqual([]);
    expect(validatePayload("ego:open_console", {})).toContain("platform");
  });

  it("ego lite 没装：说装 ego lite、给地址、别在 Chrome 里登录", async () => {
    capture({ spawnError: "ENOENT", exitCode: null });
    const r = await openConsoleHandler({ platform: "wechat_video" });
    expect(r).toMatchObject({ ok: false, data: { url: "https://channels.weixin.qq.com" } });
    expect(String(r.error)).toMatch(/没找到 ego lite.*channels\.weixin\.qq\.com.*不要在 Chrome 里登录/);
  });

  it("ego lite 没开着（连不上）：说先打开 ego lite", async () => {
    capture({ stdout: `${EGO_RESULT_MARKER}${JSON.stringify({ ok: false, stage: "connect", error: "no server" })}\n` });
    expect(String((await openConsoleHandler({ platform: "douyin" })).error)).toContain("ego lite 没在运行");
  });
});

describe("openForUserScript", () => {
  it("成功路径不 finish（finish 会把交给用户的页一起关掉）；出错才收尾", () => {
    const s = openForUserScript({ space: "x", url: "https://channels.weixin.qq.com" });
    const okPath = s.slice(s.indexOf("task.handOff()"), s.indexOf("} catch (e) {\n    failed = true;"));
    expect(okPath).not.toContain("finish(");
    expect(s).toContain("finish({ keep: [] })");
  });
});
