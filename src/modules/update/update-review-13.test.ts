/** 第 13 轮增量评审：每条一个修之前会失败的用例。git 只碰临时仓库；不起真服务。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asrWarmupCount, effectiveAsrStatus, warmupAsr } from "../video/asr.js";
import { fakeUvSpawn, routedSpawn } from "../video/testkit.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-review13-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("P2 ASR 预热被更新重启打断", () => {
  const statusFile = () => path.join(tmp, "video", "asr-status.json");
  const leftWarming = () => {
    fs.mkdirSync(path.join(tmp, "video"), { recursive: true });
    fs.writeFileSync(statusFile(), JSON.stringify({ status: "warming", detail: "正在下载", updatedAt: "2026-10-01T00:00:00Z" }));
  };

  it("盘上是「预热中」、本进程没在预热、模型没到：写成失败，叫人再点一次（不再永远「预热中」）", async () => {
    leftWarming();
    const st = await effectiveAsrStatus(tmp, { ...process.env, MODELSCOPE_CACHE: path.join(tmp, "empty-cache") });
    expect(st.status).toBe("failed");
    expect(st.detail).toContain("再点一次");
    expect(JSON.parse(fs.readFileSync(statusFile(), "utf-8")).status).toBe("failed");
  });

  it("模型其实已经下好了：算就绪", async () => {
    leftWarming();
    const cache = path.join(tmp, "cache");
    for (const repo of ["iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch", "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch", "iic/punc_ct-transformer_cn-en-common-vocab471067-large"]) {
      fs.mkdirSync(path.join(cache, "hub", "models", repo), { recursive: true });
    }
    const st = await effectiveAsrStatus(tmp, { ...process.env, MODELSCOPE_CACHE: cache });
    expect(st.status).toBe("ready");
  });

  it("本进程里正在预热：计入忙碌；预热完释放", async () => {
    const r = await warmupAsr(tmp, { spawnImpl: routedSpawn({ uv: fakeUvSpawn("ok") }) });
    expect(r.status).toBe("warming");
    expect(asrWarmupCount()).toBe(1);
    await expect.poll(() => asrWarmupCount(), { timeout: 3000 }).toBe(0);
  });
});

describe("P2 服务把 ASR 预热计入忙碌", () => {
  it("desktop/server.ts 的 inProcessTurns 计入 asrWarmupCount()", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "desktop", "server.ts"), "utf-8");
    expect(src.split("\n").find((l) => l.includes("inProcessTurns:"))).toContain("asrWarmupCount()");
  });
});
