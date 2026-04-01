import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getProStatus,
  saveProKey,
  removeProKey,
  readProKey,
  requirePro,
  proGateResponse,
  isProFeature,
  PRO_FEATURES,
} from "../pro/gate.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-gate-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("readProKey / saveProKey / removeProKey", () => {
  it("returns null when .pro file does not exist", async () => {
    const key = await readProKey(testDir);
    expect(key).toBeNull();
  });

  it("saves and reads back a key", async () => {
    await saveProKey("test-key-abc123", testDir);
    const key = await readProKey(testDir);
    expect(key).toBe("test-key-abc123");
  });

  it("trims whitespace from saved key", async () => {
    await saveProKey("  my-key  \n", testDir);
    const key = await readProKey(testDir);
    expect(key).toBe("my-key");
  });

  it("removes the key file", async () => {
    await saveProKey("some-key", testDir);
    await removeProKey(testDir);
    const key = await readProKey(testDir);
    expect(key).toBeNull();
  });

  it("removeProKey is safe when file does not exist", async () => {
    await expect(removeProKey(testDir)).resolves.not.toThrow();
  });
});

describe("getProStatus", () => {
  it("returns isPro:false when no key", async () => {
    const status = await getProStatus(testDir);
    expect(status.isPro).toBe(false);
    expect(status.apiKey).toBeNull();
    expect(status.verified).toBeNull();
  });

  it("returns isPro:true when key exists", async () => {
    await saveProKey("valid-key", testDir);
    const status = await getProStatus(testDir);
    expect(status.isPro).toBe(true);
    expect(status.apiKey).toBe("valid-key");
  });
});

describe("requirePro", () => {
  it("returns null (allow) when Pro key exists", async () => {
    await saveProKey("valid-key", testDir);
    const result = await requirePro("对标账号监控", testDir);
    expect(result).toBeNull();
  });

  it("returns error object when no Pro key", async () => {
    const result = await requirePro("对标账号监控", testDir);
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    expect(result!.error).toContain("对标账号监控");
    expect(result!.upgradeHint).toContain("autocrew upgrade");
  });
});

describe("proGateResponse", () => {
  it("includes feature name, upgrade hint, and free alternative", () => {
    const r = proGateResponse("视频文案提取", "手动粘贴文案给我分析");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("视频文案提取");
    expect(r.freeAlternative).toBe("手动粘贴文案给我分析");
    expect(r.upgradeHint).toBeTruthy();
  });
});

describe("isProFeature", () => {
  it("returns true for known Pro features", () => {
    for (const f of PRO_FEATURES) {
      expect(isProFeature(f)).toBe(true);
    }
  });

  it("returns false for Free features", () => {
    expect(isProFeature("humanize")).toBe(false);
    expect(isProFeature("write-script")).toBe(false);
    expect(isProFeature("content-review")).toBe(false);
  });
});
