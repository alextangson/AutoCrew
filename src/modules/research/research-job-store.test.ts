import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PERSPECTIVE_NAMES,
  getJob,
  isTerminalJobStatus,
  listJobs,
  pendingPerspectives,
  topicHashOf,
  upsertJob,
  type ResearchJob,
} from "./research-job-store.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-research-store-"));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const job = (over: Partial<ResearchJob> = {}): ResearchJob => ({
  topicId: "topic-1",
  status: "queued",
  startedAt: "2026-07-26T08:00:00.000Z",
  perspectives: pendingPerspectives(),
  topicHash: topicHashOf("标题", "描述"),
  ...over,
});

const jobsFile = () => path.join(dataDir, "research", "jobs.jsonl");

describe("台账读写", () => {
  it("空目录读出空列表，不抛", async () => {
    expect(await listJobs(dataDir)).toEqual([]);
    expect(await getJob("topic-1", dataDir)).toBeNull();
  });

  it("按 topicId latest-wins，历史行保留可追溯", async () => {
    await upsertJob(job({ topicId: "topic-a" }), dataDir);
    await upsertJob(job({ topicId: "topic-a", status: "running", claimedAt: "2026-07-26T08:01:00.000Z" }), dataDir);
    await upsertJob(job({ topicId: "topic-a", status: "succeeded", briefRevision: 1 }), dataDir);

    const latest = await getJob("topic-a", dataDir);
    expect(latest).toMatchObject({ status: "succeeded", briefRevision: 1 });
    expect(latest?.claimedAt).toBeUndefined(); // 落定记录不带 lease
    expect(await listJobs(dataDir)).toHaveLength(1);

    // append-only：三次写 = 三行，失败那轮的原因将来还查得到
    const raw = await fs.readFile(jobsFile(), "utf-8");
    expect(raw.trim().split("\n")).toHaveLength(3);
  });

  it("损坏行被跳过，不清空读视图也不冒充 job", async () => {
    await upsertJob(job({ topicId: "topic-a" }), dataDir);
    await fs.appendFile(jobsFile(), '{"topicId":"topic-b","status":"que\n', "utf-8"); // 崩在写一半
    await fs.appendFile(jobsFile(), '{"status":"queued"}\n', "utf-8"); // 没有主键的半条
    await upsertJob(job({ topicId: "topic-c", startedAt: "2026-07-26T09:00:00.000Z" }), dataDir);

    expect((await listJobs(dataDir)).map((j) => j.topicId)).toEqual(["topic-a", "topic-c"]);
  });

  it("listJobs 按 startedAt 升序（老的在前，启动重排要 FIFO）", async () => {
    await upsertJob(job({ topicId: "topic-new", startedAt: "2026-07-26T10:00:00.000Z" }), dataDir);
    await upsertJob(job({ topicId: "topic-old", startedAt: "2026-07-20T10:00:00.000Z" }), dataDir);

    expect((await listJobs(dataDir)).map((j) => j.topicId)).toEqual(["topic-old", "topic-new"]);
  });
});

describe("topicHashOf（简报过期判定的锚）", () => {
  it("同输入稳定、16 位十六进制", () => {
    const h = topicHashOf("AI 编程助手横评", "对比 5 个主流工具");
    expect(h).toBe(topicHashOf("AI 编程助手横评", "对比 5 个主流工具"));
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("首尾空白不算改动，正文改了才换 hash", () => {
    expect(topicHashOf("  标题 ", "描述\n")).toBe(topicHashOf("标题", "描述"));
    expect(topicHashOf("标题2", "描述")).not.toBe(topicHashOf("标题", "描述"));
    expect(topicHashOf("标题", "描述2")).not.toBe(topicHashOf("标题", "描述"));
  });

  it("标题与描述的边界不会被拼接串位", () => {
    expect(topicHashOf("ab", "")).not.toBe(topicHashOf("a", "b"));
  });
});

describe("常量与判定", () => {
  it("四视角初值全 pending，顺序钉死", () => {
    expect(pendingPerspectives()).toEqual([
      { name: "audience", status: "pending" },
      { name: "evidence", status: "pending" },
      { name: "counter", status: "pending" },
      { name: "benchmark", status: "pending" },
    ]);
    expect(PERSPECTIVE_NAMES).toHaveLength(4);
  });

  it("queued/running 非终态，其余三态终态", () => {
    expect(isTerminalJobStatus("queued")).toBe(false);
    expect(isTerminalJobStatus("running")).toBe(false);
    expect(isTerminalJobStatus("succeeded")).toBe(true);
    expect(isTerminalJobStatus("partial")).toBe(true);
    expect(isTerminalJobStatus("failed")).toBe(true);
  });
});
