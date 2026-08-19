/**
 * Phase 2 到达面九工具（设计 §Phase 2）：每个工具 happy + fail，
 * fail 一律 `ok:false` 且消息里没有本地绝对路径；外加 move_content 的 enum 白名单
 * （发布相关状态在 schema 层就不存在）与封面/配图的 claim 双发互斥。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildChatTools, CREW_TOOL_STATUS, type ChatCard, type ChatToolDeps } from "./chat-router.js";
import type { LoopTool } from "../engine/loop.js";

const P2_TOOLS = [
  "create_cover", "generate_article_images", "move_content", "pre_publish_check",
  "list_campaigns", "campaign_status", "list_inbox", "retry_inbox", "list_versions",
];

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-p2-tools-"));
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function setup(deps: ChatToolDeps): { sink: ChatCard[]; tool: (name: string) => LoopTool } {
  const sink: ChatCard[] = [];
  const tools = buildChatTools(sink, testDir, deps);
  return {
    sink,
    tool: (name) => {
      const found = tools.find((t) => t.name === name);
      if (!found) throw new Error(`工具未注册：${name}`);
      return found;
    },
  };
}

const run = async (t: LoopTool, args: Record<string, unknown> = {}) => JSON.parse((await t.execute(args)) as string);

/** fail 路径的共同不变量：失败就是失败 + 不泄露本地绝对路径 */
function expectCleanFailure(parsed: Record<string, unknown>): void {
  expect(parsed.ok).toBe(false);
  expect(String(parsed.error)).not.toContain(testDir);
  expect(String(parsed.error)).not.toMatch(/\/(Users|home|tmp|var)\//);
  expect(String(parsed.error).length).toBeGreaterThan(0);
}

const startedCover = (runId = "run-cover-1") => ({ response: { ok: true, pending: true, runId }, completion: Promise.resolve() });
const startedImages = (runId = "run-images-1") => ({ response: { ok: true, pending: true, runId }, completion: Promise.resolve() });

describe("到达面工具注册", () => {
  it("九个工具都注册进 buildChatTools，且都有角色署名与人话标签", () => {
    const { tool } = setup({});
    const seats = ["scout", "writer", "review", "analyst", "publisher", "editor"];
    for (const name of P2_TOOLS) {
      expect(tool(name).description.length).toBeGreaterThan(0);
      const status = CREW_TOOL_STATUS[name];
      expect(status, `${name} 缺角色署名`).toBeDefined();
      expect(seats).toContain(status.role);
      expect(status.label.length).toBeGreaterThan(0);
    }
  });
});

describe("create_cover", () => {
  it("投递成功：推封面卡 + 回后台任务口吻，不等图", async () => {
    const startCover = vi.fn(async () => startedCover());
    const { sink, tool } = setup({ startCover });

    const out = await run(tool("create_cover"), { content_id: "content-cover-1", _dataDir: "/tmp/evil" });

    expect(startCover).toHaveBeenCalledWith({ content_id: "content-cover-1", _dataDir: testDir });
    expect(out).toMatchObject({ ok: true, pending: true, contentId: "content-cover-1", runId: "run-cover-1" });
    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatchObject({ type: "cover_job", data: { contentId: "content-cover-1", status: "running" } });
  });

  it("同一篇双发：第二次回「已在跑」，不重复投递", async () => {
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => (settle = resolve));
    const startCover = vi.fn(async () => ({ response: { ok: true, pending: true, runId: "run-cover-2" }, completion: pending }));
    const { sink, tool } = setup({ startCover });

    const first = await run(tool("create_cover"), { content_id: "content-cover-2" });
    const second = await run(tool("create_cover"), { content_id: "content-cover-2" });

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: true, alreadyRunning: true, contentId: "content-cover-2" });
    expect(String(second.note)).toContain("已在跑");
    expect(startCover).toHaveBeenCalledTimes(1);
    expect(sink).toHaveLength(1); // 用户视角只有一个任务

    settle();
    await pending;
  });

  it("投递被拒（生图未配置）：清洗后错误进对话，不推卡", async () => {
    const startCover = vi.fn(async () => ({
      response: { ok: false, error: "未配置 Gemini Key(封面生成需要)", hint: `去设置页填 key：${testDir}/cover.json` },
      completion: Promise.resolve(),
    }));
    const { sink, tool } = setup({ startCover });

    const out = await run(tool("create_cover"), { content_id: "content-cover-3" });

    expectCleanFailure(out);
    expect(String(out.error)).toContain("未配置 Gemini Key");
    expect(sink).toHaveLength(0);
  });

  it("投递失败后 claim 释放：修好可以再投", async () => {
    const startCover = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error(`生图中转连不上：${testDir}/relay.sock`);
      })
      .mockImplementationOnce(async () => startedCover("run-cover-retry"));
    const { tool } = setup({ startCover });

    expectCleanFailure(await run(tool("create_cover"), { content_id: "content-cover-4" }));
    expect(await run(tool("create_cover"), { content_id: "content-cover-4" })).toMatchObject({ ok: true, runId: "run-cover-retry" });
  });
});

