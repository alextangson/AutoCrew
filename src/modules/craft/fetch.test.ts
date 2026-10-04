/** craft:fetch 编排：用假的 yt-dlp（函数替身）跑成功、限流重试/熔断/断点续抓、缺字幕、缺热度条、评论失败保留字幕、--clean */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanCreator, runCraftFetch, type FetchOptions } from "./fetch.js";
import { YtdlpError, type YtdlpExec } from "./ytdlp.js";

const A = "aaaaaaaaaaa", B = "bbbbbbbbbbb", C = "ccccccccccc";
const url = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const HEAT = Array.from({ length: 20 }, (_, i) => ({ start_time: i * 30, end_time: i * 30 + 30, value: i === 4 ? 1 : i === 12 ? 0.05 : 0.3 + (i % 3) * 0.1 }));
const VTT = "WEBVTT\n\n00:02:10.000 --> 00:02:12.000\nthe big promise\n\n00:02:12.000 --> 00:02:14.000\nthe big promise\nnext line\n\n00:02:14.000 --> 00:02:15.000\nnext line\n";

const baseInfo = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `T ${id}`, channel: "Dan Koe", uploader_id: "@DanKoeTalks", view_count: 1000, like_count: 50, comment_count: 10,
  duration: 600, upload_date: "20260101", heatmap: HEAT, subtitles: { en: [{}] }, automatic_captions: { "en-orig": [{}] }, language: "en", ...extra,
});

type Handler = (args: string[], n: number) => { stdout?: string; stderr?: string } | YtdlpError | undefined;

let dir: string;
let calls: string[][];

function fake(infos: Record<string, Record<string, unknown>>, handler: Handler = () => undefined): YtdlpExec {
  return async (args) => {
    calls.push(args);
    const r = handler(args, calls.length);
    if (r instanceof YtdlpError) throw r;
    if (r) return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    const li = args.indexOf("--load-info-json");
    if (li >= 0) {
      const info = JSON.parse(await fs.readFile(args[li + 1], "utf8"));
      const lang = args[args.indexOf("--sub-langs") + 1];
      const tpl = args[args.indexOf("-o") + 1].replace("%(id)s", info.id).replace(".%(ext)s", "");
      await fs.writeFile(`${tpl}.${lang}.vtt`, VTT);
      return { stdout: "", stderr: "" };
    }
    const id = args[args.length - 1].split("v=")[1];
    if (args.includes("--write-comments")) {
      return { stdout: JSON.stringify({ ...infos[id], comments: [
        { text: "low", like_count: 1, author: "x", parent: "root" }, { text: "top", like_count: 9, author: "y", author_thumbnail: "t", parent: "root" },
        { text: "reply", like_count: 99, parent: "abc" },
      ] }), stderr: "" };
    }
    return { stdout: JSON.stringify(infos[id]), stderr: "" };
  };
}

const run = (o: Partial<FetchOptions> & Pick<FetchOptions, "urls" | "exec">) =>
  runCraftFetch({ outDir: dir, sleep: async () => {}, pauseMs: () => 0, backoffMs: () => 0, ...o });
