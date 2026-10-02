// @vitest-environment happy-dom
/** 第 12 轮 P2：更新慢的时候页面一直等，不叫人重启；连不上很久只标「卡住」，照样接着等。 */
import { describe, expect, it, vi } from "vitest";
vi.mock("../../transport", () => ({ authedFetch: async () => new Response("{}"), SESSION_EXPIRED: "x" }));
import { waitBack, type UpdateView, type WaitState } from "./update-api";

const running = { ok: true as const, data: { running: true } as UpdateView };
const done = { ok: true as const, data: { running: false } as UpdateView };
const down = { ok: false as const, error: "连不上 AutoCrew 服务" };

describe("waitBack", () => {
  it("服务连得上、一直在更新（远超 5 分钟）：一直等，直到更新完才返回", async () => {
    let t = 0, n = 0;
    const states: WaitState[] = [];
    const r = await waitBack({ intervalMs: 0, sleep: async () => { t += 60_000; }, now: () => t,
      load: async () => (++n < 30 ? running : done), onState: (s) => states.push(s) });
    expect(r).toBe(true);
    expect(n).toBe(30); // 30 分钟后才更新完，也等到了
    expect(states.every((s) => s === "updating")).toBe(true);
  });

  it("连不上超过 5 分钟：标成卡住，但接着轮询，回来就算完", async () => {
    let t = 0, n = 0;
    const states: WaitState[] = [];
    const r = await waitBack({ intervalMs: 0, sleep: async () => { t += 60_000; }, now: () => t,
      load: async () => (++n < 10 ? down : done), onState: (s) => states.push(s) });
    expect(r).toBe(true);
    expect(states).toContain("stalled");
  });
});
