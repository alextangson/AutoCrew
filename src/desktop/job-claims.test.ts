/**
 * job-claims 测试（设计 §Phase 2 / codex #16）：claim 必须在同一同步 tick 内
 * check-and-register，且持有到任务 settle。
 */
import { describe, it, expect } from "vitest";
import { claimJob, releaseJob, isJobClaimed, holdJobUntilSettled } from "./job-claims.js";

describe("job-claims", () => {
  it("同步 tick 内并发双 claim 只成一个", () => {
    const key = "cover:content-sync-1";
    const results = [claimJob(key), claimJob(key)];
    expect(results).toEqual([true, false]);
    expect(isJobClaimed(key)).toBe(true);
    releaseJob(key);
  });

  it("不同 key 互不阻塞（封面与配图各自命名空间）", () => {
    expect(claimJob("cover:content-ns")).toBe(true);
    expect(claimJob("article_images:content-ns")).toBe(true);
    releaseJob("cover:content-ns");
    releaseJob("article_images:content-ns");
  });

  it("任务成功 settle 后释放，可以再 claim", async () => {
    const key = "cover:content-ok";
    expect(claimJob(key)).toBe(true);
    let done!: () => void;
    const task = new Promise<void>((resolve) => (done = resolve));
    holdJobUntilSettled(key, task);
    expect(claimJob(key)).toBe(false); // 任务跑着的时候别人抢不到

    done();
    await task;
    await Promise.resolve(); // 让 release 的 microtask 落地
    expect(isJobClaimed(key)).toBe(false);
    expect(claimJob(key)).toBe(true);
    releaseJob(key);
  });

  it("任务 reject 后同样释放（失败不许把位置永久占死）", async () => {
    const key = "cover:content-reject";
    expect(claimJob(key)).toBe(true);
    const task = Promise.reject(new Error("生图服务挂了"));
    holdJobUntilSettled(key, task);
    await task.catch(() => {});
    await Promise.resolve();
    expect(isJobClaimed(key)).toBe(false);
    expect(claimJob(key)).toBe(true);
    releaseJob(key);
  });

  it("投递路径同步抛异常时，调用方 finally 释放", () => {
    const key = "cover:content-throw";
    expect(() => {
      if (!claimJob(key)) throw new Error("unreachable");
      try {
        throw new Error("投递就崩了");
      } finally {
        releaseJob(key);
      }
    }).toThrow("投递就崩了");
    expect(isJobClaimed(key)).toBe(false);
    expect(claimJob(key)).toBe(true);
    releaseJob(key);
  });
});
