import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateProfileToServices } from "./migrate.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-migrate-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("migrateProfileToServices", () => {
  it("moves omniConfig and videoCrawler from profile to services", async () => {
    const profile = {
      industry: "tech",
      platforms: ["xhs"],
      contentTypes: ["video"],
      tone: "casual",
      omniConfig: {
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2-omni",
        apiKey: "sk-omni-test-123",
      },
      videoCrawler: {
        type: "mediacrawl",
        command: "python3 /opt/mediacrawl/main.py",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await fs.writeFile(
      path.join(testDir, "creator-profile.json"),
      JSON.stringify(profile, null, 2),
      "utf-8",
    );

    const result = await migrateProfileToServices(testDir);
    expect(result.migrated).toBe(true);

    // Verify services.json was created with correct data
    const svcRaw = await fs.readFile(path.join(testDir, "services.json"), "utf-8");
    const svc = JSON.parse(svcRaw);
    expect(svc.omni.provider).toBe("xiaomi");
    expect(svc.omni.apiKey).toBe("sk-omni-test-123");
    expect(svc.omni.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(svc.omni.model).toBe("mimo-v2-omni");
    expect(svc.videoCrawler.type).toBe("mediacrawl");
    expect(svc.videoCrawler.command).toBe("python3 /opt/mediacrawl/main.py");

    // Verify profile was cleaned up
    const profileRaw = await fs.readFile(path.join(testDir, "creator-profile.json"), "utf-8");
    const updatedProfile = JSON.parse(profileRaw);
    expect(updatedProfile.omniConfig).toBeUndefined();
    expect(updatedProfile.videoCrawler).toBeUndefined();
    expect(updatedProfile.industry).toBe("tech");
    expect(updatedProfile.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });

  it("skips migration when services.json already exists", async () => {
    const profile = {
      industry: "tech",
      platforms: ["xhs"],
      omniConfig: {
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2-omni",
        apiKey: "sk-omni-test-123",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await fs.writeFile(
      path.join(testDir, "creator-profile.json"),
      JSON.stringify(profile, null, 2),
      "utf-8",
    );
    await fs.writeFile(
      path.join(testDir, "services.json"),
      JSON.stringify({ configuredAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
      "utf-8",
    );

    const result = await migrateProfileToServices(testDir);
    expect(result.migrated).toBe(false);
    expect(result.reason).toContain("already exists");
  });

  it("handles profile without old fields gracefully", async () => {
    const profile = {
      industry: "tech",
      platforms: ["xhs"],
      contentTypes: ["video"],
      tone: "casual",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await fs.writeFile(
      path.join(testDir, "creator-profile.json"),
      JSON.stringify(profile, null, 2),
      "utf-8",
    );

    const result = await migrateProfileToServices(testDir);
    expect(result.migrated).toBe(false);
    expect(result.reason).toContain("nothing to migrate");
  });
});
