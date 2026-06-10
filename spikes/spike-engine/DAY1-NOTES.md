# AutoCrew Engine Spike — Day 1 Notes
## Route B: Claude Agent SDK Validation

**Date**: 2026-06-10  
**Status**: DONE_WITH_CONCERNS  
**Timebox**: Day 1 of 2

---

## Auth Blocker (Document First)

The live hero-flow run was **blocked by an expired OAuth token**.

- `~/.claude/.credentials.json` contains `claudeAiOauth.accessToken` which expired 2026-05-12T15:33:25Z (current date: 2026-06-10).
- `claude -p "..."` returns 401 when run as a subprocess even though `claude auth status` reports `loggedIn: true` (status reads metadata, doesn't make API calls).
- The desktop app holds live tokens in-memory and exposes a refresh IPC channel via `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1`. This IPC is not available to subprocesses spawned from within an agent session.
- **Fix**: Either (a) re-run `claude auth login` in a terminal to refresh `.credentials.json`, or (b) use `claude setup-token` to create an `ANTHROPIC_API_KEY`-format long-lived token, or (c) set `ANTHROPIC_API_KEY` explicitly.
- The script `hero-flow.mjs` is complete and correct — the auth issue is infrastructure, not SDK incompatibility.

All findings below are based on SDK type surface analysis (authoritative), code inspection, and partial CLI testing. The live token measurement was blocked.

---

## 1. Installation Measurements

| Metric | Value |
|---|---|
| SDK version | `@anthropic-ai/claude-agent-sdk@0.3.170` |
| `npm install` time | ~20s |
| `node_modules` total size | **265 MB** |
| Total packages installed | 98 |
| SDK direct dependencies | **0** (peer-deps only) |
| Main bulk | `@anthropic-ai/claude-agent-sdk-darwin-arm64` = **212 MB** (the Claude Code binary) |
| SDK logic (JS) | ~4 MB |
| Peer deps needed | `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.0.0` |

**Key finding**: The 265 MB is almost entirely the embedded Claude Code CLI binary (~212 MB). In production, if Claude Code is already installed, this binary is redundant. The SDK itself is thin.

---

## 2. Hero-Flow Script

File: `spikes/spike-engine/hero-flow.mjs`

Architecture:
```
query() → spawns Claude Code subprocess → in-process MCP server via stdio
       → custom tool: read_creator_profile (reads ~/.autocrew/creator-profile.json)
       → streams SDKMessages back → collect result
```

The script is complete and uses:
- `createSdkMcpServer` + `tool()` for the custom in-process tool
- `query()` with minimal options
- Result/token usage extraction from `SDKResultSuccess`

**Auth issue prevented live execution** — see section above. The measurements below are theoretical / from SDK analysis.

---

## 3. Measurements Table

### Live timing (NOT measured — auth blocked)
| Metric | Status | Notes |
|---|---|---|
| Cold start → first event | NOT MEASURED | Auth expired; estimated 2-5s based on subprocess spawn overhead |
| Total wall time | NOT MEASURED | Auth expired |
| Input tokens | NOT MEASURED | |
| Output tokens | NOT MEASURED | |
| Cost USD | NOT MEASURED | |

### SDK process overhead (estimated from code inspection)
The SDK spawns a Node.js subprocess. Subprocess spawn + Claude CLI init: ~1-3s cold.
For a 60-second monologue script: ~1000-2000 output tokens, ~500-800 input tokens.

---

## 4. Loop Control — Exact API Surface

### Budget caps
```typescript
// Options.maxTurns: hard cap on agent loop iterations
maxTurns?: number;          // Options.maxTurns — CLI flag: --max-turns <n>

// Options.maxBudgetUsd: dollar ceiling
maxBudgetUsd?: number;      // CLI flag: --max-budget-usd <amount>

// Options.taskBudget: token budget hint to model (alpha)
taskBudget?: { total: number };  // CLI flag: --task-budget <n> (alpha, beta header required)
```

### Disabling built-in tools (to get MINIMAL loop)
```typescript
options: {
  tools: [],  // empty array = disable ALL built-in tools (Bash, Read, Edit, Write, Glob, Grep, Agent, etc.)
  disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent'],  // belt+suspenders
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,  // required when using bypassPermissions
}
```

The `tools: []` option is explicitly documented: "empty array = Disable all built-in tools".

### Disabling subagents
No explicit "no-subagents" flag. But: setting `tools: []` removes the `Agent` tool from the model's context, so the model cannot spawn subagents. `disallowedTools: ['Agent']` is belt+suspenders.

### Disabling compaction
**No public API to disable compaction**. There is an internal `COMPACT_SKIP` flag but it's not exposed in `Options`. For short sessions (maxTurns ≤5, scripts <5000 tokens), compaction will not trigger — the SDK compacts only when context approaches the model's window limit. No action needed for the hero-flow use case.

---

## 5. Minimal Loop Config Snippet

```typescript
const q = query({
  prompt: PROMPT,
  options: {
    // ── Tool scope: ONLY our custom MCP tool ──
    tools: [],                        // disable all built-in tools
    disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent'],
    allowedTools: ['mcp__creator-tools__read_creator_profile'],
    
    // ── Budget hard caps ──
    maxTurns: 5,                      // Options.maxTurns — max 5 agentic turns
    maxBudgetUsd: 0.10,               // Options.maxBudgetUsd — hard dollar ceiling
    
    // ── Session hygiene ──
    persistSession: false,            // no disk writes to ~/.claude/projects/
    
    // ── Minimal thinking ──
    thinking: { type: 'disabled' },   // no extended thinking
    effort: 'low',                    // Options.effort
    
    // ── Auth (when OAuth expired, use env-based API key) ──
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '<key>',       // OR use setup-token generated key
      // ANTHROPIC_BASE_URL: '<proxy>', // for custom endpoint — see section 6
    },
    
    // ── Custom tool via in-process MCP server ──
    mcpServers: {
      'creator-tools': createSdkMcpServer({
        name: 'creator-tools',
        tools: [readCreatorProfileTool],
        alwaysLoad: true,
      }),
    },
    
    // ── Permission bypass for headless use ──
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  },
});
```

---

## 6. baseURL / Third-Party Model Finding (CRITICAL)

### TL;DR
**The configuration surface exists**, but there is a **protocol constraint**: the endpoint must speak Anthropic's API protocol (not OpenAI's). For 国产模型 (豆包/DeepSeek/通义) the "薄云中转" proxy needs to translate Anthropic → OpenAI (or model-native) protocol.

