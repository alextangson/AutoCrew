/**
 * Spike 用 fake Anthropic 中转：anthropic-messages SSE 形状。
 * mode: "normal" 完整流 | "stall" 发 2 个 delta 后挂住不动（测看门狗）
 * 记录每个请求的 headers/body 供断言（A2 key 字面量检查）。
 */
import http from "node:http";

export interface FakeRelay {
  url: string;
  received: Array<{ headers: http.IncomingHttpHeaders; body: string }>;
  close: () => Promise<void>;
}

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function startFakeRelay(mode: "normal" | "stall", opts?: { deltaMs?: number; deltas?: number }): Promise<FakeRelay> {
  const received: FakeRelay["received"] = [];
  const deltaMs = opts?.deltaMs ?? 20;
  const deltaCount = opts?.deltas ?? 4;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, "message_start", {
        type: "message_start",
        message: { id: "msg_fake", type: "message", role: "assistant", content: [], model: "fake", usage: { input_tokens: 10, output_tokens: 0 } },
      });
      sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });

      let sent = 0;
      const timer = setInterval(() => {
        sent++;
        sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `块${sent} ` } });
        const stallNow = mode === "stall" && sent >= 2;
        if (stallNow) {
          clearInterval(timer); // 不发 stop、不 end —— 连接静默挂住
          return;
        }
        if (sent >= deltaCount) {
          clearInterval(timer);
          sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
          sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } });
          sse(res, "message_stop", { type: "message_stop" });
          res.end();
        }
      }, deltaMs);
      res.on("close", () => clearInterval(timer));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        received,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
