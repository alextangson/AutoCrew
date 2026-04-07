import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadServiceConfig,
  saveServiceConfig,
  detectConfigGaps,
  type ServiceConfig,
} from "./service-config.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-svcconfig-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("loadServiceConfig", () => {
  it("returns empty config when file does not exist", async () => {
    const config = await loadServiceConfig(testDir);
    expect(config.configuredAt).toBeTruthy();
    expect(config.omni).toBeUndefined();
    expect(config.coverGen).toBeUndefined();
  });
});

describe("saveServiceConfig / loadServiceConfig round-trip", () => {
  it("saves and loads config with omni and coverGen", async () => {
    const config = await loadServiceConfig(testDir);
    const full: ServiceConfig = {
      ...config,
      omni: {
        provider: "mimo",
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2-omni",
        apiKey: "sk-omni-123",
      },
      coverGen: {
        provider: "flux",
        apiKey: "sk-cover-456",
      },
    };
    await saveServiceConfig(full, testDir);
    const loaded = await loadServiceConfig(testDir);
    expect(loaded.omni?.provider).toBe("mimo");
    expect(loaded.omni?.apiKey).toBe("sk-omni-123");
    expect(loaded.coverGen?.provider).toBe("flux");
    expect(loaded.coverGen?.apiKey).toBe("sk-cover-456");
  });

  it("saves and loads all service modules", async () => {
    const config = await loadServiceConfig(testDir);
    const full: ServiceConfig = {
      ...config,
      omni: {
        provider: "mimo",
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2-omni",
        apiKey: "sk-omni-123",
      },
      coverGen: {
        provider: "flux",
        apiKey: "sk-cover-456",
        model: "flux-pro",
      },
      videoCrawler: {
        type: "mediacrawl",
        command: "python3 /opt/mediacrawl/main.py",
      },
      tts: {
        provider: "fish-audio",
        apiKey: "sk-tts-789",
        voice: "zh-female-1",
      },
      platforms: {
        xhs: { configured: true, lastAuth: "2026-04-01T00:00:00.000Z" },
        douyin: { configured: false },
      },
      intelSources: {
        rssConfigured: true,
        trendsConfigured: false,
        competitorsConfigured: true,
      },
    };
    await saveServiceConfig(full, testDir);
    const loaded = await loadServiceConfig(testDir);
    expect(loaded.omni?.apiKey).toBe("sk-omni-123");
    expect(loaded.coverGen?.model).toBe("flux-pro");
    expect(loaded.videoCrawler?.type).toBe("mediacrawl");
    expect(loaded.tts?.voice).toBe("zh-female-1");
    expect(loaded.platforms?.xhs.configured).toBe(true);
    expect(loaded.intelSources?.rssConfigured).toBe(true);
    expect(loaded.intelSources?.competitorsConfigured).toBe(true);
  });
});

describe("detectConfigGaps", () => {
  it("reports all gaps when nothing is configured", async () => {
    const gaps = await detectConfigGaps(testDir);
    expect(gaps).toHaveLength(6);
    const modules = gaps.map((g) => g.module);
    expect(modules).toContain("omni");
    expect(modules).toContain("coverGen");
    expect(modules).toContain("videoCrawler");
    expect(modules).toContain("tts");
    expect(modules).toContain("platforms");
    expect(modules).toContain("intelSources");
  });

  it("reports no gap for configured modules", async () => {
    const config = await loadServiceConfig(testDir);
    const withOmni: ServiceConfig = {
      ...config,
      omni: {
        provider: "mimo",
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2-omni",
        apiKey: "sk-omni-123",
      },
    };
    await saveServiceConfig(withOmni, testDir);
    const gaps = await detectConfigGaps(testDir);
    const modules = gaps.map((g) => g.module);
    expect(modules).not.toContain("omni");
    expect(modules).toContain("coverGen");
  });

  it("each gap has module, feature, and impact", async () => {
    const gaps = await detectConfigGaps(testDir);
    for (const gap of gaps) {
      expect(gap.module).toBeTruthy();
      expect(gap.feature).toBeTruthy();
      expect(gap.impact).toBeTruthy();
    }
  });
});
