/**
 * recent-actions 测试（设计 §Phase 2）：有界环 20 条、窗口/条数过滤、
 * 写失败不抛，以及 runChatTurn 把动作块注进本轮模型上下文（有/无动作两态）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { appendAction, readRecentActions, recentActionsBlock, type RecentAction } from "./recent-actions.js";
import { runChatTurn } from "./chat-router.js";
import { buildIpcHandlers } from "./ipc.js";
import { executeContentSave } from "../tools/content-save.js";
import { openaiSseResponse, bodyText } from "../engine/sse-fixtures.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-actions-"));
});

afterEach(async () => {
  await fs.chmod(dir, 0o700).catch(() => {});
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  vi.restoreAllMocks();
});

const ringFile = () => path.join(dir, "recent-actions.json");

describe("recent-actions 有界环", () => {
  it("最多留 20 条，覆盖写（老的被挤掉，新的在后）", async () => {
    for (let i = 0; i < 25; i++) {
      await appendAction(dir, { kind: "transition", contentId: `content-${i}`, at: new Date().toISOString() });
    }
    const ring = JSON.parse(await fs.readFile(ringFile(), "utf-8")) as RecentAction[];
    expect(ring).toHaveLength(20);
    expect(ring[0].contentId).toBe("content-5");
    expect(ring[19].contentId).toBe("content-24");
  });

  it("按时间窗口与条数过滤：只回 30 分钟内的最近 5 条", async () => {
    const now = Date.now();
    const stamp = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    for (const [i, m] of [90, 45, 25, 20, 15, 10, 5, 1].entries()) {
      await appendAction(dir, { kind: "transition", contentId: `content-${i}`, at: stamp(m) });
    }
    const recent = await readRecentActions(dir, { now });
    expect(recent).toHaveLength(5);
    expect(recent.map((a) => a.contentId)).toEqual(["content-3", "content-4", "content-5", "content-6", "content-7"]);
  });

  it("窗口内没有动作时回空数组", async () => {
    const now = Date.now();
    await appendAction(dir, { kind: "published", contentId: "content-old", at: new Date(now - 3 * 3600_000).toISOString() });
    expect(await readRecentActions(dir, { now })).toEqual([]);
  });

  it("环文件缺失/损坏都当空环，不抛", async () => {
    expect(await readRecentActions(dir)).toEqual([]);
    await fs.writeFile(ringFile(), "{ 这不是 JSON", "utf-8");
    expect(await readRecentActions(dir)).toEqual([]);
  });

  it("写失败不抛也不影响调用方（只读目录）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await fs.chmod(dir, 0o500);
    await expect(appendAction(dir, { kind: "transition", contentId: "content-x" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("recentActionsBlock：无动作回空串，有动作带标题且封顶", () => {
    expect(recentActionsBlock([])).toBe("");
    const long: RecentAction[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "transition",
      contentId: `content-${i}`,
      title: "很长的稿件标题".repeat(10),
      at: new Date().toISOString(),
    }));
    const block = recentActionsBlock(long);
    expect(block).toContain("【最近工作区动作】");
    expect(block.length).toBeLessThanOrEqual(300);
  });
});

describe("工作区挂接点", () => {
  /** 等 fire-and-forget 的那次写落盘（上限 2s，超时就照实返回当前值让断言报错） */
  const settledRing = async () => {
    for (let i = 0; i < 100; i++) {
      const ring = await readRecentActions(dir);
      if (ring.length > 0) return ring;
      await new Promise((r) => setTimeout(r, 20));
    }
    return readRecentActions(dir);
  };

  it("content:transition 成功后进环（带标题与目标列），失败的流转不进环", async () => {
    const saved = (await executeContentSave({
      action: "save", title: "AI 写作趋势", body: "正文", platform: "wechat_mp", status: "draft_ready", _dataDir: dir,
    })) as { content: { id: string } };
    const transition = buildIpcHandlers()["content:transition"];

    const ok = await transition({ id: saved.content.id, target_status: "reviewing", _dataDir: dir });
    expect(ok.ok).toBe(true);
    // 非法边（reviewing → published）被状态机拒绝——观测环里不许留下没发生过的事
    const rejected = await transition({ id: saved.content.id, target_status: "published", _dataDir: dir });
    expect(rejected.ok).toBe(false);

    // 观测层是 fire-and-forget（withActionRecord 里 void appendAction——记录不许拖慢动作），
    // 所以这里必须等那一次写落盘，不能读一次就断言：读到空只说明写还在路上。
    // 「失败的流转不进环」这一半不受影响：res.ok !== true 时 withActionRecord 直接返回，
    // 压根不会调 appendAction，环的长度永远到不了 2。
    const ring = await settledRing();
    expect(ring).toHaveLength(1);
    expect(ring[0]).toMatchObject({ kind: "transition", contentId: saved.content.id, title: "AI 写作趋势", detail: "reviewing" });
  });
});

describe("runChatTurn 注入最近工作区动作", () => {
  const capture = () => {
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(bodyText(init as { body?: unknown })) as Record<string, unknown>);
      return openaiSseResponse({
        choices: [{ message: { role: "assistant", content: "好的" }, finish_reason: "stop" }],
        usage: { total_tokens: 5 },
      } as Parameters<typeof openaiSseResponse>[0]);
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  beforeEach(async () => {
    await fs.writeFile(path.join(dir, "engine.json"), JSON.stringify({ apiKey: "test-key", baseUrl: "https://fake.local" }));
  });

  it("有动作时本轮 userMessage 带动作块（只进模型，不进持久历史）", async () => {
    await appendAction(dir, { kind: "transition", contentId: "content-1", title: "AI 写作趋势", detail: "reviewing" });
    const { calls, fetchImpl } = capture();

    const res = await runChatTurn({ message: "接下来干嘛", dataDir: dir, fetchImpl, skillsDir: dir });

    expect(res.ok).toBe(true);
    const messages = calls[0].messages as Array<{ role: string; content: string }>;
    const lastUser = messages[messages.length - 1];
    expect(lastUser.content).toContain("【最近工作区动作】");
    expect(lastUser.content).toContain("AI 写作趋势");
    expect(lastUser.content).toContain("接下来干嘛");
  });

  it("无动作时不注入动作块（对话与今天完全一致）", async () => {
    const { calls, fetchImpl } = capture();

    await runChatTurn({ message: "接下来干嘛", dataDir: dir, fetchImpl, skillsDir: dir });

    const messages = calls[0].messages as Array<{ role: string; content: string }>;
    const lastUser = messages[messages.length - 1];
    expect(lastUser.content).not.toContain("【最近工作区动作】");
    expect(lastUser.content).toBe("接下来干嘛");
  });
});