const readJson = async (f: string) => JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
const subCalls = () => calls.filter((c) => c.includes("--load-info-json"));

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "craft-fetch-")); calls = []; });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("craft:fetch 成功路径", () => {
  it("写 <id>.json / .txt / .peaks.json / index.json；字幕去重；先人工字幕；重看强度带 ±20 秒字幕", async () => {
    const s = await run({ urls: [url(A)], exec: fake({ [A]: baseInfo(A) }) });
    expect(s).toMatchObject({ ok: true, done: 1, failed: 0 });
    const rec = await readJson(`${A}.json`);
    expect(rec).toMatchObject({ title: `T ${A}`, view_count: 1000, like_count: 50, comment_count: 10, duration: 600, upload_date: "20260101" });
    expect(rec.subtitles).toMatchObject({ status: "ok", source: "manual", lang: "en" });
    expect(rec.comments.status).toBe("not_requested");
    expect(await fs.readFile(path.join(dir, `${A}.txt`), "utf8")).toBe("[02:10] the big promise\n[02:12] next line\n");
    const peaks = await readJson(`${A}.peaks.json`);
    expect(peaks.metric).toBe("replay_intensity");
    expect(peaks.top[0]).toMatchObject({ seconds: 135, value: 1, excerpt: "the big promise next line" });
    expect(peaks.bottom[0].seconds).toBe(375);
    expect((await readJson("index.json")).videos[0]).toMatchObject({ id: A, status: "ok", subtitles: "manual:en", heatmap: true });
    expect(calls.every((c) => !c.includes("--write-comments"))).toBe(true);
  });

  it("没有人工字幕就取自动 en-orig；非英语视频的自动 en 是翻译轨，不取", async () => {
    await run({ urls: [url(A), url(B)], exec: fake({
      [A]: baseInfo(A, { subtitles: {} }),
      [B]: baseInfo(B, { subtitles: {}, automatic_captions: { en: [{}], de: [{}] }, language: "de" }),
    }) });
    expect((await readJson(`${A}.json`)).subtitles).toMatchObject({ status: "ok", source: "auto", lang: "en-orig" });
    expect(subCalls()[0]).toContain("--write-auto-subs");
    expect((await readJson(`${B}.json`)).subtitles.status).toBe("none");
  });

  it("--comments N：只留正文和点赞，不留用户名和楼中楼，按点赞排", async () => {
    await run({ urls: [url(A)], comments: 5, exec: fake({ [A]: baseInfo(A) }) });
    const rec = await readJson(`${A}.json`);
    expect(rec.comments).toMatchObject({ status: "ok", items: [{ text: "top", likes: 9 }, { text: "low", likes: 1 }] });
    expect(JSON.stringify(rec.comments)).not.toMatch(/author|reply/);
    expect(calls.find((c) => c.includes("--write-comments"))).toContain("youtube:max_comments=5,5,0,0;comment_sort=top");
  });

  it("没给 --out：按第一条视频的频道 id 定博主目录，元数据复用不重抓", async () => {
    const root = path.join(dir, "root");
    const s = await runCraftFetch({ urls: [url(A)], craftRoot: root, exec: fake({ [A]: baseInfo(A) }), sleep: async () => {} });
    expect(s.outDir).toBe(path.join(root, "dankoetalks"));
    expect(calls.filter((c) => c.includes("-J")).length).toBe(1);
  });
});

describe("缺东西照实写缺", () => {
  it("没字幕：不写 .txt，json 标 none；没热度条：peaks 为空并说明", async () => {
    await run({ urls: [url(A)], exec: fake({ [A]: baseInfo(A, { subtitles: {}, automatic_captions: {}, heatmap: null, like_count: undefined }) }) });
    const rec = await readJson(`${A}.json`);
    expect(rec).toMatchObject({ heatmap: null, like_count: null, subtitles: { status: "none" } });
    await expect(fs.stat(path.join(dir, `${A}.txt`))).rejects.toThrow();
    const peaks = await readJson(`${A}.peaks.json`);
    expect(peaks).toMatchObject({ top: [], bottom: [] });
    expect(peaks.note).toContain("没有热度条");
    expect((await readJson("index.json")).videos[0]).toMatchObject({ status: "ok", subtitles: "none", heatmap: false });
  });

  it("评论失败 / 评论关闭：字幕照样保留", async () => {
    const exec = fake({ [A]: baseInfo(A), [B]: baseInfo(B, { comment_count: null }) }, (args) => {
      if (!args.includes("--write-comments")) return undefined;
      if (args.at(-1)!.includes(A)) return new YtdlpError("failed", "comment api broke");
      return { stdout: JSON.stringify(baseInfo(B, { comment_count: null, comments: [] })), stderr: "Comments are turned off" };
    });
    await run({ urls: [url(A), url(B)], comments: 10, exec });
    const a = await readJson(`${A}.json`);
    expect(a.subtitles.status).toBe("ok");
    expect(a.comments).toMatchObject({ status: "failed", reason: "comment api broke" });
    await expect(fs.stat(path.join(dir, `${A}.txt`))).resolves.toBeTruthy();
    expect((await readJson(`${B}.json`)).comments.status).toBe("disabled");
  });
});

