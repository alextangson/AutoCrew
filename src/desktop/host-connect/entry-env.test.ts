/** Codex 评审 P2-1：宿主条目必须写明真实状态目录；核对只用条目自己的环境（宿主真启动时就只有这些） */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultHostEnv } from "./env.js";
import { connectHost } from "./connect.js";
import { makeSandbox, type Sandbox } from "./test-fakes.js";

let sb: Sandbox;
beforeEach(async () => { sb = await makeSandbox(); vi.stubEnv("HOME", sb.home); vi.stubEnv("AUTOCREW_LOCAL_DIR", sb.dataDir); });
afterEach(async () => { vi.unstubAllEnvs(); await sb.cleanup(); });

it("只设了 AUTOCREW_DATA_DIR：条目里也写明 AUTOCREW_LOCAL_DIR 与端口；子进程环境不带任何 AUTOCREW_*", () => {
  const e = defaultHostEnv({ HOME: sb.home, PATH: "/usr/bin", AUTOCREW_DATA_DIR: "/srv/ac", AUTOCREW_TOKEN: "x" });
  expect(e.forwarder.env).toMatchObject({ AUTOCREW_LOCAL_DIR: "/srv/ac", AUTOCREW_PORT: "4317" });
  expect(Object.keys(e.childEnv).filter((k) => k.startsWith("AUTOCREW_"))).toEqual([]);
  const plain = defaultHostEnv({ HOME: sb.home, PATH: "/usr/bin" });
  expect(plain.forwarder.env.AUTOCREW_LOCAL_DIR).toBe(path.join(sb.home, ".autocrew"));
});

it("条目漏了状态目录时核对不能靠继承的环境蒙混过关", async () => {
  const env = { ...sb.env, forwarder: { ...sb.env.forwarder, env: { AUTOCREW_PORT: String(sb.port) } } };
  const r = await connectHost("claude", env);
  expect(r).toMatchObject({ ok: true, registered: true, verified: false });
  expect(fs.existsSync(path.join(sb.dataDir, "tokens", "claude-code.token"))).toBe(true);
});
