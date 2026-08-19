/**
 * 视图上下文的服务端校验（对话控制面设计 §Phase 3 + 一审 P2-6）。
 *
 * 关键不变量：renderer 传来的字段一律当外部输入——白名单外的 route/列丢弃、
 * 查不到的 campaign 丢弃、坏字段不让整轮失败，且丢掉的东西一个字都不许进 prompt。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseViewContext, viewContextLine } from "./chat-view-context.js";
import { runChatTurn } from "./chat-router.js";
import { createCampaign } from "../storage/campaign-store.js";
import { openaiSseResponse, bodyText } from "../engine/sse-fixtures.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-viewctx-"));
  await fs.writeFile(path.join(dir, "engine.json"), JSON.stringify({ apiKey: "test-key", baseUrl: "https://fake.local" }));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const newCampaign = () =>
  createCampaign({ name: "出海冷启动", mode: "managed_growth", brief: { goals: ["拉新"], channels: ["seo"], constraints: [] } }, dir);

describe("parseViewContext 白名单", () => {
  it("合法 route + 看板列全留", async () => {
    const ctx = await parseViewContext({ route: "board", board_column: "review" }, dir);
    expect(ctx).toEqual({ route: "board", boardColumn: "review" });
  });

  it("白名单外的 route 丢弃（含路径串/大小写变体），不留残值", async () => {
    for (const route of ["Board", "../../etc/passwd", "admin", "", 42, null, { view: "board" }]) {
      expect(await parseViewContext({ route }, dir)).toBeUndefined();
    }
  });

  it("白名单外的看板列丢弃，route 照留", async () => {
    const ctx = await parseViewContext({ route: "board", board_column: "trash" }, dir);
    expect(ctx).toEqual({ route: "board" });
  });

  it("看板列脱离看板视图即丢弃（没有看板就没有列这个坐标）", async () => {
    const ctx = await parseViewContext({ route: "dashboard", board_column: "review" }, dir);
    expect(ctx).toEqual({ route: "dashboard" });
  });

  it("context 不是对象 / 全是非法字段 → undefined（等同老前端不传）", async () => {
    expect(await parseViewContext(undefined, dir)).toBeUndefined();
    expect(await parseViewContext("board", dir)).toBeUndefined();
    expect(await parseViewContext(["board"], dir)).toBeUndefined();
    expect(await parseViewContext({ route: "nope", campaign_id: "campaign-ghost", board_column: "review" }, dir)).toBeUndefined();
  });
});

describe("parseViewContext 存在性校验", () => {
  it("存在的活动带上名字（注入行用人话说活动名）", async () => {
    const campaign = await newCampaign();
    const ctx = await parseViewContext({ route: "campaigns", campaign_id: campaign.id }, dir);
    expect(ctx).toEqual({ route: "campaigns", campaignId: campaign.id, campaignName: "出海冷启动" });
  });

  it("查不到的活动 id 丢弃——模型不对着幽灵活动说话", async () => {
    const ctx = await parseViewContext({ route: "campaigns", campaign_id: "campaign-not-there" }, dir);
    expect(ctx).toEqual({ route: "campaigns" });
  });

  it("id 形状非法（路径串）直接丢，不进存储查询", async () => {
    const ctx = await parseViewContext({ route: "campaigns", campaign_id: "../../campaign-1" }, dir);
    expect(ctx).toEqual({ route: "campaigns" });
  });

  it("稿件上下文与修改焦点沿用既有语义（本期不收紧）", async () => {
    const ctx = await parseViewContext(
      { route: "editor", content_id: "content-42", content_title: "AI 写作趋势", platform: "wechat_mp", revision_focus: { scope: "selection", selection: "开头这段" } },
      dir,
    );
    expect(ctx).toMatchObject({
      route: "editor",
      contentId: "content-42",
      contentTitle: "AI 写作趋势",
      platform: "wechat_mp",
      revisionFocus: { scope: "selection", selection: "开头这段" },
    });
  });

  it("非法 content_id 丢弃，同轮其它合法字段照留", async () => {
    const ctx = await parseViewContext({ route: "board", content_id: "../secrets" }, dir);
    expect(ctx).toEqual({ route: "board" });
  });
});

describe("viewContextLine 注入行", () => {
  it("看板 + 列（golden）", () => {
    expect(viewContextLine({ route: "board", boardColumn: "review" })).toBe(
      "用户当前在工作区的「内容看板」页面的「待审」列——「这里」「这一列」「这个活动」等指代默认指它。",
    );
  });

  it("增长活动 + 选中活动（golden）", () => {
    expect(viewContextLine({ route: "campaigns", campaignId: "campaign-7", campaignName: "出海冷启动" })).toBe(
      "用户当前在工作区的「增长活动」页面，选中活动《出海冷启动》（id: campaign-7）——「这里」「这一列」「这个活动」等指代默认指它。",
    );
  });

  it("编辑器 + 有稿件时不重复报位置（稿件那句已经说清了）", () => {
    expect(viewContextLine({ route: "editor", contentId: "content-1" })).toBe("");
    expect(viewContextLine({ route: "editor" })).toContain("稿件编辑器");
  });

  it("无 route（老前端）不注入", () => {
    expect(viewContextLine(undefined)).toBe("");
    expect(viewContextLine({ contentId: "content-1" })).toBe("");
  });
});

describe("注入到本轮 userMessage", () => {
  it("位置行进模型消息；非法字段一个字都不进", async () => {
    const campaign = await newCampaign();
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(bodyText(init as { body?: unknown })) as Record<string, unknown>);
      return openaiSseResponse({ choices: [{ message: { role: "assistant", content: "好的" }, finish_reason: "stop" }], usage: { total_tokens: 5 } });
    }) as typeof fetch;

    const viewContext = await parseViewContext(
      { route: "campaigns", campaign_id: campaign.id, board_column: "review" },
      dir,
    );
    const res = await runChatTurn({ message: "这个活动跑得怎么样", dataDir: dir, viewContext, fetchImpl });

    expect(res.ok).toBe(true);
    const messages = calls[0].messages as Array<{ role: string; content: string }>;
    const lastUser = messages[messages.length - 1].content;
    expect(lastUser).toContain("【当前上下文】");
    expect(lastUser).toContain("「增长活动」页面");
    expect(lastUser).toContain("出海冷启动");
    expect(lastUser).toContain("这个活动跑得怎么样");
    expect(lastUser).not.toContain("待审"); // 非看板视图的列已被丢弃
  });
});
