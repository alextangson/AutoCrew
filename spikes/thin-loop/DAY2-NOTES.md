# Day 2 Spike Notes — Route A: Thin Self-built Loop

> Spike date: 2026-06-10. Throwaway code — do not import into src/.

## Veto Criterion Verdict

**PASS — tool-use works on DeepSeek OpenAI-compatible API.**

Evidence: both `deepseek-v4-pro` and `deepseek-v4-flash` returned `tool_calls` in the first turn,
the loop executed the tool, appended the `tool` result message, re-sent, and the model continued
generation without error. Observed: `toolCallCount=1`, `stopReason=no_tool_calls`, `turns=2` for both tiers.

---

## Measurements Table

| Metric               | deepseek-v4-pro | deepseek-v4-flash |
|----------------------|-----------------|-------------------|
| Turns                | 2               | 2                 |
| Tool calls           | 1               | 1                 |
| Total tokens         | 1825            | 2100              |
| Wall time (ms)       | 23 953          | 18 430            |
| Stop reason          | no_tool_calls   | no_tool_calls     |
| Budget cap enforced? | —               | YES (see below)   |
| Script quality       | High            | High+             |

### Budget-cap enforcement test (maxTurns=1, v4-flash)

- Result: `stopReason=max_turns`, `turns=1`, `toolCallCount=1`. **PASS.**
- The model called the tool on turn 1 but there was no budget left for another turn;
  loop exited cleanly without executing the tool result and continuing.
- 20-line implementation. No extra machinery needed.

### Cost estimate (DeepSeek published list prices, 2025-06-10)

DeepSeek V3 (on which v4-pro/flash are based) input/output pricing:
- deepseek-v4-pro:   ~¥1/M input, ¥2/M output (list; actual may differ)
- deepseek-v4-flash: ~¥0.5/M input, ¥1/M output (estimated flash tier)

Hero-flow runs are so small (~1800–2100 tokens total) that per-run cost is sub-¥0.001.
Exact pricing for v4 tiers not yet published — noted as "list price unknown, sub-cent at scale."

---

## Anthropic-Compatible Endpoint Finding

### Endpoint: `https://api.deepseek.com/anthropic/v1/messages`

| Test                       | Status | Result                                  |
|----------------------------|--------|-----------------------------------------|
| Non-tool request           | 200    | Returns Anthropic Messages format JSON  |
| Request with tool definition| 200   | Returns `tool_use` block, stop_reason=`tool_use` |
| `/v1/messages` (no prefix) | 404    | Not available                           |

**Key finding:** DeepSeek exposes a fully Anthropic-format-compatible endpoint at
`/anthropic/v1/messages`. It returns the Anthropic Messages schema verbatim
(type, content array with thinking + tool_use blocks, stop_reason, usage).

**Implication for route-merge scenario:** The Claude Agent SDK *could* drive DeepSeek directly
by pointing its base URL to `https://api.deepseek.com/anthropic` — no proxy, no translation layer.
This is a significant finding: it means Day-1 (SDK route) does not need separate code paths for
domestic vs. Anthropic-hosted models.

Response excerpt (key, first 200 chars of response body, key redacted):
```json
{"id":"...","type":"message","role":"assistant","model":"deepseek-v4-flash",
"content":[{"type":"thinking","thinking":"..."},{"type":"tool_use","id":"call_...","name":"read_creator_profile","input":{}}],
"stop_reason":"tool_use",...}
```

---

## Loop Line Count

| File        | Total lines | Non-blank/comment lines |
|-------------|-------------|-------------------------|
| loop.mts    | 192         | ~163                    |

Core loop logic (the `runLoop` function + message append + tool execution): ~80 lines.
Full file including type definitions, env loader, tool defs: 192 lines.

**Plan estimate was ~500 lines for production version** — calibration:
minimal spike = 192 lines. Production additions (streaming, retry, telemetry, schema validation,
multi-tool registry) would realistically bring it to ~350–450 lines. Plan estimate is reasonable.

---

## Script Quality Assessment

### deepseek-v4-pro output
Strong. Clear hook, three well-structured points, punchy CTA. Follows writing rules:
- Opens in-situation, not with "你有没有这种感觉"
- Several standalone 金句: "模糊的问题，只能换来模糊的答案"
- Short sentences, even rhythm
- No 说教 tone, peer-level framing

### deepseek-v4-flash output
Also strong — arguably better structure (labeled sections, timed segments). Adds the "拆具反"
mnemonic framework that makes it more memorable. Slightly more utility-focused.
Both are production-usable drafts.

Flash is 5.5 seconds faster despite generating more tokens (2100 vs 1825). Counterintuitive —
likely prompt-token composition difference. At scale flash's cost advantage still holds.

---

## Decision Criteria Scores — Route A Column

| Criterion                                       | Weight    | Route A Score | Notes                                                |
|-------------------------------------------------|-----------|---------------|------------------------------------------------------|
| 国产模型 OpenAI 兼容接口能跑通 tool-use         | VETO      | **PASS**      | Verified both v4-pro and v4-flash                    |
| 步骤内预算上限（轮次/token）可强制              | High      | 5/5           | 20 lines, tested, works                              |
| 维护成本（升级追赶 / 行为黑盒）                  | High      | 5/5           | Full whitebox, no upstream dep                       |
| 接入薄云中转计费的改造量                         | Medium    | 5/5           | baseURL swap is the integration                      |
| 开发速度（到能跑的英雄流程）                     | Medium    | 3/5           | Spike took ~1h including measurement; production ~2d |
| Anthropic-endpoint bonus                        | (bonus)   | —             | DeepSeek /anthropic works → route merge viable       |

**Overall Route A assessment: viable, minimal, all veto criteria pass.**

The unexpected finding is that DeepSeek's `/anthropic/v1/messages` endpoint changes the route-B
analysis: if the Claude Agent SDK accepts a custom baseURL pointing to DeepSeek's Anthropic endpoint,
route B becomes viable for domestic models too — without any OpenAI-compat translation. This should
be verified in Day-1 results before final decision.

---

## Edges NOT handled in this spike (production would need)

1. Streaming (`stream: true`) — sync JSON used here for simplicity; adds ~30 lines
2. Retry with backoff — `src/utils/retry.ts` exists, trivial to wrap
3. Tool argument schema validation — none here; JSON.parse only
4. Multi-tool registry (more than 1 tool type) — trivial extension, ~10 lines
5. Context window management (truncation when messages grow) — not needed at ~2k tokens, needed at ~100k
6. Error-type discrimination (rate limit vs auth vs model error) — not done; adds ~20 lines