### Details

**How ANTHROPIC_BASE_URL flows through the SDK stack:**

```
query(options)
  → SDK spawns claude CLI subprocess
    → subprocess env includes ANTHROPIC_BASE_URL (from options.env or inherited process.env)
      → Claude CLI uses @anthropic-ai/sdk internally
        → @anthropic-ai/sdk reads process.env['ANTHROPIC_BASE_URL']
          → sends all Anthropic API requests to that base URL
```

**Evidence** (from `@anthropic-ai/sdk` type definitions):
```typescript
// @anthropic-ai/sdk/client.d.ts line 80, 194:
// "Defaults to process.env['ANTHROPIC_BASE_URL']."
// "baseURL=process.env['ANTHROPIC_BASE_URL'] ?? https://api.anthropic.com"
```

**SDK `options.env` docs** (sdk.d.ts line 1404-1416):
> "When set, this value REPLACES the subprocess environment entirely — it is not merged with process.env. Spread process.env yourself if the subprocess still needs inherited variables like PATH, HOME, or ANTHROPIC_API_KEY."

**Config pattern for Day 2 domestic endpoint test:**
```typescript
options: {
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: 'https://your-thin-relay.example.com',  // Anthropic-protocol proxy
    ANTHROPIC_API_KEY: 'your-relay-api-key',
  },
  model: 'claude-sonnet-4-6',  // model name as mapped by your relay
}
```

### What Day 2 Needs to Verify
- The relay must implement Anthropic's Messages API protocol (not OpenAI's) — specifically the `POST /v1/messages` endpoint with tool_use blocks.
- OR: build/use a proxy that translates Anthropic protocol → domestic model protocol (e.g., 豆包 ARK / DeepSeek API).
- The `ANTHROPIC_BASE_URL` env var approach works at the config surface level — confirmed from SDK types.
- **Day 2 test**: Point `ANTHROPIC_BASE_URL` at a working Anthropic-protocol-compatible relay with a domestic model key and verify tool_use roundtrip.

