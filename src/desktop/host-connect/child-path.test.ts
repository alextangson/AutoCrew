/** Codex 评审第 2 轮 P2-a：子进程 PATH 带上补充目录与当前 node；跑不起来 ≠ 没登录 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultHostEnv } from "./env.js";
import { detectHost } from "./detect.js";
import { makeSandbox, type Sandbox } from "./test-fakes.js";

let sb: Sandbox;
beforeEach(async () => { sb = await makeSandbox(); vi.stubEnv("HOME", sb.home); vi.stubEnv("AUTOCREW_LOCAL_DIR", sb.dataDir); });
afterEach(async () => { vi.unstubAllEnvs(); await sb.cleanup(); });

it("子进程 PATH 含补充的可执行目录和正在跑的 node 所在目录", () => {
  const e = defaultHostEnv({ HOME: sb.home, PATH: "/usr/bin" });
  const dirs = String(e.childEnv.PATH).split(path.delimiter);
  expect(dirs).toContain(path.join(sb.home, ".local", "bin"));
  expect(dirs).toContain("/opt/homebrew/bin");
  expect(dirs).toContain(path.dirname(process.execPath));
});

it("codex 命令起不来（退出码 127）：说起不来，不说没登录", async () => {
  fs.writeFileSync(path.join(sb.bin, "codex"), "#!/bin/sh\necho 'env: node: No such file or directory' >&2\nexit 127\n", { mode: 0o755 });
  const s = await detectHost("codex", sb.env);
  expect(s.loggedIn).toBeNull();
  expect(s.detail).toContain("起不来");
  expect(s.detail).not.toContain("还没登录");
});
