/** yt-dlp 子进程封装：用真的假可执行文件验证 execFile 参数、超时、没装、429 分类；参数解析 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execYtdlp } from "./ytdlp.js";
import { parseCraftArgs } from "./cli.js";
import { parseVtt } from "./parse.js";

let dir: string;
async function fakeBin(body: string): Promise<string> {
  const f = path.join(dir, "yt-dlp");
  await fs.writeFile(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return f;
}

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "craft-ytdlp-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("execYtdlp", () => {
  it("固定带 --ignore-config --skip-download --no-playlist，参数原样传（不经 shell）", async () => {
    const bin = await fakeBin('for a in "$@"; do echo "$a"; done');
    const { stdout } = await execYtdlp(bin)(["-J", "https://x/?a=1&b=$(rm)"], 5_000);
    expect(stdout.trim().split("\n")).toEqual(["--ignore-config", "--skip-download", "--no-playlist", "-J", "https://x/?a=1&b=$(rm)"]);
  });

  it("超时：杀掉子进程，报 timeout", async () => {
    const bin = await fakeBin("sleep 5");
    await expect(execYtdlp(bin)([], 200)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("429 报 rate_limited；其他失败带 stderr 末尾", async () => {
    await expect(execYtdlp(await fakeBin('echo "ERROR: HTTP Error 429: Too Many Requests" >&2; exit 1'))([], 5_000)).rejects.toMatchObject({ kind: "rate_limited" });
    await expect(execYtdlp(await fakeBin('echo "ERROR: Video unavailable" >&2; exit 1'))([], 5_000)).rejects.toMatchObject({ kind: "failed", message: "ERROR: Video unavailable" });
  });

  it("没装：报 missing 和安装提示", async () => {
    await expect(execYtdlp(path.join(dir, "nope"))([], 5_000)).rejects.toMatchObject({ kind: "missing", message: expect.stringContaining("brew install yt-dlp") });
  });
});

describe("parseVtt 滚动字幕去重", () => {
  it("YouTube 自动字幕的内联时间标签和重复行去掉", () => {
    const vtt = [
      "WEBVTT", "Kind: captions", "",
      "00:00:00.000 --> 00:00:02.000 align:start position:0%", "hello<00:00:00.500><c> world</c>", "",
      "00:00:02.000 --> 00:00:02.010", "hello world", "",
      "00:00:02.010 --> 00:00:04.000", "hello world", "this<00:00:03.000><c> is</c><c> new</c>", "",
      "01:00:04.000 --> 01:00:05.000", "this is new", "",
    ].join("\n");
    expect(parseVtt(vtt)).toEqual([{ start: 0, text: "hello world" }, { start: 2.01, text: "this is new" }]);
  });
});

describe("parseCraftArgs", () => {
  it("--comments 上限 100、--clean 单独用、没网址给用法", () => {
    expect(parseCraftArgs(["u1", "--comments", "100", "--out", "/x"])).toEqual({ urls: ["u1"], comments: 100, out: "/x" });
    expect(parseCraftArgs(["u1", "--comments", "101"])).toHaveProperty("error");
    expect(parseCraftArgs(["--clean", "dan"])).toMatchObject({ clean: "dan", urls: [] });
    expect(parseCraftArgs(["u1", "--clean", "dan"])).toHaveProperty("error");
    expect(parseCraftArgs([])).toHaveProperty("error");
    expect(parseCraftArgs(["u1", "--top", "3"])).toHaveProperty("error");
  });
});
