# Configure Skill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a guided service configuration skill that detects unconfigured services, reports feature impact, and walks users through setup — storing configs in a new `services.json` separate from creator identity.

**Architecture:** New `ServiceConfig` type + load/save/detect helpers in `src/modules/config/`. New `configure` skill SKILL.md orchestrates detection + guided setup. Migrate `omniConfig`/`videoCrawler` from `creator-profile.json` to `services.json`. Update consumers (teardown skill) to read from new location.

**Tech Stack:** TypeScript, Vitest, existing pipeline patterns.

---

### Task 1: Create ServiceConfig type + load/save helpers

**Files:**
- Create: `src/modules/config/service-config.ts`
- Test: `src/modules/config/service-config.test.ts`

**Step 1: Write failing tests**

Create `src/modules/config/service-config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadServiceConfig,
  saveServiceConfig,
  type ServiceConfig,
} from "./service-config.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-svc-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("ServiceConfig", () => {
  it("returns empty config when file does not exist", async () => {
    const config = await loadServiceConfig(testDir);
    expect(config).not.toBeNull();
    expect(config.omni).toBeUndefined();
    expect(config.coverGen).toBeUndefined();
    expect(config.configuredAt).toBeDefined();
  });

  it("saves and loads config with omni and coverGen", async () => {
    const config: ServiceConfig = {
      omni: {
        provider: "xiaomi",
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2-omni",
        apiKey: "test-key",
      },
      coverGen: {
        provider: "gemini",
        apiKey: "gemini-key",
      },
      configuredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await saveServiceConfig(config, testDir);
    const loaded = await loadServiceConfig(testDir);

    expect(loaded.omni?.provider).toBe("xiaomi");
    expect(loaded.omni?.apiKey).toBe("test-key");
    expect(loaded.coverGen?.provider).toBe("gemini");
  });

  it("saves and loads all service modules", async () => {
    const config: ServiceConfig = {
      omni: {
        provider: "xiaomi",
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2-omni",
        apiKey: "key1",
      },
      coverGen: { provider: "gemini", apiKey: "key2" },
      videoCrawler: { type: "mediacrawl", command: "python3 /opt/mc/main.py" },
      tts: { provider: "mimo", apiKey: "key3", voice: "default" },
      platforms: {
        xiaohongshu: { configured: true, lastAuth: "2026-04-07" },
      },
      intelSources: {
        rssConfigured: true,
        trendsConfigured: false,
        competitorsConfigured: false,
      },
      configuredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await saveServiceConfig(config, testDir);
    const loaded = await loadServiceConfig(testDir);

    expect(loaded.videoCrawler?.type).toBe("mediacrawl");
    expect(loaded.tts?.provider).toBe("mimo");
    expect(loaded.platforms?.xiaohongshu?.configured).toBe(true);
    expect(loaded.intelSources?.rssConfigured).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/config/service-config.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement ServiceConfig**

Create `src/modules/config/service-config.ts`:

```typescript
/**
 * Service Configuration — tool/API configs stored at ~/.autocrew/services.json
 *
 * Separate from creator-profile.json (identity) — this file stores
 * "what tools do you use" configurations: API keys, providers, crawlers.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface OmniServiceConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface CoverGenConfig {
  provider: string;
  apiKey: string;
  model?: string;
}

export interface VideoCrawlerServiceConfig {
  type: "mediacrawl" | "playwright" | "manual";
  command?: string;
}

export interface TTSConfig {
  provider: string;
  baseUrl?: string;
  apiKey: string;
  voice?: string;
}

export interface PlatformAuthStatus {
  configured: boolean;
  lastAuth?: string;
}

export interface IntelSourcesStatus {
  rssConfigured: boolean;
  trendsConfigured: boolean;
  competitorsConfigured: boolean;
}

export interface ServiceConfig {
  omni?: OmniServiceConfig;
  coverGen?: CoverGenConfig;
  videoCrawler?: VideoCrawlerServiceConfig;
  tts?: TTSConfig;
  platforms?: Record<string, PlatformAuthStatus>;
  intelSources?: IntelSourcesStatus;
  configuredAt: string;
  updatedAt: string;
}

const SERVICE_FILE = "services.json";

function getDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

function emptyServiceConfig(): ServiceConfig {
  const now = new Date().toISOString();
  return { configuredAt: now, updatedAt: now };
}

export async function loadServiceConfig(
  dataDir?: string,
): Promise<ServiceConfig> {
  const filePath = path.join(getDataDir(dataDir), SERVICE_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as ServiceConfig;
  } catch {
    return emptyServiceConfig();
  }
}

export async function saveServiceConfig(
  config: ServiceConfig,
  dataDir?: string,
): Promise<void> {
  const dir = getDataDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  config.updatedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(dir, SERVICE_FILE),
    JSON.stringify(config, null, 2),
    "utf-8",
  );
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/config/service-config.test.ts`
Expected: PASS (all 3 tests)

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass.

**Step 6: Commit**

```bash
git add src/modules/config/service-config.ts src/modules/config/service-config.test.ts
git commit -m "feat: add ServiceConfig type and load/save helpers"
```

---

### Task 2: Add config status detection

**Files:**
- Modify: `src/modules/config/service-config.ts` (add detectConfigGaps function)
- Modify: `src/modules/config/service-config.test.ts` (add detection tests)

**Step 1: Write failing tests**

Add to the existing test file:

```typescript
import {
  loadServiceConfig,
  saveServiceConfig,
  detectConfigGaps,
  type ServiceConfig,
  type ConfigGap,
} from "./service-config.js";

describe("detectConfigGaps", () => {
  it("reports all gaps when nothing is configured", async () => {
    const gaps = await detectConfigGaps(testDir);
    expect(gaps.length).toBe(6);
    expect(gaps.map((g) => g.module).sort()).toEqual([
      "coverGen", "intelSources", "omni", "platforms", "tts", "videoCrawler",
    ]);
  });

  it("reports no gap for configured modules", async () => {
    await saveServiceConfig({
      omni: {
        provider: "xiaomi",
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2-omni",
        apiKey: "key",
      },
      configuredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, testDir);

    const gaps = await detectConfigGaps(testDir);
    const modules = gaps.map((g) => g.module);
    expect(modules).not.toContain("omni");
    expect(modules).toContain("coverGen");
  });

  it("each gap has module, feature, and impact", async () => {
    const gaps = await detectConfigGaps(testDir);
    for (const gap of gaps) {
      expect(gap.module).toBeDefined();
      expect(gap.feature).toBeDefined();
      expect(gap.impact).toBeDefined();
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/config/service-config.test.ts -t "detectConfigGaps"`
Expected: FAIL — function not defined.

**Step 3: Implement detectConfigGaps**

Add to `src/modules/config/service-config.ts`:

```typescript
export interface ConfigGap {
  module: string;
  feature: string;
  impact: string;
}

const GAP_DEFINITIONS: Array<{
  module: string;
  feature: string;
  impact: string;
  check: (config: ServiceConfig) => boolean;
}> = [
  {
    module: "omni",
    feature: "视频分析 (Omni)",
    impact: "视频拆解功能不可用",
    check: (c) => !!c.omni?.apiKey,
  },
  {
    module: "coverGen",
    feature: "封面生成",
    impact: "AI 封面生成不可用",
    check: (c) => !!c.coverGen?.apiKey,
  },
  {
    module: "videoCrawler",
    feature: "视频采集器",
    impact: "视频链接下载需手动操作",
    check: (c) => !!c.videoCrawler && c.videoCrawler.type !== "manual",
  },
  {
    module: "tts",
    feature: "TTS 语音合成",
    impact: "视频配音不可用",
    check: (c) => !!c.tts?.apiKey,
  },
  {
    module: "platforms",
    feature: "发布平台",
    impact: "自动发布不可用",
    check: (c) => {
      if (!c.platforms) return false;
      return Object.values(c.platforms).some((p) => p.configured);
    },
  },
  {
    module: "intelSources",
    feature: "情报源",
    impact: "RSS/趋势/竞品监控为空",
    check: (c) => {
      if (!c.intelSources) return false;
      return c.intelSources.rssConfigured ||
        c.intelSources.trendsConfigured ||
        c.intelSources.competitorsConfigured;
    },
  },
];

export async function detectConfigGaps(
  dataDir?: string,
): Promise<ConfigGap[]> {
  const config = await loadServiceConfig(dataDir);
  return GAP_DEFINITIONS
    .filter((def) => !def.check(config))
    .map(({ module, feature, impact }) => ({ module, feature, impact }));
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/config/service-config.test.ts`
Expected: PASS (all 6 tests)

**Step 5: Run full test suite**

Run: `npm test`
Expected: All pass.

**Step 6: Commit**

```bash
git add src/modules/config/service-config.ts src/modules/config/service-config.test.ts
git commit -m "feat: add config gap detection with feature impact descriptions"
```

---

### Task 3: Create configure skill SKILL.md

**Files:**
- Create: `skills/configure/SKILL.md`

**Step 1: Write the skill**

Create `skills/configure/SKILL.md` with:
- Triggers: "配置" / "configure" / "设置工具" / "config"
- Step 1: Load services.json via skill instructions (not a tool call — read the file directly)
- Step 2: Detect gaps and display status report (configured vs unconfigured, with impact)
- Step 3: Recommend top 2 most impactful unconfigured modules
- Step 4: User selects module → run that module's guided flow (per design doc)
- Step 5: Save to services.json
- Step 6: Validate API key if applicable (send test request)
- Step 7: Ask to continue with another module or exit

Each module's guided flow should be embedded in the skill as a subsection with exact
prompts and option lists (from the design doc's "各模块引导流程" section).

**Important skill directives:**
- "NEVER store API keys in creator-profile.json. ALL service configs go to services.json."
- "After saving, ALWAYS read back services.json to confirm the save succeeded."
- "For API key validation: make a minimal test request (e.g., text completion with 'hi')
   to verify the key works. Report success/failure clearly."

**Step 2: Verify skill file**

Run: `head -6 skills/configure/SKILL.md`
Expected: valid YAML frontmatter.

**Step 3: Commit**

```bash
git add skills/configure/SKILL.md
git commit -m "feat: add configure skill for guided service setup"
```

---

### Task 4: Migrate omniConfig/videoCrawler from CreatorProfile to ServiceConfig

**Files:**
- Modify: `src/modules/profile/creator-profile.ts` (keep interfaces for backward compat, add deprecation)
- Create: `src/modules/config/migrate.ts` (migration function)
- Test: `src/modules/config/migrate.test.ts`

**Step 1: Write failing test**

Create `src/modules/config/migrate.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateProfileToServices } from "./migrate.js";
import { loadServiceConfig } from "./service-config.js";
import { loadProfile } from "../profile/creator-profile.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-migrate-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe("migrateProfileToServices", () => {
  it("moves omniConfig and videoCrawler from profile to services", async () => {
    // Write a profile with the old fields
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(
      path.join(testDir, "creator-profile.json"),
      JSON.stringify({
        industry: "tech",
        platforms: ["douyin"],
        audiencePersona: null,
        creatorPersona: null,
        writingRules: [],
        styleBoundaries: { never: [], always: [] },
        competitorAccounts: [],
        performanceHistory: [],
        expressionPersona: "",
        secondaryPersonas: [],
        styleCalibrated: false,
        createdAt: "2026-04-01",
        updatedAt: "2026-04-01",
        omniConfig: {
          baseUrl: "https://api.xiaomimimo.com/v1",
          model: "mimo-v2-omni",
          apiKey: "old-key",
        },
        videoCrawler: { type: "mediacrawl", command: "python3 /opt/mc/main.py" },
      }),
      "utf-8",
    );

    const result = await migrateProfileToServices(testDir);
    expect(result.migrated).toBe(true);

    // services.json should have the configs
    const svc = await loadServiceConfig(testDir);
    expect(svc.omni?.apiKey).toBe("old-key");
    expect(svc.omni?.provider).toBe("xiaomi");
    expect(svc.videoCrawler?.type).toBe("mediacrawl");

    // profile should no longer have them
    const profile = await loadProfile(testDir);
    expect((profile as any).omniConfig).toBeUndefined();
    expect((profile as any).videoCrawler).toBeUndefined();
  });

  it("skips migration when services.json already exists", async () => {
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(
      path.join(testDir, "services.json"),
      JSON.stringify({ configuredAt: "2026-04-01", updatedAt: "2026-04-01" }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(testDir, "creator-profile.json"),
      JSON.stringify({
        industry: "tech", platforms: [], audiencePersona: null,
        creatorPersona: null, writingRules: [], styleBoundaries: { never: [], always: [] },
        competitorAccounts: [], performanceHistory: [], expressionPersona: "",
        secondaryPersonas: [], styleCalibrated: false,
        createdAt: "2026-04-01", updatedAt: "2026-04-01",
        omniConfig: { baseUrl: "x", model: "y", apiKey: "z" },
      }),
      "utf-8",
    );

    const result = await migrateProfileToServices(testDir);
    expect(result.migrated).toBe(false);
    expect(result.reason).toContain("already exists");
  });

  it("handles profile without old fields gracefully", async () => {
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(
      path.join(testDir, "creator-profile.json"),
      JSON.stringify({
        industry: "tech", platforms: [], audiencePersona: null,
        creatorPersona: null, writingRules: [], styleBoundaries: { never: [], always: [] },
        competitorAccounts: [], performanceHistory: [], expressionPersona: "",
        secondaryPersonas: [], styleCalibrated: false,
        createdAt: "2026-04-01", updatedAt: "2026-04-01",
      }),
      "utf-8",
    );

    const result = await migrateProfileToServices(testDir);
    expect(result.migrated).toBe(false);
    expect(result.reason).toContain("nothing to migrate");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modules/config/migrate.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement migration**

Create `src/modules/config/migrate.ts`:

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import { loadServiceConfig, saveServiceConfig } from "./service-config.js";
import { loadProfile, saveProfile } from "../profile/creator-profile.js";

function getDataDir(customDir?: string): string {
  if (customDir) return customDir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

export async function migrateProfileToServices(
  dataDir?: string,
): Promise<{ migrated: boolean; reason?: string }> {
  const dir = getDataDir(dataDir);

  // Don't migrate if services.json already exists
  try {
    await fs.access(path.join(dir, "services.json"));
    return { migrated: false, reason: "services.json already exists" };
  } catch {
    // File doesn't exist — proceed
  }

  const profile = await loadProfile(dataDir);
  if (!profile) {
    return { migrated: false, reason: "no profile found" };
  }

  // Check if profile has old fields to migrate
  const raw = JSON.parse(
    await fs.readFile(path.join(dir, "creator-profile.json"), "utf-8"),
  );
  const hasOmni = !!raw.omniConfig;
  const hasCrawler = !!raw.videoCrawler;

  if (!hasOmni && !hasCrawler) {
    return { migrated: false, reason: "nothing to migrate" };
  }

  // Build services.json from old fields
  const now = new Date().toISOString();
  const svcConfig = await loadServiceConfig(dataDir);

  if (hasOmni) {
    svcConfig.omni = {
      provider: "xiaomi",
      baseUrl: raw.omniConfig.baseUrl,
      model: raw.omniConfig.model,
      apiKey: raw.omniConfig.apiKey,
    };
  }

  if (hasCrawler) {
    svcConfig.videoCrawler = {
      type: raw.videoCrawler.type,
      command: raw.videoCrawler.command,
    };
  }

  svcConfig.configuredAt = now;
  await saveServiceConfig(svcConfig, dataDir);

  // Remove old fields from profile
  delete raw.omniConfig;
  delete raw.videoCrawler;
  raw.updatedAt = now;
  await fs.writeFile(
    path.join(dir, "creator-profile.json"),
    JSON.stringify(raw, null, 2),
    "utf-8",
  );

  return { migrated: true };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modules/config/migrate.test.ts`
Expected: PASS (all 3 tests)

**Step 5: Run full test suite**

Run: `npm test`
Expected: All pass.

**Step 6: Commit**

```bash
git add src/modules/config/migrate.ts src/modules/config/migrate.test.ts
git commit -m "feat: migrate omniConfig/videoCrawler from profile to services.json"
```

---

### Task 5: Update teardown skill to read from services.json

**Files:**
- Modify: `skills/teardown/SKILL.md` (change config read path for omniConfig and videoCrawler)

**Step 1: Update config references**

In `skills/teardown/SKILL.md`, find all references to `creator-profile.json` → `omniConfig`
and `creator-profile.json` → `videoCrawler`, change them to read from `services.json` instead.

Specifically update:
- Step V1: "读取 `creator-profile.json` → `videoCrawler` 配置" → "读取 `~/.autocrew/services.json` → `videoCrawler` 配置"
- Step V3: "读取 `creator-profile.json` → `omniConfig`" → "读取 `~/.autocrew/services.json` → `omni` 配置"
- Error message for missing omniConfig: update the JSON example to show services.json format

Keep `creator-profile.json` reference for the persona/style comparison (that stays in profile).

**Step 2: Verify the skill references are consistent**

Read back the modified sections to verify all paths point to services.json for tool config
and creator-profile.json for identity.

**Step 3: Commit**

```bash
git add skills/teardown/SKILL.md
git commit -m "refactor: teardown reads tool config from services.json"
```

---

## Summary

| Task | Description | Files | Commits |
|------|-------------|-------|---------|
| 1 | ServiceConfig type + load/save | service-config.ts, test | 1 |
| 2 | Config gap detection | service-config.ts, test | 1 |
| 3 | Configure skill SKILL.md | skills/configure/SKILL.md | 1 |
| 4 | Migration: profile → services.json | migrate.ts, test | 1 |
| 5 | Update teardown to read services.json | skills/teardown/SKILL.md | 1 |

Total: 5 tasks, 5 commits, ~300 lines new code + 1 new skill.
