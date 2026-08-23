/**
 * retro.test.ts — 复盘生成器:事实采集进 prompt、报告落盘、列表/读取、文件名白名单。
 * 全 mock 零网络(注入 runLoopImpl)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateRetro, listRetros, readRetro } from "./retro.js";
import { appendHypotheses, listHypotheses, type Hypothesis } from "./hypotheses.js";
import { setGoal } from "../profile/goal.js";
import { saveContent, updateContent, recordAdoption } from "../../storage/local-store.js";
import type { runLoop } from "../../engine/loop.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-retro-"));
  await fs.writeFile(path.join(dir, "engine.json"), JSON.stringify({ apiKey: "sk-test" }), "utf-8");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

interface Captured {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  baseUrl?: string;
}

const REPORT_MD = `# 周复盘\n\n## 本周产出\n写了两篇。\n\n## 数据表现\n数据不足。\n\n## 对照目标\n进展正常。\n\n## 下周建议\n- 回填数据\n- 继续写\n\n${"补".repeat(200)}`;

function mockLoop(markdown: string | null, captured?: Captured[]): typeof runLoop {
  return (async (
    config: { baseUrl?: string },
    opts: { model?: string; systemPrompt: string; userMessage: string; tools: Array<{ name: string; execute: (a: Record<string, unknown>) => unknown }> },
  ) => {
    captured?.push({ systemPrompt: opts.systemPrompt, userMessage: opts.userMessage, model: opts.model, baseUrl: config.baseUrl });
    if (markdown !== null) {
      const tool = opts.tools.find((t) => t.name === "submit_retro");
      if (tool) await tool.execute({ markdown });
    }
    return { stopReason: "tool", turns: 1, totalTokens: 456, finalText: "" };
  }) as unknown as typeof runLoop;
}

async function seedFacts(): Promise<void> {
  await setGoal({ statement: "三个月破万粉" }, dir);
  const c1 = await saveContent({ title: "本周稿件A", body: "b", platform: "wechat_mp", status: "draft_ready", tags: [], hashtags: [] }, dir);
  await recordAdoption(c1.id, "adopted", dir);
  const c2 = await saveContent({ title: "已发稿B", body: "b", platform: "xiaohongshu", status: "published", tags: [], hashtags: [] }, dir);
  await updateContent(c2.id, { publishedAt: new Date().toISOString() } as never, dir);
  const today = new Date().toISOString().slice(0, 10);
  await fs.writeFile(
    path.join(dir, "outcomes.jsonl"),
    JSON.stringify({
      contentId: c2.id, platform: "xiaohongshu", platformTitle: "已发稿B", publishedAt: null,
      metricDate: today, metrics: { views: 900, likes: 80 }, source: "csv",
      recordedAt: new Date().toISOString(), needsReview: false, reviewReasons: [],
    }) + "\n",
    "utf-8",
  );
}

describe("generateRetro", () => {
  it("uses the dedicated analytics route when configured", async () => {
    await fs.writeFile(
      path.join(dir, "engine.json"),
      JSON.stringify({
        apiKey: "sk-shared",
        routes: {
          analytics: {
            baseUrl: "https://code.newcli.com/claude/ultra",
            model: "claude-opus-4-8",
            protocol: "anthropic",
          },
        },
      }),
    );
    const captured: Captured[] = [];
    await generateRetro("weekly", dir, { runLoopImpl: mockLoop(REPORT_MD, captured) });
    expect(captured[0]).toMatchObject({
      model: "claude-opus-4-8",
      baseUrl: "https://code.newcli.com/claude/ultra",
    });
  });

  it("周复盘:事实(产出/数据/目标)进 prompt,报告落盘 reports/", async () => {
    await seedFacts();
    const captured: Captured[] = [];
    const result = await generateRetro("weekly", dir, { runLoopImpl: mockLoop(REPORT_MD, captured) });

    expect(captured[0].userMessage).toContain("本周稿件A");
    expect(captured[0].userMessage).toContain("已发稿B");
    expect(captured[0].userMessage).toContain("三个月破万粉");
    expect(captured[0].userMessage).toContain("采纳率");
    expect(captured[0].systemPrompt).toContain("下周建议");

    // 文件名带时间戳型 runId(spec §5.4):同日重跑不互相覆盖
    expect(result.file).toMatch(/^retro-weekly-\d{4}-\d{2}-\d{2}T\d{6}\.md$/);
    const onDisk = await fs.readFile(path.join(dir, "reports", result.file), "utf-8");
    expect(onDisk).toContain("# 周复盘");
    expect(result.tokensUsed).toBe(456);
  });

  it("月复盘:深层结构(画像漂移/策略提案需确认)进 system prompt", async () => {
    await seedFacts();
    const captured: Captured[] = [];
    await generateRetro("monthly", dir, { runLoopImpl: mockLoop(REPORT_MD, captured) });
    expect(captured[0].systemPrompt).toContain("画像漂移");
    expect(captured[0].systemPrompt).toContain("提案——需创始人确认后执行");
  });

  it("生产用时:代码算好的事实进 prompt,并随产物结构化返回(不由模型算)", async () => {
    const HOUR = 3600_000;
    // 有全套戳的稿:开写 → 2h 稿成 → 26h 发布
    const timed = await saveContent({ title: "带戳稿", body: "b", platform: "wechat_mp", status: "published", tags: [], hashtags: [] }, dir);
    const base = Date.parse(timed.createdAt);
    await updateContent(timed.id, {
      draftReadyAt: new Date(base + 2 * HOUR).toISOString(),
      publishedAt: new Date(base + 26 * HOUR).toISOString(),
    }, dir);
    // 戳上线前的旧稿:只有发布戳,分段必须跳过并被点名
    const legacy = await saveContent({ title: "缺戳旧稿", body: "b", platform: "wechat_mp", status: "published", tags: [], hashtags: [] }, dir);
    await updateContent(legacy.id, { publishedAt: new Date(Date.parse(legacy.createdAt) + HOUR).toISOString() }, dir);

    const captured: Captured[] = [];
    const result = await generateRetro("weekly", dir, { runLoopImpl: mockLoop(REPORT_MD, captured) });

    expect(captured[0].userMessage).toContain("内容生产用时");
    expect(captured[0].userMessage).toContain("开写→稿成:中位 2 小时(1 篇)");
    expect(captured[0].userMessage).toContain("1 篇缺时间戳未计入");
    expect(result.timing.published).toBe(2);
    expect(result.timing.drafting).toMatchObject({ count: 1, medianText: "2 小时" });
    expect(result.timing.endToEnd.count).toBe(2); // 全程两头有戳,旧稿也算得出
    expect(result.timing.missingStamps).toBe(1);
  });

  it("本期无发布:用时段明说无数据 + 禁止编造", async () => {
    const captured: Captured[] = [];
    const result = await generateRetro("weekly", dir, { runLoopImpl: mockLoop(REPORT_MD, captured) });
    expect(captured[0].userMessage).toContain("无用时可算");
    expect(result.timing).toMatchObject({ published: 0, missingStamps: 0 });
    expect(result.timing.endToEnd.medianText).toBeNull();
  });

  it("模型不提交 → 明确报错,不落盘", async () => {
    await expect(generateRetro("weekly", dir, { runLoopImpl: mockLoop(null) })).rejects.toThrow(/submit_retro/);
    await expect(fs.access(path.join(dir, "reports"))).rejects.toThrow();
  });
});

// ── P2b/P2c:聚合口径 + 假设台账 ──
// 一律只断言 schema 与不变量(裁决不经模型、样本不足必 inconclusive、失败必明示),
// 绝不 exact-match 模型文本。

const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString();
const dateOf = (daysAgo: number) => iso(daysAgo).slice(0, 10);

function outcomeLine(o: Record<string, unknown>): string {
  return JSON.stringify({
    contentId: null, platform: "douyin", publishedAt: null, source: "auto",
    recordedAt: new Date().toISOString(), needsReview: false, reviewReasons: [], ...o,
  });
}

/** 每个作品一条 D+7 快照(发布于 20 天前,快照在 13 天前) */
async function seedAtAgeViews(views: Record<string, number>): Promise<void> {
  const lines = Object.entries(views).map(([id, v]) =>
    outcomeLine({ contentId: id, platformTitle: `稿件${id}`, publishedAt: iso(20), metricDate: dateOf(13), metrics: { views: v } }),
  );
  await fs.writeFile(path.join(dir, "outcomes.jsonl"), lines.join("\n") + "\n", "utf-8");
}

