/**
 * P6 §3.7 研究台的三处静默行为改成明说：要求改了回 task_changed、持有者闲置 30 分钟可接管、
 * 同选题并发读页不再被租约拒掉也不丢配额（锁内预扣 → 锁外抓取 → 锁内合并）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeScout, type ScoutDeps } from "./scout.js";
import { TASK_IDLE_MS } from "./scout-task-guard.js";
import { MAX_PAGE_READS_IN_FLIGHT } from "./scout-read-page.js";
import { inspectHostResearchTask } from "../modules/research/host-research-store.js";
import { EMPTY_OWN_MATERIAL } from "../modules/research/own-material.js";
import { getJob } from "../modules/research/research-job-store.js";
import { saveTopic } from "../storage/local-store.js";

let dir: string;
let topicId: string;
let deps: ScoutDeps;
const URL = "https://example.com/report";
const QUOTE = "邻居们每周共同浇水，轮班时间写在公告板上。";
const REQUIREMENTS = "公众号，写给园艺新手；按清晨浇水的经历自然展开。";
const run = (action: string, args: Record<string, unknown> = {}, host = "claude") =>
  executeScout({ action, topic_id: topicId, ...args, _dataDir: dir, _host: host }, deps);
const perspective = {
  insights: [
    { text: "新手需要知道怎样参与", source_ids: ["p1"] },
    { text: "共同劳动提供了真实的交流场景", source_ids: ["p1"] },
    { text: "轮班是把想法落实为行动的方式", source_ids: ["p1"] },
  ],
  evidence: [{ claim: "邻居有轮班安排", quote: QUOTE, source_id: "p1" }],
  asset_picks: [],
  gaps: ["没有长期参与数据"],
};
const page = (url: string) => ({ finalUrl: url, text: `${QUOTE}\n其他记录。`, title: "种植记录", imageCandidates: [] });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-scout-task-"));
  topicId = (await saveTopic({ title: "菜园的清晨", description: "记录社区共同照顾菜苗的经历", tags: [] }, dir)).id;
  deps = {
    collectOwnMaterialImpl: vi.fn(async () => structuredClone(EMPTY_OWN_MATERIAL)),
    brokerDeps: { fetchImpl: vi.fn(async (url: string) => page(url)) },
  };
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function prepare(host = "claude") {
  const r = await run("prepare", { platform: "wechat_mp", requirements: REQUIREMENTS }, host);
  expect(r).toMatchObject({ ok: true });
  return r.task_id as string;
}

/** 把任务的最后活动时间拨回去（save 会把 updatedAt 盖成现在，只能直接改盘上快照） */
async function idleFor(taskId: string, ms: number) {
  const file = path.join(dir, "research", "host-tasks", topicId, `${taskId}.json`);
  const task = JSON.parse(await fs.readFile(file, "utf8"));
  task.updatedAt = new Date(Date.now() - ms).toISOString();
  await fs.writeFile(file, JSON.stringify(task));
}

describe("requirements 改字：task_changed 需确认", () => {
  it("回差异、保留已交视角；照 keep_current 继续原任务，照 next_action 确认才新建且可重放", async () => {
    const taskId = await prepare();
    await run("read_page", { task_id: taskId, perspective: "audience", url: URL });
    expect(await run("perspective", { task_id: taskId, perspective: "audience", payload: perspective })).toMatchObject({ ok: true });
    const changed = await run("prepare", { platform: "wechat_mp", requirements: "改成抖音口播，写给退休居民" });
    expect(changed).toMatchObject({
      ok: false, code: "task_changed", current_task_id: taskId, submitted_perspectives: ["audience"],
      diff: { requirements: { before: REQUIREMENTS, after: "改成抖音口播，写给退休居民" } },
      next_action: { tool: "autocrew_scout", params: { action: "prepare", confirm_task_change: true, requirements: "改成抖音口播，写给退休居民" } },
    });
    expect(changed.diff).not.toHaveProperty("platform");
    expect(await inspectHostResearchTask(topicId, dir)).toMatchObject({ taskId, perspectives: { audience: expect.any(Object) } });
    const next = changed.next_action as { tool: string; params: Record<string, unknown> };
    expect(await run("pack", (changed.keep_current as { params: Record<string, unknown> }).params)).toMatchObject({ ok: true, task_id: taskId });
    const confirmed = await run("prepare", next.params);
    expect(confirmed).toMatchObject({ ok: true, creative_task: { requirements: "改成抖音口播，写给退休居民" } });
    expect(confirmed.task_id).not.toBe(taskId);
    expect((await run("prepare", next.params)).task_id).toBe(confirmed.task_id);
  });
});