describe("generate_article_images", () => {
  it("投递成功：推配图卡 + 回后台任务口吻", async () => {
    const startArticleImages = vi.fn(() => startedImages());
    const { sink, tool } = setup({ startArticleImages });

    const out = await run(tool("generate_article_images"), { content_id: "content-img-1" });

    expect(startArticleImages).toHaveBeenCalledWith({ content_id: "content-img-1", _dataDir: testDir });
    expect(out).toMatchObject({ ok: true, pending: true, runId: "run-images-1" });
    expect(sink[0]).toMatchObject({ type: "article_images_job", data: { contentId: "content-img-1" } });
  });

  it("同一篇双发回「已在跑」；封面与配图各自命名空间互不阻塞", async () => {
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => (settle = resolve));
    const startArticleImages = vi.fn(() => ({ response: { ok: true, pending: true, runId: "run-images-2" }, completion: pending }));
    const startCover = vi.fn(async () => startedCover("run-cover-parallel"));
    const { tool } = setup({ startArticleImages, startCover });

    await run(tool("generate_article_images"), { content_id: "content-img-2" });
    const second = await run(tool("generate_article_images"), { content_id: "content-img-2" });
    const cover = await run(tool("create_cover"), { content_id: "content-img-2" });

    expect(second).toMatchObject({ ok: true, alreadyRunning: true });
    expect(cover).toMatchObject({ ok: true, pending: true }); // 同一篇的封面照样能投
    expect(startArticleImages).toHaveBeenCalledTimes(1);

    settle();
    await pending;
  });

  it("投递被拒：清洗后错误，不推卡", async () => {
    const startArticleImages = vi.fn(() => ({
      response: { ok: false, error: `稿件不存在：${testDir}/contents/content-img-3/meta.json` },
      completion: Promise.resolve(),
    }));
    const { sink, tool } = setup({ startArticleImages });

    expectCleanFailure(await run(tool("generate_article_images"), { content_id: "content-img-3" }));
    expect(sink).toHaveLength(0);
  });
});

describe("move_content", () => {
  const movingContent = (transitionResult: Record<string, unknown>) =>
    vi.fn(async (params: Record<string, unknown>) =>
      params.action === "get"
        ? { ok: true, content: { id: "content-move-1", title: "AI 写作趋势", status: "draft_ready" } }
        : transitionResult,
    );

  it("schema enum 只含在写/待审的状态——发布相关的边根本不暴露给模型", () => {
    const { tool } = setup({});
    const params = tool("move_content").parameters as {
      properties: { target_status: { enum: string[] } };
    };
    const enumValues = params.properties.target_status.enum;

    expect(enumValues).toEqual(["draft_ready", "revision", "reviewing"]);
    for (const forbidden of ["approved", "publish_ready", "publishing", "published", "archived", "cover_pending"]) {
      expect(enumValues).not.toContain(forbidden);
    }
  });

  it("流转成功：推流转卡并带上从哪列到哪列", async () => {
    const content = movingContent({ ok: true, content: { id: "content-move-1", status: "reviewing" } });
    const { sink, tool } = setup({ content });

    const out = await run(tool("move_content"), { content_id: "content-move-1", target_status: "reviewing" });

    expect(content).toHaveBeenCalledWith(
      expect.objectContaining({ id: "content-move-1", target_status: "reviewing", action: "transition", _dataDir: testDir }),
    );
    expect(out).toMatchObject({ ok: true, contentId: "content-move-1", from: "draft_ready", to: "reviewing" });
    expect(sink[0]).toMatchObject({ type: "content_moved", data: { title: "AI 写作趋势", from: "draft_ready", to: "reviewing" } });
  });

  it("白名单外的目标状态：工具层直接拒，不发给后端", async () => {
    const content = movingContent({ ok: true });
    const { sink, tool } = setup({ content });

    const out = await run(tool("move_content"), { content_id: "content-move-1", target_status: "published" });

    expectCleanFailure(out);
    expect(String(out.error)).toContain("工作区");
    expect(content).not.toHaveBeenCalled();
    expect(sink).toHaveLength(0);
  });

  it("后端状态机拒绝：原因清洗后原样转述，不推卡", async () => {
    const content = movingContent({
      ok: false,
      error: `Invalid transition: published → reviewing (state file ${testDir}/contents/x/meta.json)`,
    });
    const { sink, tool } = setup({ content });

    const out = await run(tool("move_content"), { content_id: "content-move-1", target_status: "reviewing" });

    expectCleanFailure(out);
    expect(String(out.error)).toContain("Invalid transition");
    expect(sink).toHaveLength(0);
  });
});

