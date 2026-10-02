/** 第 14 轮增量评审：P2 别的进程（doctor）不许改写「预热中」；P3 写不了状态时预热计数不能卡住。 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { asrWarmupCount, warmupAsr } from "../video/asr.js";
import { fakeUvSpawn, routedSpawn } from "../video/testkit.js";

const REPO = path.resolve(__dirname, "..", "..", "..");
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autocrew-review14-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("P2 预热进行中，别的进程读状态不改写", () => {
  it("服务在预热（盘上 warming）：另一个进程里的读者（doctor / 原片比对）照实报 warming，文件不变", () => {
    const statusFile = path.join(tmp, "video", "asr-status.json");
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify({ status: "warming", detail: "正在下载", updatedAt: "2026-10-02T00:00:00Z" }));
    const script = path.join(tmp, "reader.mts");
    fs.writeFileSync(script, [
      `import { effectiveAsrStatus } from ${JSON.stringify(pathToFileURL(path.join(REPO, "src/modules/video/asr.ts")).href)};`,
      `const st = await effectiveAsrStatus(${JSON.stringify(tmp)}, { ...process.env, MODELSCOPE_CACHE: ${JSON.stringify(path.join(tmp, "empty"))} });`,
      `process.stdout.write(st.status);`,
    ].join("\n"));
    const seen = execFileSync(path.join(REPO, "node_modules", ".bin", "tsx"), [script], { encoding: "utf-8" });
    expect(seen).toBe("warming");
    expect(JSON.parse(fs.readFileSync(statusFile, "utf-8")).status).toBe("warming");
  }, 30_000);
});

describe("P3 写不了状态", () => {
  it("预热一开始就写不了状态：报错，但计数回到 0（不会让每次更新都报「有任务在跑」）", async () => {
    fs.writeFileSync(path.join(tmp, "video"), "不是目录"); // 状态文件所在目录建不出来
    await expect(warmupAsr(tmp, { spawnImpl: routedSpawn({ uv: fakeUvSpawn("ok") }) })).rejects.toThrow();
    expect(asrWarmupCount()).toBe(0);
  });
});
