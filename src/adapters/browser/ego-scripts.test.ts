/**
 * ego-scripts.test.ts — 生成的 ego 脚本真跑一遍（假 taskSpace，不碰 ego lite）。
 * 锁三件事：结果行格式、异常路径也 finish({ keep: [] })、抖音旁听只收列表响应。
 */
import { describe, it, expect } from "vitest";
import { EGO_RESULT_MARKER, evalScript, fetchScript, interceptScript, openScript } from "./ego-scripts.js";
import { LIST_URL_PATTERNS } from "./douyin-stats.js";

type Fn = (...args: unknown[]) => unknown;

interface FakePage {
  goto?: Fn;
  evaluate?: Fn;
  fetch?: Fn;
  cdp?: Fn;
  events?: Fn;
}

/** 在假 ego 运行时里执行脚本，收集结果行与 finish 调用 */
async function execScript(script: string, page: FakePage, opts: { connectThrows?: boolean } = {}) {
  const lines: string[] = [];
  const finishes: unknown[] = [];
  const task = {
    spaceId: 42,
    page: () => page,
    finish: async (arg: unknown) => {
      finishes.push(arg);
      return {};
    },
  };
  const taskSpace = async () => {
    if (opts.connectThrows) throw new Error("connect ECONNREFUSED");
    return task;
  };
  const fakeConsole = { log: (s: string) => lines.push(String(s)) };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => Fn;
  await new AsyncFunction("taskSpace", "console", "Buffer", script)(taskSpace, fakeConsole, Buffer);
  const results = lines.filter((l) => l.startsWith(EGO_RESULT_MARKER)).map((l) => JSON.parse(l.slice(EGO_RESULT_MARKER.length)));
  return { results, finishes };
}

describe("openScript", () => {
  it("导航成功 → ok + spaceId，不关 TaskSpace（后续步骤还要用）", async () => {
    const { results, finishes } = await execScript(openScript({ space: "n", url: "https://x.test", timeoutMs: 100 }), {
      goto: async () => ({}),
    });
    expect(results).toEqual([{ ok: true, spaceId: 42 }]);
    expect(finishes).toHaveLength(0);
  });

  it("导航抛错 → 当场 finish({ keep: [] }) 再报错（异常路径也关）", async () => {
    const { results, finishes } = await execScript(openScript({ space: "n", url: "https://x.test", timeoutMs: 100 }), {
      goto: async () => {
        throw new Error("net::ERR_TIMED_OUT");
      },
    });
    expect(finishes).toEqual([{ keep: [] }]);
    expect(results).toMatchObject([{ ok: false, stage: "op", error: expect.stringContaining("ERR_TIMED_OUT") }]);
  });

  it("连不上 ego lite → stage connect（调用方判浏览器未连接）", async () => {
    const { results } = await execScript(openScript({ space: "n", url: "https://x.test", timeoutMs: 100 }), {}, { connectThrows: true });
    expect(results).toMatchObject([{ ok: false, stage: "connect" }]);
  });
});

describe("eval / fetch 单步", () => {
  it("eval 失败只报错不关（由会话收尾统一 finish）", async () => {
    const { results, finishes } = await execScript(evalScript({ space: 42, expression: "location.href" }), {
      evaluate: async () => {
        throw new Error("Execution context was destroyed");
      },
    });
    expect(finishes).toHaveLength(0);
    expect(results).toMatchObject([{ ok: false, stage: "op" }]);
  });

  it("fetch 把 page.fetch 的结构化响应换成 PageFetchResponse 形状，并带上 credentials:include", async () => {
    let seen: unknown;
    const { results } = await execScript(
      fetchScript({ space: 42, url: "https://x.test/a", init: { method: "POST", headers: { a: "1" }, body: "{}", timeout: 100 } }),
      {
        fetch: async (_url: unknown, init: unknown) => {
          seen = init;
          return { ok: true, status: 200, url: "https://x.test/a?x", headers: { "content-type": "application/json" }, body: '{"ok":1}' };
        },
      },
    );
    expect(seen).toMatchObject({ method: "POST", headers: { a: "1" }, body: "{}", credentials: "include" });
    expect(results[0]).toMatchObject({
      ok: true,
      response: { httpStatus: 200, finalUrl: "https://x.test/a?x", contentType: "application/json", bodyText: '{"ok":1}' },
    });
  });
});

describe("interceptScript（抖音旁听）", () => {
  const base = { space: "n", url: "https://creator.douyin.com/m", patterns: LIST_URL_PATTERNS, waitMs: 50, settleMs: 0 };
  const respEvent = (requestId: string, url: string) => ({ method: "Network.responseReceived", params: { requestId, response: { url } } });

  it("只收列表响应体，收完 finish({ keep: [] })", async () => {
    let navigated = false;
    let drained = false;
    const page: FakePage = {
      cdp: async (method: unknown, params: unknown) => {
        if (method === "Network.getResponseBody") {
          const id = (params as { requestId: string }).requestId;
          return id === "r1" ? { body: "LIST", base64Encoded: false } : { body: "OTHER", base64Encoded: false };
        }
        return {};
      },
      goto: async () => {
        navigated = true;
        return {};
      },
      // 导航前的旧事件会被清掉；导航后才有列表响应
      events: async () => {
        if (!navigated || drained) return [];
        drained = true;
        return [respEvent("r1", "https://creator.douyin.com/web/api/creator/item/list?x"), respEvent("r2", "https://creator.douyin.com/other")];
      },
    };
    const { results, finishes } = await execScript(interceptScript(base), page);
    expect(results[0]).toMatchObject({ ok: true, matched: 1, bodies: ["LIST"], domText: null });
    expect(finishes).toEqual([{ keep: [] }]);
  });

  it("什么都没拦到 → 交回页面文本给登录判定，也 finish", async () => {
    const page: FakePage = {
      cdp: async () => ({}),
      goto: async () => ({}),
      events: async () => [],
      evaluate: async () => "扫码登录",
    };
    const { results, finishes } = await execScript(interceptScript(base), page);
    expect(results[0]).toMatchObject({ ok: true, matched: 0, bodies: [], domText: "扫码登录" });
    expect(finishes).toEqual([{ keep: [] }]);
  });

  it("中途抛错 → 报错且只 finish 一次", async () => {
    const page: FakePage = {
      cdp: async () => {
        throw new Error("Network.enable failed");
      },
    };
    const { results, finishes } = await execScript(interceptScript(base), page);
    expect(results).toMatchObject([{ ok: false, stage: "op" }]);
    expect(finishes).toEqual([{ keep: [] }]);
  });
});
