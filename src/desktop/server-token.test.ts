/**
 * server-token.test.ts — token 持久化（两台协作:重启不变）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveServerToken } from "./server-token.js";

let dir: string;
let savedDataDir: string | undefined;
let savedToken: string | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-token-"));
  savedDataDir = process.env.AUTOCREW_DATA_DIR;
  savedToken = process.env.AUTOCREW_TOKEN;
  process.env.AUTOCREW_DATA_DIR = dir;
  delete process.env.AUTOCREW_TOKEN;
});

afterEach(async () => {
  if (savedDataDir === undefined) delete process.env.AUTOCREW_DATA_DIR;
  else process.env.AUTOCREW_DATA_DIR = savedDataDir;
  if (savedToken === undefined) delete process.env.AUTOCREW_TOKEN;
  else process.env.AUTOCREW_TOKEN = savedToken;
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("resolveServerToken", () => {
  it("首次生成并落盘(600);二次调用读同一个(重启不变)", async () => {
    const first = resolveServerToken();
    expect(first).toMatch(/^[a-f0-9]{48}$/);
    const stat = await fs.stat(path.join(dir, "server-token"));
    expect(stat.mode & 0o777).toBe(0o600);
    const second = resolveServerToken();
    expect(second).toBe(first); // 关键不变量:同一 dataDir 反复启动 token 稳定
  });

  it("env AUTOCREW_TOKEN 覆盖落盘值(轮换/CI 固定),且不改写文件", async () => {
    const persisted = resolveServerToken();
    process.env.AUTOCREW_TOKEN = "fixed-env-token";
    expect(resolveServerToken()).toBe("fixed-env-token");
    delete process.env.AUTOCREW_TOKEN;
    expect(resolveServerToken()).toBe(persisted); // env 未改写落盘,撤掉后回落原值
  });

  it("删除 token 文件 → 重新生成一个新的(轮换手段)", async () => {
    const first = resolveServerToken();
    await fs.rm(path.join(dir, "server-token"));
    const rotated = resolveServerToken();
    expect(rotated).toMatch(/^[a-f0-9]{48}$/);
    expect(rotated).not.toBe(first);
  });
});
