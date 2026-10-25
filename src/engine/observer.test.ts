import { afterAll, describe, expect, it } from "vitest";
import { registerExchange, shutdownObserver } from "./observer.js";

afterAll(() => shutdownObserver());

describe("observer relay", () => {
  // 2026-10-25：DeepSeek 开始对 SSE 回 gzip。上游 fetch 已解压，转发时若留着 content-encoding，
  // SDK 会对明文再解一次 → Z_DATA_ERROR → 「terminated」，所有模型调用 0.3 秒内全挂。
  it("drops content-encoding because the upstream fetch already decoded the body", async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n';
    const fetchImpl = (async () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream", "content-encoding": "gzip" } })) as typeof fetch;
    const ex = await registerExchange({ upstreamBase: "https://upstream.invalid", fetchImpl, idleMs: 5000 });
    try {
      const res = await fetch(`${ex.baseUrl}/chat/completions`, { method: "POST", body: "{}" });
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(await res.text()).toBe(sse);
    } finally {
      ex.release();
    }
  });
});
