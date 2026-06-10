/**
 * SPIKE: Hero-flow runner — Day 2, Route A
 * DO NOT import into src/. Throwaway.
 *
 * Runs the same hero-flow slice as Day 1 on both DeepSeek tiers.
 * Also tests budget-cap enforcement and the Anthropic-compatible endpoint.
 */

import { runLoop } from "./loop.mts";

const SYSTEM_PROMPT = "你是口播脚本编剧。";

const USER_MESSAGE =
  "先调用 read_creator_profile 了解创作者，然后为选题『AI 时代普通人最该练的一个技能』写一段 60 秒口播脚本（钩子 + 3 个要点 + 结尾 CTA），遵守创作者的 writingRules。";

// ─── Utility ──────────────────────────────────────────────────────────────────

function hr(label: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(label);
  console.log("─".repeat(60));
}

function printResult(label: string, r: Awaited<ReturnType<typeof runLoop>>) {
  hr(label);
  console.log(`Stop reason  : ${r.stopReason}`);
  console.log(`Turns        : ${r.turns}`);
  console.log(`Tool calls   : ${r.toolCallCount}`);
  console.log(`Total tokens : ${r.totalTokens}`);
  console.log(`Wall time    : ${r.wallMs}ms`);
  console.log("\n--- SCRIPT ---");
  console.log(r.finalMessage);
}

// ─── 1. v4-pro hero flow ──────────────────────────────────────────────────────

hr("RUN 1: deepseek-v4-pro — hero flow");
const proResult = await runLoop({
  model: "deepseek-v4-pro",
  maxTurns: 6,
  maxTotalTokens: 8000,
  systemPrompt: SYSTEM_PROMPT,
  userMessage: USER_MESSAGE,
});
printResult("RESULT: deepseek-v4-pro", proResult);

// ─── 2. v4-flash hero flow ────────────────────────────────────────────────────

hr("RUN 2: deepseek-v4-flash — hero flow");
const flashResult = await runLoop({
  model: "deepseek-v4-flash",
  maxTurns: 6,
  maxTotalTokens: 8000,
  systemPrompt: SYSTEM_PROMPT,
  userMessage: USER_MESSAGE,
});
printResult("RESULT: deepseek-v4-flash", flashResult);

// ─── 3. Budget-cap enforcement test ──────────────────────────────────────────

hr("RUN 3: Budget-cap enforcement (maxTurns=1, should stop after 1 turn)");
const capResult = await runLoop({
  model: "deepseek-v4-flash",
  maxTurns: 1,
  maxTotalTokens: 99999,
  systemPrompt: SYSTEM_PROMPT,
  userMessage: USER_MESSAGE,
});
console.log(`Stop reason: ${capResult.stopReason} (expected: max_turns or no_tool_calls on turn 1)`);
console.log(`Turns used: ${capResult.turns} (expected: 1)`);
console.log(`Tool call count: ${capResult.toolCallCount}`);
if (capResult.turns > 1) {
  console.error("FAIL: budget cap not enforced — ran more than 1 turn");
} else {
  console.log("PASS: budget cap enforced correctly");
}

// ─── 4. Anthropic-endpoint probe ──────────────────────────────────────────────

hr("RUN 4: Anthropic-compatible endpoint probe");

const envPath = new URL(".env", import.meta.url).pathname;
const { readFileSync } = await import("fs");
const raw = readFileSync(envPath, "utf8");
const lines = raw.split("\n").filter((l) => l.includes("="));
const env: Record<string, string> = {};
for (const line of lines) {
  const idx = line.indexOf("=");
  env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
}
const apiKey = env["DEEPSEEK_API_KEY"];
const baseUrl = env["DEEPSEEK_BASE_URL"] ?? "https://api.deepseek.com";

// Simple non-tool request to Anthropic-compatible endpoint
const anthropicUrl = `${baseUrl}/anthropic/v1/messages`;
console.log(`Testing: ${anthropicUrl}`);

try {
  const resp = await fetch(anthropicUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      max_tokens: 100,
      messages: [{ role: "user", content: "Reply with just: ANTHROPIC_ENDPOINT_OK" }],
    }),
  });
  const status = resp.status;
  const body = await resp.text();
  console.log(`Status: ${status}`);
  // Truncate body to avoid leaking anything sensitive
  console.log(`Response (first 500 chars): ${body.slice(0, 500)}`);
} catch (err) {
  console.log(`Fetch error: ${(err as Error).message}`);
}

// Also try without /anthropic prefix — some providers put it at root
const anthropicUrl2 = `${baseUrl}/v1/messages`;
console.log(`\nAlso testing: ${anthropicUrl2} (Anthropic Messages format, no /anthropic prefix)`);
try {
  const resp2 = await fetch(anthropicUrl2, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      max_tokens: 100,
      messages: [{ role: "user", content: "Reply with just: ANTHROPIC_ENDPOINT_OK" }],
    }),
  });
  const status2 = resp2.status;
  const body2 = await resp2.text();
  console.log(`Status: ${status2}`);
  console.log(`Response (first 500 chars): ${body2.slice(0, 500)}`);
} catch (err) {
  console.log(`Fetch error: ${(err as Error).message}`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

hr("SUMMARY");
console.log("v4-pro  | tool_calls:", proResult.toolCallCount, "| turns:", proResult.turns, "| tokens:", proResult.totalTokens, "| ms:", proResult.wallMs);
console.log("v4-flash| tool_calls:", flashResult.toolCallCount, "| turns:", flashResult.turns, "| tokens:", flashResult.totalTokens, "| ms:", flashResult.wallMs);
console.log("budget cap test passed:", capResult.turns <= 1);