describe("pre_publish_check", () => {
  const checks = [
    { name: "内容审核", status: "pass", detail: "通过 (质量 88/100)" },
    { name: "Hashtags", status: "fail", detail: "无标签", fix: "补 3 个标签" },
  ];

  it("只读跑检查：推报告卡 + 回未过项；不触发 publish_ready 自动流转", async () => {
    const prePublish = vi.fn(async () => ({
      ok: true, contentId: "content-pre-1", platform: "xiaohongshu", checks,
      allPassed: false, passCount: 1, failCount: 1, summary: "…",
    }));
    const { sink, tool } = setup({ prePublish: prePublish as never });

    const out = await run(tool("pre_publish_check"), { content_id: "content-pre-1" });

    expect(prePublish).toHaveBeenCalledWith(
      expect.objectContaining({ action: "check", content_id: "content-pre-1", _readOnly: true, _dataDir: testDir }),
    );
    expect(out).toMatchObject({ ok: true, allPassed: false, failCount: 1 });
    expect(out.issues).toHaveLength(1);
    expect(sink[0]).toMatchObject({ type: "pre_publish", data: { contentId: "content-pre-1", allPassed: false } });
  });

  it("稿件读不到：清洗后错误，不推卡", async () => {
    const prePublish = vi.fn(async () => ({ ok: false as const, error: `Content content-x not found in ${testDir}/contents` }));
    const { sink, tool } = setup({ prePublish });

    expectCleanFailure(await run(tool("pre_publish_check"), { content_id: "content-x" }));
    expect(sink).toHaveLength(0);
  });
});

describe("campaign 只读查询", () => {
  it("list_campaigns 回紧凑列表并推卡", async () => {
    const campaignList = vi.fn(async () => ({
      ok: true,
      data: {
        campaigns: [
          { id: "campaign-1", name: "独立站冷启动", status: "active", mode: "managed_growth", tasks: [{ status: "completed" }, { status: "ready" }] },
        ],
      },
    }));
    const { sink, tool } = setup({ campaignList });

    const out = await run(tool("list_campaigns"));

    expect(out).toMatchObject({ ok: true, total: 1 });
    expect(out.campaigns[0]).toMatchObject({ id: "campaign-1", status: "active", tasks: 2, done: 1 });
    expect(sink[0].type).toBe("campaigns");
  });

  it("list_campaigns 失败：清洗后错误", async () => {
    const campaignList = vi.fn(async () => ({ ok: false, error: `campaigns 目录读不到：${testDir}/campaigns` }));
    const { sink, tool } = setup({ campaignList });

    expectCleanFailure(await run(tool("list_campaigns")));
    expect(sink).toHaveLength(0);
  });

  it("campaign_status 回任务分布并推卡", async () => {
    const campaignGet = vi.fn(async () => ({
      ok: true,
      data: {
        campaign: {
          id: "campaign-1", name: "独立站冷启动", status: "active", mode: "managed_growth",
          tasks: [
            { id: "t1", title: "关键词调研", status: "completed", assigneeRole: "seo" },
            { id: "t2", title: "落地页文案", status: "ready", assigneeRole: "content" },
          ],
        },
      },
    }));
    const { sink, tool } = setup({ campaignGet });

    const out = await run(tool("campaign_status"), { campaign_id: "campaign-1" });

    expect(campaignGet).toHaveBeenCalledWith(expect.objectContaining({ id: "campaign-1", _dataDir: testDir }));
    expect(out).toMatchObject({ ok: true, id: "campaign-1", status: "active" });
    expect(out.taskCounts).toMatchObject({ completed: 1, ready: 1 });
    expect(sink[0]).toMatchObject({ type: "campaigns" });
  });

  it("campaign_status 活动不存在：清洗后错误", async () => {
    const campaignGet = vi.fn(async () => ({ ok: false, error: `Campaign 不存在或已损坏（${testDir}/campaigns/campaign-9.json）` }));
    const { sink, tool } = setup({ campaignGet });

    expectCleanFailure(await run(tool("campaign_status"), { campaign_id: "campaign-9" }));
    expect(sink).toHaveLength(0);
  });
});