function openHypothesis(over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: "hyp-seed", statement: "问题式开头的视频播放高于账号基线", metricFocus: "views",
    direction: "up", scope: { platform: "douyin" }, contentIds: ["t1"],
    proposedAt: iso(21), retroRunId: "retro-weekly-2026-08-01T090000", status: "open", ...over,
  };
}

/** 按剧本连续调用 submit_retro,并把工具返回值收集起来(用来验「重试一次」的语义) */
function mockSubmits(
  calls: Array<{ markdown?: string; hypotheses?: string }>,
  opts?: { replies?: string[]; captured?: Captured[] },
): typeof runLoop {
  return (async (
    config: { baseUrl?: string },
    loopOpts: { model?: string; systemPrompt: string; userMessage: string; tools: Array<{ name: string; execute: (a: Record<string, unknown>) => unknown }> },
  ) => {
    opts?.captured?.push({ systemPrompt: loopOpts.systemPrompt, userMessage: loopOpts.userMessage, model: loopOpts.model, baseUrl: config.baseUrl });
    const tool = loopOpts.tools.find((t) => t.name === "submit_retro")!;
    for (const call of calls) {
      const reply = await tool.execute({
        markdown: call.markdown ?? REPORT_MD,
        ...(call.hypotheses !== undefined ? { hypotheses: call.hypotheses } : {}),
      });
      opts?.replies?.push(String(reply));
    }
    return { stopReason: "tool", turns: calls.length, totalTokens: 456, finalText: "" };
  }) as unknown as typeof runLoop;
}

