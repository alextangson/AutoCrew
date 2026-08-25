/**
 * asr.test.ts —— sidecar 契约测试（假 ASR 常开，spec §11）：
 * 四种剧本（正常 / 超时杀树 / 半文件 / 非 0 退出）+ 未就绪三态 + 预热状态机。
 * 音频抽取用真 ffmpeg——那一步的产物规格（16k 单声道）是真会影响识别的。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractAsrWav, readAsrStatus, runAsr, scriptMatchRatio, warmupAsr } from "./asr.js";
import { probeMedia } from "./ingest.js";
import { ensureArollFixture, fakeChild, fakeUvSpawn, fixtureTranscript, routedSpawn } from "./testkit.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-asr-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function req(extra?: { timeoutMs?: number; hotwords?: string[] }) {
  return { audioFile: path.join(dir, "in.wav"), outFile: path.join(dir, "out.json"), ...extra };
}

/**
 * 抓 sidecar 的 argv。热词是**只存在于命令行上**的东西——sidecar 是假的，
 * 不看 argv 就等于没测；套在 `fakeUvSpawn` 外面，剧本行为保持不变。
 */
function capturingUv(): { calls: string[][]; spawnImpl: ReturnType<typeof routedSpawn> } {
  const calls: string[][] = [];
  const inner = fakeUvSpawn("ok");
  return {
    calls,
    spawnImpl: routedSpawn({
      uv: (args) => {
        calls.push([...args]);
        return inner(args);
      },
    }),
  };
}

/** 转写那一次调用（`commandExists` 的 --version 探测也走 uv，得挑出来） */
function transcribeArgv(calls: string[][]): string[] {
  const argv = calls.find((a) => a.includes("--audio"));
  if (!argv) throw new Error(`没抓到转写调用：${JSON.stringify(calls)}`);
  return argv;
}

describe("runAsr 契约", () => {
  it("正常：读回 sidecar 写的 transcript", async () => {
    const spawnImpl = routedSpawn({ uv: fakeUvSpawn("ok") });
    const r = await runAsr(req(), { spawnImpl });
    expect(r.ok).toBe(true);
    expect(r.ok && r.transcript.segments.map((s) => s.id)).toEqual(["seg-0001", "seg-0002"]);
  });

  it("挂住不退 → 超时终止，errorCode=asr_timeout", async () => {
    const spawnImpl = routedSpawn({ uv: fakeUvSpawn("hang") });
    const r = await runAsr(req({ timeoutMs: 150 }), { spawnImpl });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errorCode).toBe("asr_timeout");
    expect(r.ok === false && r.reason).toContain("超时");
  });

  it("半个 JSON → asr_bad_output（半文件绝不当事实存下来）", async () => {
    const spawnImpl = routedSpawn({ uv: fakeUvSpawn("half_file") });
    const r = await runAsr(req(), { spawnImpl });
    expect(r.ok === false && r.errorCode).toBe("asr_bad_output");
  });

  it("退出码 20 → blocked: asr_not_ready + 预热指引（不是 failed，重试一百次也没用）", async () => {
    const spawnImpl = routedSpawn({ uv: fakeUvSpawn("model_missing") });
    const r = await runAsr(req(), { spawnImpl });
    expect(r.ok === false && r.blockedReason).toBe("asr_not_ready");
    expect(r.ok === false && r.reason).toContain("预热");
  });

  it("非 0 退出 → 失败可见，stderr 尾部进原因", async () => {
    const spawnImpl = routedSpawn({ uv: fakeUvSpawn("crash") });
    const r = await runAsr(req(), { spawnImpl });
    expect(r.ok === false && r.errorCode).toBe("asr_exit_1");
    expect(r.ok === false && r.reason).toContain("RuntimeError");
  });

  it("退出码 0 却没写文件 → 契约被破坏，明说", async () => {
    const spawnImpl = routedSpawn({ uv: fakeUvSpawn("no_output") });
    const r = await runAsr(req(), { spawnImpl });
    expect(r.ok === false && r.errorCode).toBe("asr_no_output");
  });

  it("没装 uv → blocked: asr_not_ready + brew 指引", async () => {
    const spawnImpl = routedSpawn({ uv: () => fakeChild({ spawnError: "spawn uv ENOENT" }) });
    const r = await runAsr(req(), { spawnImpl });
    expect(r.ok === false && r.blockedReason).toBe("asr_not_ready");
    expect(r.ok === false && r.reason).toContain("brew install uv");
  });

  it("上一轮的残留输出不会被当成本轮结果（开跑前先删）", async () => {
    await fs.writeFile(path.join(dir, "out.json"), JSON.stringify(fixtureTranscript()));
    const spawnImpl = routedSpawn({ uv: fakeUvSpawn("crash") });
    const r = await runAsr(req(), { spawnImpl });
    expect(r.ok).toBe(false);
    await expect(fs.access(path.join(dir, "out.json"))).rejects.toThrow();
  });
});

