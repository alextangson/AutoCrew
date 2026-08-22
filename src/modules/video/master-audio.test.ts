/**
 * master-audio.test.ts —— BGM 混音链（横屏 spec §2.4 + 边界 #12）。
 *
 * ffmpeg 用**注入的假进程**：这一层要证的是「按什么顺序、拿什么参数调 ffmpeg」，
 * 真跑一遍音频既慢又证明不了参数对不对（响度对不对是 ffmpeg 的事，不是我们的事）。
 * filter 串本身是纯函数，直接对着字面量锁死。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BGM_BED_GAIN_DB,
  bgmBranch,
  buildMasterAudio,
  masterFilter,
  MIN_BGM_MS,
} from "./master-audio.js";
import { fakeChild, routedSpawn } from "./testkit.js";

let dir: string;
let calls: string[][];

const MEASURED = { input_i: "-18.5", input_tp: "-3.2", input_lra: "7.1", input_thresh: "-28.7", target_offset: "0.3" };

/** ffprobe 报文：durationMs 由 seconds 决定，有无音轨由 audio 决定 */
function probePayload(seconds: number, audio = true): unknown {
  return {
    format: { format_name: "wav", duration: String(seconds) },
    streams: audio ? [{ codec_type: "audio", codec_name: "pcm_s16le" }] : [{ codec_type: "video", codec_name: "h264" }],
  };
}

interface FakeOpts {
  /** 按文件名给 ffprobe 报文；缺省一律是 5 秒的合法音频 */
  probeFor?: (file: string) => unknown;
  /** 测量 pass 吐出的 loudnorm 报文；null = 读不出（静音） */
  measured?: Record<string, string> | null;
  /** 让某一次 ffmpeg 调用失败（下标从 0 起） */
  failAt?: number;
}

function fakeSpawn(opts: FakeOpts = {}) {
  calls = [];
  return routedSpawn({
    ffprobe: (args) => {
      const file = args[args.length - 1]!;
      return fakeChild({ stdoutLines: [JSON.stringify(opts.probeFor?.(file) ?? probePayload(5))] });
    },
    ffmpeg: (args): ChildProcess => {
      const index = calls.length;
      calls.push([...args]);
      if (opts.failAt === index) return fakeChild({ exitCode: 1, stderr: "boom\n" });
      const measuring = args.includes("null");
      if (measuring) {
        const payload = opts.measured === undefined ? MEASURED : opts.measured;
        return fakeChild({ stderr: payload ? `[Parsed_loudnorm] ${JSON.stringify(payload)}\n` : "no measurement\n" });
      }
      // 渲染 pass：真的产出一个文件，后面的 rename + probe 才有东西可动
      const out = args[args.length - 1]!;
      return fakeChild({ before: () => fs.writeFile(out, "fake-wav") });
    },
  });
}

function input(over: Partial<Parameters<typeof buildMasterAudio>[0]> = {}) {
  return {
    anchorFile: path.join(dir, "anchor.wav"),
    durationMs: 30_000,
    bgmFile: path.join(dir, "bgm.wav"),
    outFile: path.join(dir, "master-audio.v1.wav"),
    ...over,
  };
}

