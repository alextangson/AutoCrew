/**
 * doctor-video.test.ts —— `autocrew doctor` 的视频线三项检查（ffmpeg/ffprobe、ASR sidecar、
 * ASR 模型预热状态）。真起 CLI 子进程跑，因为 doctor 是 .mjs 脚本、没法 import。
 *
 * 断言只锁**不变量与可控输入**：ffmpeg 装没装是机器状态（只断言是布尔、不断言真假），
 * ASR 模型状态由本测试自己写的 asr-status.json 决定（可控 → 断死）。
 * doctor 是纯检查：跑完不许在数据目录里造出任何东西。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO_ROOT, "bin", "autocrew.mjs");

let dir: string;

/** 端口指向一个没人听的号：serverUp() 立刻失败，doctor 不去打扰真在跑的 AutoCrew */
function runDoctor(json: boolean): string {
  const args = ["doctor", ...(json ? ["--json"] : [])];
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: { ...process.env, AUTOCREW_DATA_DIR: dir, AUTOCREW_PORT: "45999" },
  });
  expect(res.error).toBeUndefined();
  return res.stdout;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-doctor-video-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("autocrew doctor —— 视频线检查项", () => {
  it("三项都在报告里，且是布尔（未预热时 asrModelReady=false）", () => {
    const checks = JSON.parse(runDoctor(true));
    expect(typeof checks.ffmpeg).toBe("boolean");
    expect(typeof checks.ffprobe).toBe("boolean");
    expect(checks.asrSidecar).toBe(true); // 仓库自带 sidecars/asr/asr.py
    expect(checks.asrModelReady).toBe(false);
  }, 30_000);

  it("读的是 <dataDir>/video/asr-status.json（与 service 同源）：ready 即报就绪", async () => {
    await fs.mkdir(path.join(dir, "video"), { recursive: true });
    await fs.writeFile(path.join(dir, "video", "asr-status.json"), JSON.stringify({ status: "ready" }));
    expect(JSON.parse(runDoctor(true)).asrModelReady).toBe(true);
  }, 30_000);

  it("未预热给的是人话指引（预热是用户按的，doctor 不自己下 1GB 模型）", async () => {
    await fs.mkdir(path.join(dir, "video"), { recursive: true });
    await fs.writeFile(path.join(dir, "video", "asr-status.json"), JSON.stringify({ status: "warming" }));
    const text = runDoctor(false);
    expect(text).toContain("ASR 模型未就绪(当前 warming)");
    expect(text).toContain("video:asr_warmup");
  }, 30_000);

  it("纯检查：跑一遍不在数据目录里造任何东西", async () => {
    runDoctor(true);
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  }, 30_000);
});
