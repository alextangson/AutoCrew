import { describe, expect, it } from "vitest";
import { tryWithFileOwnership, withFileOwnership } from "./file-ownership.js";

/** 占住归属锁直到 release()：模拟 NAS 每周完整核对那种长持有 */
function holdLock() {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const done = withFileOwnership(() => held);
  return { release, done };
}

describe("tryWithFileOwnership：读路径限时排队", () => {
  it("锁空闲：直接跑，带回结果", async () => {
    expect(await tryWithFileOwnership(async () => 7, 50)).toEqual({ ran: true, value: 7 });
  });

  it("锁被长任务占着：到点就回 busy，之后锁放了 fn 也不会再跑", async () => {
    const holder = holdLock();
    let calls = 0;
    const started = Date.now();
    const r = await tryWithFileOwnership(async () => { calls++; }, 50);
    expect(r).toEqual({ ran: false, busy: true });
    expect(Date.now() - started).toBeLessThan(1000);
    holder.release();
    await holder.done;
    await withFileOwnership(async () => undefined); // 等队列里排在后面的都过完
    expect(calls).toBe(0);
  });

  it("等待期内锁放了：照常拿锁跑", async () => {
    const holder = holdLock();
    setTimeout(holder.release, 10);
    expect(await tryWithFileOwnership(async () => "ok", 1000)).toEqual({ ran: true, value: "ok" });
  });

  it("已经拿到锁在跑的不半途丢下：超时后仍等它跑完", async () => {
    const r = await tryWithFileOwnership(() => new Promise((res) => setTimeout(() => res("slow"), 60)), 10);
    expect(r).toEqual({ ran: true, value: "slow" });
  });

  it("持锁的调用链内可重入，不自己等自己", async () => {
    const r = await withFileOwnership(() => tryWithFileOwnership(async () => 1, 10));
    expect(r).toEqual({ ran: true, value: 1 });
  });
});
