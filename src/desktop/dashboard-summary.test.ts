import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDashboardSummary } from "./dashboard-summary.js";
import { saveContent, saveTopic, updateContent, type Content } from "../storage/local-store.js";
import { saveProfile } from "../modules/profile/creator-profile.js";
import type { CreatorProfile, WritingRule } from "../modules/profile/creator-profile.js";

let testDir: string;
const NOW = new Date("2026-07-08T12:00:00Z").getTime();

function daysAgo(n: number): string {
  return new Date(NOW - n * 86_400_000).toISOString();
}

async function seedContent(over: Partial<Content> & { title: string }): Promise<Content> {
  const c = await saveContent(
    { title: over.title, body: "正文", platform: over.platform ?? "wechat_mp", status: "drafting" },
    testDir,
  );
  const patched = await updateContent(c.id, {
    status: over.status ?? "drafting",
    ...(over.publishedAt !== undefined ? { publishedAt: over.publishedAt } : {}),
    ...(over.performanceData !== undefined ? { performanceData: over.performanceData } : {}),
  } as Partial<Content>, testDir);
  // updatedAt 由 store 控制;测试直接改文件时间戳字段
  if (over.updatedAt) {
    const raw = JSON.parse(await fs.readFile(path.join(testDir, "contents", c.id, "meta.json"), "utf-8"));
    raw.updatedAt = over.updatedAt;
    await fs.writeFile(path.join(testDir, "contents", c.id, "meta.json"), JSON.stringify(raw));
  }
  return patched!;
}

function profileWith(rules: Array<Partial<WritingRule> & { rule: string }>): CreatorProfile {
  const now = new Date(NOW).toISOString();
  return {
    industry: "AI 效率工具", platforms: ["wechat_mp"], audiencePersona: null,
    writingRules: rules.map((r) => ({
      rule: r.rule, source: r.source ?? "auto_distilled", confidence: r.confidence ?? 0.8,
      ...(r.scope ? { scope: r.scope } : {}), ...(r.disabled ? { disabled: r.disabled } : {}),
      createdAt: r.createdAt ?? now,
    })),
    styleBoundaries: { never: [], always: [] }, competitorAccounts: [], performanceHistory: [],
    styleCalibrated: true, createdAt: now, updatedAt: now,
  };
}

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-dash-test-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("buildDashboardSummary", () => {
  it("review queue sorts overdue > window > fresh", async () => {
    await saveProfile(profileWith([]), testDir);
    // fresh：昨天更新,平台今天刚发过（无窗口压力）
    await seedContent({ title: "新完成", status: "reviewing", updatedAt: daysAgo(1) });
    await seedContent({ title: "已发垫底", status: "published", publishedAt: daysAgo(0), performanceData: { views: 1 } });
    // overdue：压了 5 天
    await seedContent({ title: "压了五天", status: "reviewing", updatedAt: daysAgo(5) });
    // window：douyin 从未发过 → 距上次发布 = Infinity > 3 天
    await seedContent({ title: "该发抖音了", status: "reviewing", platform: "douyin", updatedAt: daysAgo(1) });

    const d = await buildDashboardSummary(testDir, NOW);

    expect(d.reviewQueue.map((r) => r.title)).toEqual(["压了五天", "该发抖音了", "新完成"]);
    expect(d.reviewQueue[0].priority).toBe("overdue");
    expect(d.reviewQueue[1].priority).toBe("window");
    expect(d.reviewQueue[2].priority).toBe("fresh");
  });

  it("backfill todos: published without metrics, T+1 due / T+3 overdue, filled ones excluded", async () => {
    await saveProfile(profileWith([]), testDir);
    await seedContent({ title: "拖了四天", status: "published", publishedAt: daysAgo(4) });
    await seedContent({ title: "该回了", status: "published", publishedAt: daysAgo(2) });
    await seedContent({ title: "刚发不催", status: "published", publishedAt: daysAgo(0) });
    await seedContent({ title: "已回填", status: "published", publishedAt: daysAgo(5), performanceData: { views: 100 } });

    const d = await buildDashboardSummary(testDir, NOW);

    expect(d.backfillTodos.map((t) => t.title)).toEqual(["拖了四天", "该回了"]);
    expect(d.backfillTodos[0].level).toBe("overdue");
    expect(d.backfillTodos[1].level).toBe("due");
  });

  it("calibration card counts active rules and voice_core; disabled excluded", async () => {
    await saveProfile(profileWith([
      { rule: "内核1", scope: "voice_core" },
      { rule: "无scope=内核" },
      { rule: "平台规", scope: "platform:wechat_mp" },
      { rule: "停用的", disabled: true },
    ]), testDir);

    const d = await buildDashboardSummary(testDir, NOW);

    expect(d.calibration.activeRuleCount).toBe(3);
    expect(d.calibration.voiceCoreCount).toBe(2);
    expect(d.calibration.styleCalibrated).toBe(true);
    expect(d.calibration.recentRules).toHaveLength(3);
  });

  it("inspirations return top-3 with reason/link; pipeline counts topics as idea", async () => {
    await saveProfile(profileWith([]), testDir);
    for (let i = 1; i <= 4; i++) {
      await saveTopic({ title: "灵感" + i, description: "d", tags: [], reason: "理由" + i, link: "https://x/" + i }, testDir);
    }
    const d = await buildDashboardSummary(testDir, NOW);
    expect(d.inspirations).toHaveLength(3);
    expect(d.inspirations[0].reason).toBeTruthy();
    expect(d.pipeline.idea).toBe(4);
  });

  it("tolerates legacy rules missing createdAt (real-workspace schema drift)", async () => {
    const p = profileWith([{ rule: "新规则" }]);
    // 模拟 schema 演进前的老规则:无 createdAt 字段
    (p.writingRules as Array<Record<string, unknown>>).push({ rule: "老规则", source: "user_explicit", confidence: 1 });
    await saveProfile(p, testDir);

    const d = await buildDashboardSummary(testDir, NOW);

    expect(d.calibration.activeRuleCount).toBe(2);
    expect(d.calibration.recentRules[0].rule).toBe("新规则"); // 缺 createdAt 当最旧排
  });

  it("isFirstRun: true without profile; false once calibrated or content exists", async () => {
    expect((await buildDashboardSummary(testDir, NOW)).isFirstRun).toBe(true);
    await saveProfile(profileWith([]), testDir); // styleCalibrated: true
    expect((await buildDashboardSummary(testDir, NOW)).isFirstRun).toBe(false);
  });
});