describe("限流与失败", () => {
  it("一次 429 退避重试后成功", async () => {
    const exec = fake({ [A]: baseInfo(A) }, (_a, n) => (n === 1 ? new YtdlpError("rate_limited", "429") : undefined));
    const s = await run({ urls: [url(A)], exec });
    expect(s).toMatchObject({ ok: true, done: 1 });
  });

  it("连续 2 次 429 整批停：已完成的写盘，剩下的标没抓；重跑跳过已完成的接着抓", async () => {
    let limited = true;
    const handler: Handler = (args) => (limited && args.at(-1)!.includes(B) ? new YtdlpError("rate_limited", "429") : undefined);
    const infos = { [A]: baseInfo(A), [B]: baseInfo(B), [C]: baseInfo(C) };
    const s = await run({ urls: [url(A), url(B), url(C)], exec: fake(infos, handler) });
    expect(s).toMatchObject({ ok: false, done: 1, failed: 1, notAttempted: 1 });
    expect(s.stopped).toContain("429");
    const idx = await readJson("index.json");
    expect(idx.stopped).toContain("429");
    expect(idx.videos.map((v: { status: string }) => v.status)).toEqual(["ok", "failed", "not_attempted"]);
    await expect(fs.stat(path.join(dir, `${A}.json`))).resolves.toBeTruthy();

    limited = false; calls = [];
    const again = await run({ urls: [url(A), url(B), url(C)], exec: fake(infos, handler) });
    expect(again).toMatchObject({ ok: true, done: 3, failed: 0 });
    expect(calls.some((c) => c.at(-1)!.includes(A))).toBe(false);
    expect((await readJson("index.json")).videos[0]).toMatchObject({ id: A, resumed: true });
  });

  it("整次运行只有 3 次重试：超时用完预算后这条标失败，下一条照常抓", async () => {
    const exec = fake({ [A]: baseInfo(A), [B]: baseInfo(B) }, (args) => (args.at(-1)!.includes(A) ? new YtdlpError("timeout", "yt-dlp 超过 90 秒没返回") : undefined));
    const s = await run({ urls: [url(A), url(B)], exec });
    expect(s).toMatchObject({ failed: 1, done: 1 });
    expect(calls.filter((c) => c.at(-1)!.includes(A)).length).toBe(4);
    expect((await readJson("index.json")).videos[0]).toMatchObject({ status: "failed", reason: expect.stringContaining("超过") });
  });

  it("视频不可用这类错误不重试，原因写进汇总", async () => {
    const exec = fake({ [B]: baseInfo(B) }, (args) => (args.at(-1)!.includes(A) ? new YtdlpError("failed", "Video unavailable") : undefined));
    await run({ urls: [url(A), url(B)], exec });
    expect(calls.filter((c) => c.at(-1)!.includes(A)).length).toBe(1);
    expect((await readJson("index.json")).videos[0]).toMatchObject({ status: "failed", reason: "Video unavailable" });
  });

  it("没装 yt-dlp：整批报安装提示", async () => {
    const s = await run({ urls: [url(A)], exec: fake({}, () => new YtdlpError("missing", "没找到 yt-dlp：brew install yt-dlp")) });
    expect(s).toMatchObject({ ok: false, error: expect.stringContaining("brew install yt-dlp") });
  });
});

describe("网址校验与清理", () => {
  it("频道、播放列表、Shorts、非 YouTube 都不收，不发任何请求", async () => {
    for (const bad of ["https://www.youtube.com/@DanKoeTalks", "https://www.youtube.com/playlist?list=PL1", "https://www.youtube.com/shorts/aaaaaaaaaaa", "https://vimeo.com/1", "not a url"]) {
      const s = await run({ urls: [url(A), bad], exec: fake({}) });
      expect(s.ok).toBe(false);
      expect(s.error).toContain(bad);
    }
    expect(calls).toEqual([]);
  });

  it("youtu.be 短链和带 list 参数的单条视频网址都规范成单条视频", async () => {
    await run({ urls: [`https://youtu.be/${A}`, `https://www.youtube.com/watch?v=${A}&list=PL1`], exec: fake({ [A]: baseInfo(A) }) });
    expect(calls.filter((c) => c.includes("-J")).map((c) => c.at(-1))).toEqual([url(A)]);
  });

  it("--clean 只删博主目录", async () => {
    const root = path.join(dir, "root");
    await fs.mkdir(path.join(root, "dankoetalks"), { recursive: true });
    await fs.mkdir(path.join(root, "other"), { recursive: true });
    expect(await cleanCreator("@DanKoeTalks", root)).toMatchObject({ removed: true });
    expect(await fs.readdir(root)).toEqual(["other"]);
    expect(await cleanCreator("nobody", root)).toMatchObject({ removed: false });
    await expect(cleanCreator("../", root)).rejects.toThrow();
  });
});
