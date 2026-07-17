/**
 * A4：真实 newcli 中转冒烟 —— SDK → 观察器 → https://code.newcli.com/claude/ultra。
 * 验证：anthropic-messages + 路径前缀 baseUrl + per-call key + 流式 usage +
 * onPayload/onResponse 触发 + 观察器看到双向字节。fastModel + 小 maxTokens，成本忽略不计。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { startObserver } from "./observer.mts";

const cfg = JSON.parse(await fs.readFile(path.join(os.homedir(), ".autocrew/engine.json"), "utf8")) as {
  apiKey: string;
  baseUrl: string;
  fastModel: string;
};

const obs = await startObserver({ upstreamBase: cfg.baseUrl, idleMs: 45_000 });

const model = {
  id: cfg.fastModel,
  name: cfg.fastModel,
  api: "anthropic-messages" as const,
  provider: "anthropic",
  baseUrl: obs.baseUrlFor("real"),
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 16_000,
};

let payloadSeen = false;
let responseStatus = 0;
let text = "";
let final: Record<string, unknown> | undefined;
let errored = "";

const s = stream(
  model as Parameters<typeof stream>[0],
  {
    systemPrompt: "你是连通性测试助手。",
    messages: [{ role: "user", content: "只回复两个字：确认", timestamp: Date.now() }],
  } as Parameters<typeof stream>[1],
  {
    apiKey: cfg.apiKey,
    maxTokens: 32,
    maxRetries: 0,
    onPayload: (p: unknown) => {
      payloadSeen = true;
      return undefined;
    },
    onResponse: (r: { status: number }) => {
      responseStatus = r.status;
    },
  } as Parameters<typeof stream>[2],
);

try {
  for await (const ev of s as AsyncIterable<{ type: string; delta?: string; message?: Record<string, unknown> }>) {
    if (ev.type === "text_delta" && typeof ev.delta === "string") text += ev.delta;
    if (ev.type === "done") final = ev.message;
    if (ev.type === "error") errored = JSON.stringify(ev.message).slice(0, 300);
  }
} catch (e) {
  errored = String(e).slice(0, 300);
}

const bytes = obs.events.filter((e) => e.kind === "bytes").reduce((n, e) => n + (e.bytes ?? 0), 0);
const usage = (final?.usage ?? {}) as Record<string, unknown>;
await obs.close();

console.log("A4 text:", JSON.stringify(text));
console.log("A4 stopReason:", final?.stopReason, "| usage:", JSON.stringify(usage).slice(0, 200));
console.log("A4 payloadSeen:", payloadSeen, "| responseStatus:", responseStatus, "| observerBytes:", bytes);
if (errored) console.log("A4 ERROR:", errored);

const pass = !errored && text.length > 0 && payloadSeen && responseStatus === 200 && bytes > 0 && usage && Object.keys(usage).length > 0;
console.log(pass ? "A4 PASS" : "A4 FAIL");
process.exit(pass ? 0 : 1);