const PROPOSAL = JSON.stringify([
  { statement: "问题式开头完播率更高", metricFocus: "completionRate", direction: "up", scope: { platform: "douyin" }, nextAction: "下周三条都用问题开头" },
]);

describe("聚合口径进 prompt(P2b)", () => {
  it("喂增量而非累计:老作品重抓的累计值不进本期,原始快照清单已废除", async () => {
    // 同一作品:6 月一条老快照 + 本周两条 → 本期增量只应是 200
    await fs.writeFile(
      path.join(dir, "outcomes.jsonl"),
      [
        outcomeLine({ contentId: "old", platformTitle: "老作品", publishedAt: iso(90), metricDate: dateOf(60), metrics: { views: 1000 } }),
        outcomeLine({ contentId: "old", platformTitle: "老作品", publishedAt: iso(90), metricDate: dateOf(5), metrics: { views: 5000 } }),
        outcomeLine({ contentId: "old", platformTitle: "老作品", publishedAt: iso(90), metricDate: dateOf(1), metrics: { views: 5200 } }),
      ].join("\n") + "\n",
      "utf-8",
    );
    const captured: Captured[] = [];
    await generateRetro("weekly", dir, { runLoopImpl: mockSubmits([{}], { captured }) });
    const msg = captured[0].userMessage;
    expect(msg).toContain("本期增量");
    expect(msg).toContain("播放 +200");
    expect(msg).not.toContain("5200"); // 累计值不许冒充本期表现
    expect(msg).not.toContain("本期数据快照"); // 「任意前 20 条原始 outcome」已废除
  });

  it("零快照:如实说明数据缺口,不泛泛「请回填」也不断言原因", async () => {
    const captured: Captured[] = [];
    await generateRetro("weekly", dir, { runLoopImpl: mockSubmits([{}], { captured }) });
    expect(captured[0].userMessage).toContain("一条快照都没有");
    expect(captured[0].userMessage).toContain("不要断言原因");
  });
});

