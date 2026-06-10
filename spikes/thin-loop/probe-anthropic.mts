/**
 * SPIKE: Probe DeepSeek's Anthropic-compatible endpoint with tool use.
 * Throwaway — do not import into src/.
 */

import { readFileSync } from "fs";

const envPath = new URL(".env", import.meta.url).pathname;
const raw = readFileSync(envPath, "utf8");
const env: Record<string, string> = {};
for (const line of raw.split("\n").filter((l) => l.includes("="))) {
  const idx = line.indexOf("=");
  env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
}
const apiKey = env["DEEPSEEK_API_KEY"];
const baseUrl = env["DEEPSEEK_BASE_URL"] ?? "https://api.deepseek.com";

const url = `${baseUrl}/anthropic/v1/messages`;
console.log(`POST ${url}`);

const body = {
  model: "deepseek-v4-flash",
  max_tokens: 200,
  tools: [
    {
      name: "read_creator_profile",
      description: "Read the creator's profile.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  ],
  messages: [
    {
      role: "user",
      content: "Call read_creator_profile to get my profile, then tell me my industry in one sentence.",
    },
  ],
};

const resp = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify(body),
});

const status = resp.status;
const responseText = await resp.text();
console.log(`Status: ${status}`);
console.log(`Response: ${responseText.slice(0, 1000)}`);

// Determine if tool_use block appears
const hasToolUse = responseText.includes('"tool_use"');
console.log(`\nContains tool_use block: ${hasToolUse}`);
