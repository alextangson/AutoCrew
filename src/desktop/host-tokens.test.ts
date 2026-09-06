/**
 * 命名宿主 token（P3 §4.1）：建 → 认 → 归因 → 撤销。全程在临时目录，绝不碰 ~/.autocrew。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureHostToken,
  hostsListHandler,
  hostsRevokeHandler,
  listHostTokens,
  lookupHostToken,
  revokeHostToken,
  tokensDir,
} from "./host-tokens.js";
import { LocalSessionAuth, LOCAL_SUBJECT } from "./server-auth.js";

let dataDir: string;
const savedEnv = process.env.AUTOCREW_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "autocrew-host-tokens-"));
  process.env.AUTOCREW_DATA_DIR = dataDir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.AUTOCREW_DATA_DIR;
  else process.env.AUTOCREW_DATA_DIR = savedEnv;
});

describe("host tokens", () => {
  it("creates a 0600 token file under a 0700 dir and is idempotent", () => {
    const file = ensureHostToken("codex");
    expect(file).toBe(path.join(tokensDir(), "codex.token"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(tokensDir()).mode & 0o777).toBe(0o700);
    const value = readFileSync(file, "utf-8");
    expect(ensureHostToken("codex")).toBe(file);
    expect(readFileSync(file, "utf-8")).toBe(value); // 重跑不换钥匙
  });

  it("rejects host names that could escape the tokens dir", () => {
    expect(() => ensureHostToken("../evil")).toThrow(/不合法/);
    expect(() => ensureHostToken("Codex")).toThrow(/不合法/);
    expect(() => ensureHostToken("a")).toThrow(/不合法/);
  });

  it("resolves a token back to its host and records last use", () => {
    const token = readFileSync(ensureHostToken("claude-code"), "utf-8").trim();
    expect(lookupHostToken(token)).toBe("claude-code");
    expect(lookupHostToken("not-a-token")).toBeNull();
    const [info] = listHostTokens();
    expect(info.host).toBe("claude-code");
    expect(info.createdAt).toMatch(/^\d{4}-/);
    expect(info.lastUsedAt).toMatch(/^\d{4}-/);
  });

  it("throttles last-use writes to once a minute", () => {
    const token = readFileSync(ensureHostToken("dsh"), "utf-8").trim();
    const start = Date.parse("2026-09-06T00:00:00.000Z");
    lookupHostToken(token, undefined, start);
    lookupHostToken(token, undefined, start + 1_000);
    expect(listHostTokens()[0].lastUsedAt).toBe(new Date(start).toISOString());
    lookupHostToken(token, undefined, start + 61_000);
    expect(listHostTokens()[0].lastUsedAt).toBe(new Date(start + 61_000).toISOString());
  });

  it("revokes by deleting the file", () => {
    const file = ensureHostToken("codex");
    const token = readFileSync(file, "utf-8").trim();
    expect(revokeHostToken("codex")).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(lookupHostToken(token)).toBeNull();
    expect(listHostTokens()).toEqual([]);
    expect(revokeHostToken("codex")).toBe(false);
  });

  it("gives each host its own subject and keeps local-user for the legacy token", () => {
    const codex = readFileSync(ensureHostToken("codex"), "utf-8").trim();
    writeFileSync(path.join(dataDir, "server-token"), "legacy-token\n");
    const auth = new LocalSessionAuth(
      "boot",
      new Set(),
      undefined,
      undefined,
      "legacy-token",
      (token) => lookupHostToken(token),
    );
    expect(auth.identify({ authorization: `Bearer ${codex}` })).toEqual({ method: "bearer", subject: "codex" });
    expect(auth.identify({ authorization: "Bearer legacy-token" })).toEqual({ method: "bearer", subject: LOCAL_SUBJECT });
    expect(auth.identify({ authorization: "Bearer nope" })).toBeNull();
    expect(auth.authenticate({ authorization: `Bearer ${codex}` })).toBe("bearer");
  });
});

/**
 * `hosts:list` / `hosts:revoke`（P3 §4.1「接入更多 · 宿主」卡）——
 * 通道能给出清单与撤销，但**永远不给 token 值**。
 */
describe("hosts IPC", () => {
  it("lists hosts with created/last-used and never the token value", async () => {
    ensureHostToken("codex");
    ensureHostToken("dsh");
    const token = readFileSync(path.join(tokensDir(), "codex.token"), "utf-8").trim();
    lookupHostToken(token);

    const res = await hostsListHandler({});
    expect(res.ok).toBe(true);
    const hosts = (res.data as { hosts: Array<{ host: string; createdAt: string; lastUsedAt?: string }> }).hosts;
    expect(hosts.map((h) => h.host)).toEqual(["codex", "dsh"]);
    expect(hosts[0].createdAt).toBeTruthy();
    expect(hosts[0].lastUsedAt).toBeTruthy();
    expect(hosts[1].lastUsedAt).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain(token);
  });

  it("returns an empty list before the server has ever issued one", async () => {
    expect(await hostsListHandler({})).toEqual({ ok: true, data: { hosts: [] } });
  });

  it("revokes a host and reports the fresh list", async () => {
    const file = ensureHostToken("codex");
    const res = await hostsRevokeHandler({ host: "codex" });
    expect(res.ok).toBe(true);
    expect((res.data as { revoked: boolean }).revoked).toBe(true);
    expect((res.data as { hosts: unknown[] }).hosts).toEqual([]);
    expect(String(res.message)).toContain("401");
    expect(existsSync(file)).toBe(false);
  });

  it("says so plainly when there was nothing to revoke", async () => {
    const res = await hostsRevokeHandler({ host: "codex" });
    expect(res.ok).toBe(true);
    expect((res.data as { revoked: boolean }).revoked).toBe(false);
    expect(String(res.message)).toContain("本来就没有令牌");
  });

  it("rejects a host name that could escape the tokens dir", async () => {
    ensureHostToken("codex");
    for (const host of ["../codex", "", "Codex", "a/b"]) {
      expect((await hostsRevokeHandler({ host })).ok, host).toBe(false);
    }
    expect(listHostTokens()).toHaveLength(1);
  });
});