describe("假设裁决与台账(P2c)", () => {
  it("裁决由代码算定并落台账,模型只负责解释", async () => {
    await seedAtAgeViews({ peer0: 100, peer1: 100, peer2: 100, peer3: 100, peer4: 100, t1: 200 });
    await appendHypotheses([openHypothesis()], dir);
    const captured: Captured[] = [];
    const result = await generateRetro("weekly", dir, { runLoopImpl: mockSubmits([{}], { captured }) });

    expect(captured[0].userMessage).toContain("[supported]");
    expect(captured[0].systemPrompt).toContain("严禁改判");
    expect(result.hypotheses).toMatchObject({ judged: 1, closed: 1, written: true });

    const stored = await listHypotheses(dir);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: "hyp-seed", status: "supported" });
    expect(stored[0].verdictAt).toBeTruthy();
    expect(stored[0].evidence).toMatchObject({ testValue: 200, baselineValue: 100, sampleSize: 1, baselineSampleSize: 5 });
    expect(stored[0].evidence?.note).toContain("观察性结论");
  });

  it("对照样本不足 → 必 inconclusive,且不闭合假设(留 open 等下期)", async () => {
    await seedAtAgeViews({ peer0: 100, peer1: 100, peer2: 100, t1: 9999 });
    await appendHypotheses([openHypothesis()], dir);
    const captured: Captured[] = [];
    const result = await generateRetro("weekly", dir, { runLoopImpl: mockSubmits([{}], { captured }) });

    expect(captured[0].userMessage).toContain("[inconclusive]");
    expect(result.hypotheses).toMatchObject({ judged: 1, closed: 0 });
    const stored = await listHypotheses(dir);
    expect(stored[0].status).toBe("open");
    expect(stored[0].verdictAt).toBeUndefined();
    expect(stored[0].evidence?.reason).toContain("对照样本");
  });

  it("模型提的新假设:校验通过 → 落台账,retroRunId 指向本次运行", async () => {
    const result = await generateRetro("weekly", dir, {
      runLoopImpl: mockSubmits([{ hypotheses: PROPOSAL }]),
    });
    expect(result.hypotheses).toMatchObject({ proposed: 1, written: true });
    const stored = await listHypotheses(dir);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: "open", retroRunId: result.runId, metricFocus: "completionRate" });
    expect(stored[0].nextAction).toBeTruthy();
  });

  it("假设块不合格:先给一次重试;第二次仍不合格 → 只出文字复盘 + 报告与结果双明示", async () => {
    const replies: string[] = [];
    const result = await generateRetro("weekly", dir, {
      runLoopImpl: mockSubmits([{ hypotheses: "{不是 JSON" }, { hypotheses: "还是坏的" }], { replies }),
    });
    expect(replies[0]).toMatch(/^Error/); // 第一次:要求重试
    expect(replies[1]).not.toMatch(/^Error/); // 第二次:收下报告,不再纠缠
    expect(result.hypotheses.written).toBe(false);
    expect(result.hypotheses.error).toContain("校验失败");
    expect(result.markdown).toContain("台账未写入");
    const onDisk = await fs.readFile(path.join(dir, "reports", result.file), "utf-8");
    expect(onDisk).toContain("台账未写入");
    expect(await listHypotheses(dir)).toEqual([]);
  });

  it("重试一次成功:台账照常写入", async () => {
    const result = await generateRetro("weekly", dir, {
      runLoopImpl: mockSubmits([{ hypotheses: "{坏的" }, { hypotheses: PROPOSAL }]),
    });
    expect(result.hypotheses).toMatchObject({ proposed: 1, written: true });
    expect(result.hypotheses.error).toBeUndefined();
    expect(await listHypotheses(dir)).toHaveLength(1);
  });

  it("观察性口径不靠模型自觉:模型没写就由代码补进报告", async () => {
    const result = await generateRetro("weekly", dir, { runLoopImpl: mockSubmits([{}]) });
    expect(result.markdown).toContain("观察性结论");
    const onDisk = await fs.readFile(path.join(dir, "reports", result.file), "utf-8");
    expect(onDisk).toContain("非对照实验");
  });
});