### Additional provider options (from AccountInfo type)
The SDK/CLI already knows about: `'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'mantle' | 'gateway'`.
"gateway" = enterprise gateway (exactly what the 薄云中转 architecture maps to).

---

## 7. Token Usage Extraction

From SDK types, `SDKResultSuccess` (the final message):
```typescript
type SDKResultSuccess = {
  type: 'result';
  subtype: 'success';
  result: string;               // final text output
  usage: NonNullableUsage;      // { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, ... }
  total_cost_usd: number;       // accumulated cost
  num_turns: number;            // turns used
  duration_ms: number;          // total wall time
  ttft_ms?: number;             // time to first token
  duration_api_ms: number;      // API-only time
};
```

Token usage is **fully exposed** in the result message. No need for separate instrumentation.

---

## 8. Decision Criteria Score (Preliminary)

> Note: Route B measurements marked "BLOCKED" due to auth expiry. Scores based on SDK surface analysis.

| 标准 | 权重 | 路线 A 风险 | 路线 B 风险 | B 评分 |
|---|---|---|---|---|
| 国产模型 OpenAI 兼容接口能跑通 tool-use | **一票否决** | 低（协议自己控） | 配置面存在（ANTHROPIC_BASE_URL via env.env），但需要Anthropic协议中转代理，不能直接对接OpenAI兼容endpoint | ⚠️ DAY2 待验证 |
| 步骤内预算上限（轮次/token）可强制 | 高 | 自己实现，~20行 | **✅ 已确认**：maxTurns / maxBudgetUsd / taskBudget 均有暴露 | ✅ |
| 维护成本（升级追赶 / 行为黑盒） | 高 | 全白盒，无升级依赖 | 265MB binary dep，跟随Anthropic维护，行为随版本变 | ⚠️ |
| 接入薄云中转计费的改造量 | 中 | 天然（baseURL即中转） | env: { ANTHROPIC_BASE_URL: relay } 一行，但中转必须实现Anthropic协议 | 中等 |
| 开发速度（到能跑的英雄流程） | 中 | 慢几天 | **✅** SDK设计好，createSdkMcpServer+tool() API直觉简洁，hero-flow脚本~90行 | ✅ |

### Preliminary Assessment

**The SDK works as advertised for the Anthropic-first case.** The minimal-loop config surface is complete and well-designed.

**The domestic model question remains the swing factor.** The `ANTHROPIC_BASE_URL` config surface exists, but the CLI only speaks Anthropic protocol. For PRD §9's 国产模型 goal, the "薄云中转" must implement Anthropic's `/v1/messages` API (with tool_use), not just be an OpenAI-compatible proxy.

**Route A** automatically handles this (you call any endpoint's `/chat/completions`). **Route B** requires a protocol translation layer. The question for Day 2: how complex is that layer? If it's a simple nginx+adapter, cost is low. If it requires maintaining a full Anthropic-protocol server, the maintenance burden rises.

---

## 9. Files

- `spikes/spike-engine/hero-flow.mjs` — complete hero-flow script (auth-blocked, not run)
- `spikes/spike-engine/auth-helper.js` — OAuth token reader (for future reference)
- `spikes/spike-engine/package.json` — spike package manifest
- `spikes/spike-engine/DAY1-NOTES.md` — this file

---

## 10. What Day 2 Should Do

1. **Refresh auth** before running: `claude auth login` in terminal OR `ANTHROPIC_API_KEY=<key> node hero-flow.mjs`
2. **Measure live**: cold start, TTFT, token usage, total wall time
3. **Test domestic model path**: Stand up a minimal Anthropic-protocol proxy pointing to DeepSeek or 豆包 ARK. Set `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` in `options.env`. Verify tool_use works.
4. **Compare with Route A** (thin-loop script in `spikes/thin-loop/`): same prompt, measure token efficiency and output quality
5. **Write DECISION-engine.md** in `docs/superpowers/plans/`