/** 本次调用用的 filter_complex 串 */
function filterOf(call: string[]): string {
  return call[call.indexOf("-filter_complex") + 1] ?? "";
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-master-audio-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("filter 串（纯函数，逐字锁死）", () => {
  it("BGM 支路顺序：统一格式 → 归一 → 截到人声长度 → 尾部 2s fade → 垫入 -22dB", () => {
    expect(bgmBranch("I=-14:linear=true", 30_000)).toBe(
      "[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo," +
        "loudnorm=I=-14:linear=true," +
        "atrim=end=30.000,asetpts=PTS-STARTPTS," +
        "afade=t=out:st=28.000:d=2.000," +
        "volume=-22dB[bed]",
    );
  });

  it("垫乐音量是 -22dB，不是「随手调一个」", () => {
    expect(BGM_BED_GAIN_DB).toBe(-22);
  });

  it("成片短于 fade 时长时 fade 从 0 开始，不出负数时间", () => {
    expect(bgmBranch("x", 1000)).toContain("afade=t=out:st=0.000:d=2.000");
  });

  it("主链：amix 必须 normalize=0，之后才是最终 loudnorm 与 limiter 安全网", () => {
    const filter = masterFilter({ bgmTuned: "BGM", mixLoudnorm: "MIX", durationMs: 30_000 });
    expect(filter).toContain("[0:a][bed]amix=inputs=2:duration=first:normalize=0,loudnorm=MIX,alimiter=limit=0.841[out]");
    // 顺序即语义：垫乐先做完自己的事，才轮到混音与最终归一
    expect(filter.indexOf("volume=-22dB")).toBeLessThan(filter.indexOf("amix"));
    expect(filter.indexOf("amix")).toBeLessThan(filter.indexOf("loudnorm=MIX"));
    expect(filter.indexOf("loudnorm=MIX")).toBeLessThan(filter.indexOf("alimiter"));
  });
});

describe("buildMasterAudio 调用序列", () => {
  it("三个 pass：BGM 自身测量 → 混音测量 → 混音渲染", async () => {
    const r = await buildMasterAudio(input(), { spawnImpl: fakeSpawn() });
    expect(r).toMatchObject({ ok: true, durationMs: 5000 });
    expect(calls).toHaveLength(3);

    // ① BGM 单独测量：输入只有 BGM，且是 print_format=json 的测量 pass
    expect(calls[0]).toContain("-i");
    expect(filterOf(calls[0])).toBe("[0:a]loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[out]");
    expect(calls[0]).toContain("null");

    // ② 混音测量：两路输入 + BGM 用第一 pass 的测量值线性归一 + 最终 loudnorm 仍是测量档
    expect(calls[1].join(" ")).toContain("-stream_loop -1");
    expect(filterOf(calls[1])).toContain("measured_I=-18.5");
    expect(filterOf(calls[1])).toContain("loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json,alimiter");
    expect(calls[1]).toContain("null");

    // ③ 混音渲染：最终 loudnorm 换成测量值线性归一，输出 48k 立体声 wav
    expect(filterOf(calls[2])).toContain("measured_I=-18.5:measured_TP=-3.2");
    expect(calls[2].join(" ")).toContain("-ar 48000 -ac 2 -c:a pcm_s16le");
  });

  it("BGM 短于人声要循环：-stream_loop -1 + 输出总长封顶在人声长度", async () => {
    await buildMasterAudio(input({ durationMs: 30_000 }), { spawnImpl: fakeSpawn() });
    expect(calls[2].join(" ")).toContain("-stream_loop -1");
    expect(calls[2].join(" ")).toContain("-t 30.000");
  });

  it("单声道 / 异常采样率靠 aformat 上混与重采样（边界 #12）", async () => {
    await buildMasterAudio(input(), { spawnImpl: fakeSpawn() });
    expect(filterOf(calls[2])).toContain("aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo");
  });

  it("产物落到 outFile，中间的 .tmp 不留下", async () => {
    const r = await buildMasterAudio(input(), { spawnImpl: fakeSpawn() });
    expect(r.ok).toBe(true);
    await fs.access(path.join(dir, "master-audio.v1.wav"));
    await expect(fs.access(path.join(dir, "master-audio.v1.wav.tmp"))).rejects.toThrow();
  });
});

describe("BGM 收货门槛（边界 #12）——不合格一律降级 + warning，绝不静默", () => {
  it("短于 2s → 拒收，且一个 ffmpeg 都不调", async () => {
    const r = await buildMasterAudio(input(), {
      spawnImpl: fakeSpawn({ probeFor: () => probePayload(1) }),
    });
    expect(r).toMatchObject({ ok: false, rejected: true });
    expect(r.ok === false && r.rejected === true && r.warning).toContain(String(MIN_BGM_MS));
    expect(calls).toHaveLength(0);
  });

  it("没有音轨（挂错文件）→ 拒收", async () => {
    const r = await buildMasterAudio(input(), {
      spawnImpl: fakeSpawn({ probeFor: () => probePayload(30, false) }),
    });
    expect(r.ok === false && r.rejected === true && r.warning).toContain("没有音轨");
  });

  it("整轨静音（读不出响度）→ 拒收，不往下混", async () => {
    const r = await buildMasterAudio(input(), { spawnImpl: fakeSpawn({ measured: null }) });
    expect(r.ok === false && r.rejected === true && r.warning).toContain("静音");
    expect(calls).toHaveLength(1);
  });

  it("响度低到 -70 也算静音（有限值但等于没声）", async () => {
    const r = await buildMasterAudio(input(), {
      spawnImpl: fakeSpawn({ measured: { ...MEASURED, input_i: "-70.0" } }),
    });
    expect(r.ok === false && r.rejected === true && r.warning).toContain("静音");
  });
});

describe("混音链自己炸了 ≠ BGM 不合格", () => {
  it("渲染 pass 非零退出 → 硬失败（不许降级成无 BGM 蒙混过关）", async () => {
    const r = await buildMasterAudio(input(), { spawnImpl: fakeSpawn({ failAt: 2 }) });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.rejected).toBeFalsy();
    expect(r.ok === false && !r.rejected && r.errorCode).toBe("master_render_failed");
  });

  it("混音测量失败 → 硬失败，不留半个 wav", async () => {
    const r = await buildMasterAudio(input(), { spawnImpl: fakeSpawn({ failAt: 1 }) });
    expect(r.ok === false && !r.rejected && r.errorCode).toBe("master_measure_failed");
    await expect(fs.access(path.join(dir, "master-audio.v1.wav"))).rejects.toThrow();
  });
});