describe("runId 与写序(spec §5.4)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("同日重跑不互相覆盖:两份报告两个 runId", async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    const first = await generateRetro("weekly", dir, { runLoopImpl: mockSubmits([{}]) });
    vi.setSystemTime(t0 + 90_000);
    const second = await generateRetro("weekly", dir, { runLoopImpl: mockSubmits([{}]) });

    expect(second.runId).not.toBe(first.runId);
    const files = (await fs.readdir(path.join(dir, "reports"))).sort();
    expect(files).toHaveLength(2);
    const list = await listRetros(dir);
    expect(list[0].file).toBe(second.file); // 最新的排最前
    expect(await readRetro(dir, first.file)).toContain("# 周复盘");
  });

  // root 跑测试时 chmod 拦不住写入,那种环境下这条用例没有意义
  it.skipIf(process.getuid?.() === 0)("台账写盘失败 → 报告已落盘,失败在报告尾部明示", async () => {
    const ledger = path.join(dir, "hypotheses.jsonl");
    await fs.writeFile(ledger, "", "utf-8");
    await fs.chmod(ledger, 0o444); // 可读不可写:读得出台账,append 必失败
    const result = await generateRetro("weekly", dir, { runLoopImpl: mockSubmits([{ hypotheses: PROPOSAL }]) });
    expect(result.hypotheses).toMatchObject({ written: false, proposed: 0 });
    expect(result.hypotheses.error).toContain("台账写入失败");
    const onDisk = await fs.readFile(path.join(dir, "reports", result.file), "utf-8");
    expect(onDisk).toContain("# 周复盘");
    expect(onDisk).toContain("台账未写入");
  });

  it("台账读不出来 → 不盲写,报告明示本期没做假设裁决", async () => {
    await fs.mkdir(path.join(dir, "hypotheses.jsonl"), { recursive: true }); // 用目录占位,读必失败
    const captured: Captured[] = [];
    const result = await generateRetro("weekly", dir, {
      runLoopImpl: mockSubmits([{ hypotheses: PROPOSAL }], { captured }),
    });
    expect(captured[0].userMessage).toContain("假设台账:读取失败");
    expect(result.hypotheses).toMatchObject({ written: false, judged: 0, proposed: 0 });
    expect(result.hypotheses.error).toContain("台账读取失败");
    expect(result.markdown).toContain("台账未写入");
  });

  it("数据账本读不出来 → 说「数据不可用」,不说创作者没回填", async () => {
    await fs.mkdir(path.join(dir, "outcomes.jsonl"), { recursive: true });
    const captured: Captured[] = [];
    await generateRetro("weekly", dir, { runLoopImpl: mockSubmits([{}], { captured }) });
    expect(captured[0].userMessage).toContain("数据账本读取失败");
    expect(captured[0].userMessage).not.toContain("一条快照都没有");
  });
});

describe("listRetros / readRetro", () => {
  it("列表按日期倒序;读取往返;非法文件名拒读", async () => {
    await seedFacts();
    await generateRetro("weekly", dir, { runLoopImpl: mockLoop(REPORT_MD) });
    const reportsDir = path.join(dir, "reports");
    await fs.writeFile(path.join(reportsDir, "retro-monthly-2020-01-01.md"), "# 旧月报\n", "utf-8");
    await fs.writeFile(path.join(reportsDir, "notes.md"), "无关文件\n", "utf-8");

    const list = await listRetros(dir);
    expect(list).toHaveLength(2);
    expect(list[0].mode).toBe("weekly"); // 今天的排最前
    expect(list[1]).toMatchObject({ mode: "monthly", date: "2020-01-01" });

    const md = await readRetro(dir, list[0].file);
    expect(md).toContain("# 周复盘");
    expect(await readRetro(dir, "../creator-profile.json")).toBeNull();
    expect(await readRetro(dir, "notes.md")).toBeNull();
  });
});
