import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDashboardSummary } from "./dashboard-summary.js";
import { saveContent, saveTopic, updateContent, type Content } from "../storage/local-store.js";
import { saveProfile } from "../modules/profile/creator-profile.js";
import { recordOutcome } from "../modules/flywheel/outcome-store.js";
import { PULL_STATE_FILE, defaultPullState, writePullState } from "../modules/flywheel/pull-state.js";
import type { OutcomeMetrics } from "../modules/flywheel/outcome-schema.js";
import type { CreatorProfile, WritingRule } from "../modules/profile/creator-profile.js";

let testDir: string;
const NOW = new Date("2026-07-08T12:00:00Z").getTime();

function daysAgo(n: number): string {
  return new Date(NOW - n * 86_400_000).toISOString();
}

/** metricDate 与判据都走本地时区日期——测试跟着同一把尺子,换时区跑也不飘 */
function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 回填一条 outcome（判据的真实数据源）——写 performanceData 已不再消待办 */
async function seedOutcome(over: {
  contentId: string; publishedAt: string; metricDate: string;
  platform?: string; title?: string; metrics?: OutcomeMetrics;
}): Promise<void> {
  const r = await recordOutcome({
    contentId: over.contentId,
    platform: over.platform ?? "wechat_mp",
    platformTitle: over.title ?? "平台标题",
    publishedAt: over.publishedAt,
    metricDate: over.metricDate,
    metrics: over.metrics ?? { views: 100 },
    source: "paste",
  }, testDir);
  expect(r.ok).toBe(true);
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
    ...(over.videoReadyAt !== undefined ? { videoReadyAt: over.videoReadyAt } : {}),
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

  it("backfill todos: published without outcomes, T+1 due / T+3 overdue, backfilled ones excluded", async () => {
    await saveProfile(profileWith([]), testDir);
    await seedContent({ title: "拖了四天", status: "published", publishedAt: daysAgo(4) });
    await seedContent({ title: "该回了", status: "published", publishedAt: daysAgo(2) });
    await seedContent({ title: "刚发不催", status: "published", publishedAt: daysAgo(0) });
    const filled = await seedContent({ title: "已回填", status: "published", publishedAt: daysAgo(5) });
    await seedOutcome({ contentId: filled.id, publishedAt: daysAgo(5), metricDate: localDay(daysAgo(3)) });

    const d = await buildDashboardSummary(testDir, NOW);

    expect(d.outcomesAvailable).toBe(true);
    expect(d.backfillTodos.map((t) => t.title)).toEqual(["拖了四天", "该回了"]);
    expect(d.backfillTodos[0].level).toBe("overdue");
    expect(d.backfillTodos[1].level).toBe("due");
  });

  it("backfill judged by outcomes, not performanceData: 写了 performanceData 但没 outcome 照样催", async () => {
    await saveProfile(profileWith([]), testDir);
    await seedContent({
      title: "双账不相遇", status: "published", publishedAt: daysAgo(4),
      performanceData: { views: 100 },
    });

    const d = await buildDashboardSummary(testDir, NOW);

    expect(d.backfillTodos.map((t) => t.title)).toEqual(["双账不相遇"]);
  });

  it("发布当天的快照不算已回填;发布日之后的快照才清待办", async () => {
    await saveProfile(profileWith([]), testDir);
    const sameDay = await seedContent({ title: "只有当天快照", status: "published", publishedAt: daysAgo(4) });
    await seedOutcome({ contentId: sameDay.id, publishedAt: daysAgo(4), metricDate: localDay(daysAgo(4)), metrics: { views: 0 } });
    const later = await seedContent({ title: "次日有快照", status: "published", publishedAt: daysAgo(4) });
    await seedOutcome({ contentId: later.id, publishedAt: daysAgo(4), metricDate: localDay(daysAgo(3)), metrics: { views: 0 } });

    const d = await buildDashboardSummary(testDir, NOW);

    expect(d.backfillTodos.map((t) => t.title)).toEqual(["只有当天快照"]);
  });

  it("核心指标(views/likes/comments)全空的快照不算已回填", async () => {
    await saveProfile(profileWith([]), testDir);
    const c = await seedContent({ title: "只回了完播率", status: "published", publishedAt: daysAgo(4) });
    await seedOutcome({
      contentId: c.id, publishedAt: daysAgo(4), metricDate: localDay(daysAgo(2)),
      metrics: { completionRate: 30 },
    });

    const d = await buildDashboardSummary(testDir, NOW);

    expect(d.backfillTodos.map((t) => t.title)).toEqual(["只回了完播率"]);
  });

  it("outcomes 读失败 → outcomesAvailable=false 且不产生假待办", async () => {
    await saveProfile(profileWith([]), testDir);
    await seedContent({ title: "拖了四天", status: "published", publishedAt: daysAgo(4) });
    // 把 journal 变成目录:读取抛 EISDIR（非 ENOENT）——不是「没有数据」,是「读不出来」
    await fs.mkdir(path.join(testDir, "outcomes.jsonl"), { recursive: true });

    const d = await buildDashboardSummary(testDir, NOW);

    expect(d.outcomesAvailable).toBe(false);
    expect(d.backfillTodos).toEqual([]);
    // 其余组件照常返回,不因回流不可用整屏挂掉
    expect(d.pipeline.published).toBe(1);
  });

  it("成片就绪待发布：videoReadyAt 非空且未进发布流程才算待办", async () => {
    await saveProfile(profileWith([]), testDir);
    await seedContent({ title: "剪好三天没发", status: "draft_ready", platform: "douyin", videoReadyAt: daysAgo(3) });
    await seedContent({ title: "刚剪好", status: "reviewing", platform: "douyin", videoReadyAt: daysAgo(0) });
    await seedContent({ title: "已进待发布", status: "publish_ready", platform: "douyin", videoReadyAt: daysAgo(4) });
    await seedContent({ title: "已发过", status: "published", platform: "douyin", videoReadyAt: daysAgo(5), publishedAt: daysAgo(4) });
    await seedContent({ title: "没剪过片", status: "draft_ready", platform: "douyin" });

    const d = await buildDashboardSummary(testDir, NOW);

    expect(d.videoReadyTodos.map((t) => t.title)).toEqual(["剪好三天没发", "刚剪好"]);
    expect(d.videoReadyTodos[0].daysSince).toBe(3);
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

// ── 登录态过期待办（自动回流 spec §4.4） ────────────────────────────────────

describe("buildDashboardSummary — 自动回流登录待办", () => {
  it("已启用平台 needs_login → 出待办，带扫码后台地址", async () => {
    const state = defaultPullState();
    state.platforms.wechat_video = { ...state.platforms.wechat_video, enabled: true, lastStatus: "needs_login" };
    await writePullState(state, testDir);

    const d = await buildDashboardSummary(testDir, NOW);
    expect(d.pullStateAvailable).toBe(true);
    expect(d.pullLoginTodos).toHaveLength(1);
    expect(d.pullLoginTodos[0]).toMatchObject({ platform: "wechat_video", label: "视频号" });
    expect(d.pullLoginTodos[0].consoleUrl).toContain("channels.weixin.qq.com");
  });

  it("没开自动回流的平台即使 needs_login 也不催（人没让它抓）", async () => {
    const state = defaultPullState();
    state.platforms.douyin = { ...state.platforms.douyin, enabled: false, lastStatus: "needs_login" };
    await writePullState(state, testDir);
    expect((await buildDashboardSummary(testDir, NOW)).pullLoginTodos).toHaveLength(0);
  });

  it("其他状态不产生登录待办（风控/超时各有各的说法）", async () => {
    const state = defaultPullState();
    state.platforms.xiaohongshu = { ...state.platforms.xiaohongshu, enabled: true, lastStatus: "risk_control" };
    await writePullState(state, testDir);
    expect((await buildDashboardSummary(testDir, NOW)).pullLoginTodos).toHaveLength(0);
  });

  it("状态文件读不出来 → 「不可用」显式态，不造假待办", async () => {
    await fs.mkdir(path.join(testDir, PULL_STATE_FILE));
    const d = await buildDashboardSummary(testDir, NOW);
    expect(d.pullStateAvailable).toBe(false);
    expect(d.pullLoginTodos).toEqual([]);
  });
});