describe("task_owned 30 分钟过期", () => {
  it("活跃持有者挡住别的宿主；闲置满 30 分钟可接管并保留已交视角，旧持有者迟到写入回 lease_lost", async () => {
    const taskId = await prepare();
    await run("read_page", { task_id: taskId, perspective: "audience", url: URL });
    await run("perspective", { task_id: taskId, perspective: "audience", payload: perspective });
    expect(await run("prepare", {}, "codex")).toMatchObject({ ok: false, code: "task_owned", holder: "claude", idle_expires_at: expect.any(String) });
    expect(await run("claim_offline", { task_id: taskId, claim: "回忆", reason: "无原页" }, "codex")).toMatchObject({ code: "task_owned" });

    await idleFor(taskId, TASK_IDLE_MS + 1000);
    const taken = await run("prepare", {}, "codex");
    expect(taken).toMatchObject({ ok: true, task_id: taskId, executedBy: { host: "codex" }, perspectives: expect.arrayContaining([{ name: "audience", status: "submitted" }]) });
    expect(await inspectHostResearchTask(topicId, dir)).toMatchObject({ host: "codex", takeovers: [{ from: "claude", to: "codex" }] });
    expect(await getJob(topicId, dir)).toMatchObject({ executedBy: { kind: "host", host: "codex" } });
    expect(await run("claim_offline", { task_id: taskId, claim: "回忆", reason: "无原页" }, "claude")).toMatchObject({ ok: false, code: "lease_lost", holder: "codex" });
    expect(await run("claim_offline", { task_id: taskId, claim: "回忆", reason: "无原页" }, "codex")).toMatchObject({ ok: true });
  });
});

describe("read_page 并发不丢配额", () => {
  function gatedFetch() {
    let open = () => {};
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const impl = vi.fn(async (url: string) => { await gate; return page(url); });
    return { impl, release: () => open() };
  }

  it(`同选题 ${MAX_PAGE_READS_IN_FLIGHT} 个并发读页全部成功、额度计数正好 ${MAX_PAGE_READS_IN_FLIGHT}；第 ${MAX_PAGE_READS_IN_FLIGHT + 1} 个回 task_busy 且不扣额`, async () => {
    const taskId = await prepare();
    const fetch = gatedFetch();
    deps.brokerDeps = { fetchImpl: fetch.impl };
    const reads = Array.from({ length: MAX_PAGE_READS_IN_FLIGHT }, (_, i) =>
      run("read_page", { task_id: taskId, perspective: "evidence", url: `${URL}/${i}` }));
    await vi.waitFor(() => expect(fetch.impl).toHaveBeenCalledTimes(MAX_PAGE_READS_IN_FLIGHT));
    // 出网前额度已经落盘：四格都扣在同一份快照上，谁也没盖掉谁
    expect((await inspectHostResearchTask(topicId, dir))?.broker.jobReadPage).toBe(MAX_PAGE_READS_IN_FLIGHT);
    expect(await run("read_page", { task_id: taskId, perspective: "evidence", url: `${URL}/extra` })).toMatchObject({ ok: false, code: "task_busy", retry_after_seconds: expect.any(Number) });
    expect(await run("read_page", { task_id: taskId, perspective: "evidence", url: `${URL}/0` })).toMatchObject({ ok: false, code: "task_busy" });
    fetch.release();
    const results = await Promise.all(reads);
    expect(results.map((r) => ({ ok: r.ok, cached: r.cached, code: r.code, error: r.error }))).toEqual(results.map(() => ({ ok: true, cached: false, code: undefined, error: undefined })));
    expect(new Set(results.map((r) => r.source_id)).size).toBe(MAX_PAGE_READS_IN_FLIGHT);
    const task = (await inspectHostResearchTask(topicId, dir))!;
    expect(task.broker.jobReadPage).toBe(MAX_PAGE_READS_IN_FLIGHT);
    expect(task.broker.sources).toHaveLength(MAX_PAGE_READS_IN_FLIGHT);
    expect(task.pageReads).toEqual([]);
    expect(await run("read_page", { task_id: taskId, perspective: "evidence", url: `${URL}/0` })).toMatchObject({ ok: true, cached: true });
    expect(fetch.impl).toHaveBeenCalledTimes(MAX_PAGE_READS_IN_FLIGHT);
  });

  it("抓取期间任务换代：结果丢弃并回 stale_task，不并进新任务", async () => {
    const taskId = await prepare();
    const fetch = gatedFetch();
    deps.brokerDeps = { fetchImpl: fetch.impl };
    const read = run("read_page", { task_id: taskId, perspective: "evidence", url: URL });
    await vi.waitFor(() => expect(fetch.impl).toHaveBeenCalledTimes(1));
    const fresh = await run("prepare", { platform: "wechat_mp", requirements: REQUIREMENTS, force: true });
    fetch.release();
    expect(await read).toMatchObject({ ok: false, code: "stale_task" });
    const task = (await inspectHostResearchTask(topicId, dir))!;
    expect(task.taskId).toBe(fresh.task_id);
    expect(task.broker.sources).toEqual([]);
    expect(task.broker.jobReadPage).toBe(0);
  });
});
