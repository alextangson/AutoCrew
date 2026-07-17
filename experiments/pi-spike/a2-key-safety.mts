/**
 * A2：apiKey 内存注入安全 —— `!`、`$` 开头的字面 key 原样进请求头，不被求值。
 */
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { startFakeRelay } from "./fake-relay.mts";

const DANGEROUS_KEYS = ["!echo hacked", "$HOME-literal", "sk-plain-normal"];

function makeModel(baseUrl: string) {
  return {
    id: "fake-model",
    name: "Fake",
    api: "anthropic-messages" as const,
    provider: "anthropic",
    baseUrl,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 16000,
  };
}

let failures = 0;
for (const key of DANGEROUS_KEYS) {
  const relay = await startFakeRelay("normal");
  const s = stream(
    makeModel(relay.url) as Parameters<typeof stream>[0],
    { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as Parameters<typeof stream>[1],
    { apiKey: key, maxRetries: 0 } as Parameters<typeof stream>[2],
  );
  for await (const _ev of s as AsyncIterable<unknown>) {
    // 消费到底
  }
  const got = relay.received[0]?.headers["x-api-key"];
  const pass = got === key;
  if (!pass) failures++;
  console.log(`A2 key=${JSON.stringify(key)} → header=${JSON.stringify(got)} ${pass ? "PASS" : "FAIL"}`);
  await relay.close();
}
process.exit(failures === 0 ? 0 : 1);