describe("热词透传（spec §3）", () => {
  it("有热词 → argv 带 --hotword，多词按空格拼成一个参数", async () => {
    const { calls, spawnImpl } = capturingUv();
    const r = await runAsr(req({ hotwords: ["DeepSeek", "Harness"] }), { spawnImpl });
    expect(r.ok).toBe(true);
    const argv = transcribeArgv(calls);
    expect(argv[argv.indexOf("--hotword") + 1]).toBe("DeepSeek Harness");
  });

  it("空表 / 缺省 → argv 里根本没有 --hotword（缺省行为逐字节不变）", async () => {
    for (const hotwords of [undefined, []]) {
      const { calls, spawnImpl } = capturingUv();
      const r = await runAsr(req(hotwords ? { hotwords } : {}), { spawnImpl });
      expect(r.ok).toBe(true);
      expect(transcribeArgv(calls)).not.toContain("--hotword");
    }
  });
});

describe("extractAsrWav（真 ffmpeg）", () => {
  it("mp4 → 16k 单声道 wav", async () => {
    const fixture = await ensureArollFixture();
    const out = path.join(dir, "asr-input.wav");
    expect(await extractAsrWav(fixture, out)).toEqual({ ok: true });
    const probed = await probeMedia(out);
    expect(probed.ok && probed.probe.audio?.codec).toBe("pcm_s16le");
    expect(probed.ok && probed.probe.video).toBeUndefined();
  });

  it("源文件不存在 → 失败可见", async () => {
    const r = await extractAsrWav(path.join(dir, "nope.mp4"), path.join(dir, "o.wav"));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errorCode).toBe("audio_extract_failed");
  });
});

describe("预热与状态", () => {
  it("没预热过 → absent", async () => {
    expect(await readAsrStatus(dir)).toEqual({ status: "absent" });
  });

  it("预热投出去先落 warming，进程退出后落 ready", async () => {
    const spawnImpl = routedSpawn({ uv: fakeUvSpawn("ok") });
    const pending = await warmupAsr(dir, { spawnImpl });
    expect(pending.status).toBe("warming");
    await expect.poll(async () => (await readAsrStatus(dir)).status, { timeout: 3000 }).toBe("ready");
  });

  it("预热失败 → failed 带原因", async () => {
    const spawnImpl = routedSpawn({ uv: () => fakeChild({ exitCode: 1, stderr: "[asr] 失败：网络不通\n" }) });
    await warmupAsr(dir, { spawnImpl });
    await expect.poll(async () => (await readAsrStatus(dir)).status, { timeout: 3000 }).toBe("failed");
    expect((await readAsrStatus(dir)).detail).toContain("网络不通");
  });

  it("没装 uv → 直接落 failed，不去 spawn", async () => {
    const spawnImpl = routedSpawn({ uv: () => fakeChild({ spawnError: "spawn uv ENOENT" }) });
    const r = await warmupAsr(dir, { spawnImpl });
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("brew install uv");
  });
});

describe("scriptMatchRatio", () => {
  it("照稿念 → 高分；念的是别的 → 低分", () => {
    const t = fixtureTranscript();
    expect(scriptMatchRatio(t, "今天聊聊 FDE，这是第二句")).toBeGreaterThan(0.5);
    expect(scriptMatchRatio(t, "我们来讲讲量子力学与超导材料的关系")).toBeLessThan(0.2);
  });

  it("空稿件 → 0（不是 NaN，也不是 1）", () => {
    expect(scriptMatchRatio(fixtureTranscript(), "")).toBe(0);
  });
});