describe("灵感收件箱", () => {
  const item = {
    id: "inbox-1", url: "https://example.com/a", source: "telegram", receivedAt: "2026-08-19T10:00:00.000Z",
    status: "failed", attempts: 2, failReason: "抓取超时",
  };

  it("list_inbox 回状态分布并推卡", async () => {
    const inboxList = vi.fn(async () => ({ ok: true, data: { items: [item], counts: { failed: 1 }, total: 1, hidden: 0 } }));
    const { sink, tool } = setup({ inboxList });

    const out = await run(tool("list_inbox"));

    expect(out).toMatchObject({ ok: true, total: 1 });
    expect(out.items[0]).toMatchObject({ id: "inbox-1", status: "failed", what: "https://example.com/a" });
    expect(sink[0].type).toBe("inbox");
  });

  it("list_inbox 失败：清洗后错误", async () => {
    const inboxList = vi.fn(async () => ({ ok: false, error: `台账损坏：${testDir}/inbox/items.json` }));
    const { sink, tool } = setup({ inboxList });

    expectCleanFailure(await run(tool("list_inbox")));
    expect(sink).toHaveLength(0);
  });

  it("retry_inbox：worker 没在跑时照实回 queued:false 与说明", async () => {
    const inboxRetry = vi.fn(async () => ({
      ok: true,
      data: { item: { ...item, status: "pending" }, queued: false, note: "收件箱 worker 没在跑——这条已排回队列" },
    }));
    const { sink, tool } = setup({ inboxRetry });

    const out = await run(tool("retry_inbox"), { item_id: "inbox-1" });

    expect(inboxRetry).toHaveBeenCalledWith(expect.objectContaining({ id: "inbox-1", _dataDir: testDir }));
    expect(out).toMatchObject({ ok: true, id: "inbox-1", queued: false });
    expect(String(out.note)).toContain("worker 没在跑");
    expect(sink[0]).toMatchObject({ type: "inbox", data: { retried: true, queued: false } });
  });

  it("retry_inbox 被拒（处理中/已消化）：清洗后错误", async () => {
    const inboxRetry = vi.fn(async () => ({ ok: false, error: `这条正在处理中（lease 在 ${testDir}/inbox）` }));
    const { sink, tool } = setup({ inboxRetry });

    expectCleanFailure(await run(tool("retry_inbox"), { item_id: "inbox-1" }));
    expect(sink).toHaveLength(0);
  });
});

describe("list_versions", () => {
  it("回版本列表并推卡；引导回滚去编辑器", async () => {
    const listVersionsImpl = vi.fn(async () => [
      { version: 1, title: "初稿", body: "…", note: "首版", savedAt: "2026-08-18T02:00:00.000Z" },
      { version: 2, title: "改口语", body: "…", savedAt: "2026-08-19T02:00:00.000Z" },
    ]);
    const { sink, tool } = setup({ listVersionsImpl });

    const out = await run(tool("list_versions"), { content_id: "content-v-1" });

    expect(listVersionsImpl).toHaveBeenCalledWith("content-v-1", testDir);
    expect(out).toMatchObject({ ok: true, total: 2 });
    expect(out.versions[1]).toMatchObject({ version: 2, title: "改口语" });
    expect(String(out.note)).toContain("编辑器");
    expect(sink[0]).toMatchObject({ type: "versions", data: { contentId: "content-v-1" } });
  });

  it("读版本抛错：清洗后错误，不推卡", async () => {
    const listVersionsImpl = vi.fn(async () => {
      throw new Error(`EACCES: permission denied, open '${testDir}/contents/content-v-2/meta.json'`);
    });
    const { sink, tool } = setup({ listVersionsImpl });

    const out = await run(tool("list_versions"), { content_id: "content-v-2" });

    expectCleanFailure(out);
    expect(String(out.error)).toContain("EACCES");
    expect(sink).toHaveLength(0);
  });
});
