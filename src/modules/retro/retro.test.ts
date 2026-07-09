/**
 * retro.test.ts — 复盘生成器:事实采集进 prompt、报告落盘、列表/读取、文件名白名单。
 * 全 mock 零网络(注入 runLoopImpl)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateRetro, listRetros, readRetro } from "./retro.js";
import { setGoal } from "../profile/goal.js";
import { saveContent, updateContent, recordAdoption } from "../../storage/local-store.js";
import type { runLoop } from "../../engine/loop.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-retro-"));
  await fs.writeFile(path.join(dir, "engine.json"), JSON.stringify({ apiKey: "sk-test" }), "utf-8");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

interface Captured {
  systemPrompt: string;
  userMessage: string;
}

const REPORT_MD = `# 周复盘\n\n## 本周产出\n写了两篇。\n\n## 数据表现\n数据不足。\n\n## 对照目标\n进展正常。\n\n## 下周建议\n- 回填数据\n- 继续写\n\n${"补".repeat(200)}`;

function mockLoop(markdown: string | null, captured?: Captured[]): typeof runLoop {
  return (async (
    _config: unknown,
    opts: { systemPrompt: string; userMessage: string; tools: Array<{ name: string; execute: (a: Record<string, unknown>) => unknown }> },
  ) => {
    captured?.push({ systemPrompt: opts.systemPrompt, userMessage: opts.userMessage });
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
  it("周复盘:事实(产出/数据/目标)进 prompt,报告落盘 reports/", async () => {
    await seedFacts();
    const captured: Captured[] = [];
    const result = await generateRetro("weekly", dir, { runLoopImpl: mockLoop(REPORT_MD, captured) });

    expect(captured[0].userMessage).toContain("本周稿件A");
    expect(captured[0].userMessage).toContain("已发稿B");
    expect(captured[0].userMessage).toContain("三个月破万粉");
    expect(captured[0].userMessage).toContain("采纳率");
    expect(captured[0].systemPrompt).toContain("下周建议");

    expect(result.file).toMatch(/^retro-weekly-\d{4}-\d{2}-\d{2}\.md$/);
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

  it("模型不提交 → 明确报错,不落盘", async () => {
    await expect(generateRetro("weekly", dir, { runLoopImpl: mockLoop(null) })).rejects.toThrow(/submit_retro/);
    await expect(fs.access(path.join(dir, "reports"))).rejects.toThrow();
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
