/** autocrew doctor 的 yt-dlp 一项：可选，显示版本，坏了也不影响退出码（真起 CLI，PATH 前面放假的 yt-dlp） */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = path.join(import.meta.dirname, "..", "..", "..", "bin", "autocrew.mjs");
let dir: string;

async function doctorWith(script: string): Promise<{ checks: Record<string, unknown>; code: number | null; text: string }> {
  const bin = path.join(dir, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "yt-dlp"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AUTOCREW_DATA_DIR: path.join(dir, "data"), AUTOCREW_PORT: "45998" };
  const json = spawnSync(process.execPath, [CLI, "doctor", "--json"], { encoding: "utf-8", env });
  const text = spawnSync(process.execPath, [CLI, "doctor"], { encoding: "utf-8", env });
  return { checks: JSON.parse(json.stdout), code: json.status, text: text.stdout };
}

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "craft-doctor-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("doctor 的 yt-dlp", () => {
  it("装了显示版本；坏了显示 false 和可选安装提示，退出码不变", async () => {
    const ok = await doctorWith('echo "2026.06.09"');
    expect(ok.checks.ytDlp).toBe("2026.06.09");
    const broken = await doctorWith("exit 3");
    expect(broken.checks.ytDlp).toBe(false);
    expect(broken.text).toContain("（可选）抓对标视频做拆解要 yt-dlp");
    expect(broken.code).toBe(ok.code);
  }, 120_000);
});
