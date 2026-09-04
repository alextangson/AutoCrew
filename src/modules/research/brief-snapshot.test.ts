/**
 * brief-snapshot.test.ts — 单一简报快照（P1 spec §3.0）。
 *
 * 核心那条是「指针 vs 磁盘最大版分歧」：磁盘上躺着一份更新的 v2，但台账指针还指着 v1
 * （重跑落了盘却没结算成，或结算失败不推进指针）——快照必须停在 v1。改动前注入认指针、
 * 角度解析认磁盘最大版，正是这个分歧把 brief v1 与 angle v2 拼进了同一稿。
 *
 * 全是确定性层：文件内容、指针、sha256——没有 LLM 参与。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { briefHash, resolveEffectiveBrief } from "./brief-snapshot.js";
import { BRIEF_SCHEMA_VERSION, briefPath, saveBrief, type ResearchBrief } from "./brief-store.js";
import { pendingPerspectives, upsertJob, type ResearchJob } from "./research-job-store.js";

let dataDir: string;
const TOPIC = "topic-snap01";

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-brief-snapshot-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function makeBrief(over: Partial<ResearchBrief> = {}): ResearchBrief {
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    summary: "四路指向一致：工具好用但维护成本被低估。",
    perspectives: [],
    tensions: [],
    angleSuggestions: [],
    evidence: [{ claim: "使用率高", quote: "62% 的开发者每天使用", sourceUrl: "https://example.com/a" }],
    assetPicks: [],
    missingPerspectives: [],
    gaps: [],
    generatedAt: "2026-09-01T08:00:00.000Z",
    revision: 1,
    topicHash: "hash-1",
    ...over,
  };
}

async function seedJob(over: Partial<ResearchJob> = {}): Promise<void> {
  await upsertJob(
    {
      topicId: TOPIC,
      status: "succeeded",
      startedAt: "2026-09-01T07:00:00.000Z",
      settledAt: "2026-09-01T08:00:00.000Z",
      perspectives: pendingPerspectives(),
      topicHash: "hash-1",
      ...over,
    },
    dataDir,
  );
}

describe("resolveEffectiveBrief — 只认 job.briefRevision", () => {
  it("没有 job → null（盘上有简报也不认）", async () => {
    await saveBrief(TOPIC, makeBrief(), dataDir);
    expect(await resolveEffectiveBrief(TOPIC, dataDir)).toBeNull();
  });

  it("有 job 但没有 briefRevision 指针 → null，绝不回落磁盘最新版", async () => {
    await saveBrief(TOPIC, makeBrief(), dataDir);
    await seedJob({ status: "failed", briefRevision: undefined });

    expect(await resolveEffectiveBrief(TOPIC, dataDir)).toBeNull();
  });

  it("指针指 v1、磁盘上还躺着更新的 v2 → 返回 v1（本刀要修的那个 bug）", async () => {
    await saveBrief(TOPIC, makeBrief({ revision: 1, summary: "v1 的判断" }), dataDir);
    await saveBrief(TOPIC, makeBrief({ revision: 2, summary: "v2 的判断" }), dataDir);
    await seedJob({ briefRevision: 1 });

    const snap = await resolveEffectiveBrief(TOPIC, dataDir);

    expect(snap?.revision).toBe(1);
    expect(snap?.brief.summary).toBe("v1 的判断");
  });

  it("指针推进到 v2 后 → 快照跟着走到 v2", async () => {
    await saveBrief(TOPIC, makeBrief({ revision: 1, summary: "v1 的判断" }), dataDir);
    await saveBrief(TOPIC, makeBrief({ revision: 2, summary: "v2 的判断" }), dataDir);
    await seedJob({ briefRevision: 2 });

    expect((await resolveEffectiveBrief(TOPIC, dataDir))?.brief.summary).toBe("v2 的判断");
  });

  it("指针指向的文件不存在 → null（不拿别的版本顶上）", async () => {
    await saveBrief(TOPIC, makeBrief({ revision: 1 }), dataDir);
    await seedJob({ briefRevision: 3 });

    expect(await resolveEffectiveBrief(TOPIC, dataDir)).toBeNull();
  });

  it("指针指向的文件坏了 → null + warn 可见，不静默回落上一版", async () => {
    await saveBrief(TOPIC, makeBrief({ revision: 1 }), dataDir);
    await fs.writeFile(briefPath(TOPIC, 2, dataDir), "{ 半条 JSON", "utf-8");
    await seedJob({ briefRevision: 2 });
    const warns: string[] = [];

    expect(await resolveEffectiveBrief(TOPIC, dataDir, (m) => warns.push(m))).toBeNull();
    expect(warns.some((w) => w.includes("损坏"))).toBe(true);
  });

  it("文件内记的 revision 与文件名对不上（被人手改过）→ null + warn", async () => {
    await fs.mkdir(path.dirname(briefPath(TOPIC, 1, dataDir)), { recursive: true });
    await fs.writeFile(
      briefPath(TOPIC, 1, dataDir),
      JSON.stringify(makeBrief({ revision: 7 })),
      "utf-8",
    );
    await seedJob({ briefRevision: 1 });
    const warns: string[] = [];

    expect(await resolveEffectiveBrief(TOPIC, dataDir, (m) => warns.push(m))).toBeNull();
    expect(warns.some((w) => w.includes("版本不符"))).toBe(true);
  });

  it("台账读不动（jobs.jsonl 是个目录）→ null + warn，不抛", async () => {
    await fs.mkdir(path.join(dataDir, "research", "jobs.jsonl"), { recursive: true });
    const warns: string[] = [];

    expect(await resolveEffectiveBrief(TOPIC, dataDir, (m) => warns.push(m))).toBeNull();
    expect(warns.length).toBeGreaterThan(0);
  });
});

describe("hash", () => {
  it("同一份简报每次都算出同一个 16 位十六进制指纹", async () => {
    await saveBrief(TOPIC, makeBrief(), dataDir);
    await seedJob({ briefRevision: 1 });

    const a = await resolveEffectiveBrief(TOPIC, dataDir);
    const b = await resolveEffectiveBrief(TOPIC, dataDir);

    expect(a!.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(a!.hash).toBe(b!.hash);
    expect(a!.hash).toBe(briefHash(makeBrief()));
  });

  it("键序不影响指纹（canonical JSON），内容变一个字就变", () => {
    const brief = makeBrief();
    const reordered = Object.fromEntries(
      Object.entries(brief as unknown as Record<string, unknown>).reverse(),
    ) as unknown as ResearchBrief;

    expect(briefHash(reordered)).toBe(briefHash(brief));
    expect(briefHash(makeBrief({ summary: "改了一个字" }))).not.toBe(briefHash(brief));
  });
});
