/**
 * AutoCrew Engine Spike — Day 1
 * Hero-flow slice: read_creator_profile tool + script generation
 *
 * NOT for production — throwaway spike code.
 * Do NOT import this from src/.
 *
 * AUTH NOTE: Requires a valid ANTHROPIC_API_KEY.
 * If the OAuth token in ~/.claude/.credentials.json is expired (check with:
 *   node -e "const d=require(process.env.HOME+'/.claude/.credentials.json'); console.log('expired:', Date.now() > d.claudeAiOauth.expiresAt)"
 * then either:
 *   - Run `claude auth login` in a terminal to refresh it, OR
 *   - Run `claude setup-token` to create a long-lived API key, OR
 *   - Set ANTHROPIC_API_KEY env var: ANTHROPIC_API_KEY=sk-ant-... node hero-flow.mjs
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'fs';

const CREATOR_PROFILE_PATH = '/Users/macmini/.autocrew/creator-profile.json';

// ── 1. Define the custom in-process tool ──────────────────────────────────────

const readCreatorProfileTool = tool(
  'read_creator_profile',
  'Read the creator profile including industry, platforms, and writingRules.',
  {},  // no input params needed
  async (_args, _extra) => {
    const raw = readFileSync(CREATOR_PROFILE_PATH, 'utf-8');
    const profile = JSON.parse(raw);
    const result = {
      industry: profile.industry,
      platforms: profile.platforms,
      writingRules: profile.writingRules,
      expressionPersona: profile.expressionPersona,
      styleBoundaries: profile.styleBoundaries,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
  { alwaysLoad: true }
);

// ── 2. Create in-process MCP server with the tool ────────────────────────────

const profileServer = createSdkMcpServer({
  name: 'creator-tools',
  version: '0.1.0',
  tools: [readCreatorProfileTool],
  alwaysLoad: true,
});

// ── 3. Run the agent loop ─────────────────────────────────────────────────────

const PROMPT = `你是口播脚本编剧。先调用 read_creator_profile 了解创作者，然后为选题『AI 时代普通人最该练的一个技能』写一段 60 秒口播脚本（钩子 + 3 个要点 + 结尾 CTA），遵守创作者的 writingRules。`;

const t0 = Date.now();
let firstTokenMs = null;
let result = null;
let assistantText = '';

const q = query({
  prompt: PROMPT,
  options: {
    // ── Minimal loop config ──────────────────────────────────────────────────
    // Only our custom tool; disable all built-in file/bash/subagent tools
    tools: [],                        // disable ALL built-in tools
    disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent'],
    // Cap the loop
    maxTurns: 5,                      // hard loop cap: Options.maxTurns
    // Disable features we don't need
    persistSession: false,            // no disk persistence
    // Inject our custom tool via in-process MCP server
    mcpServers: {
      'creator-tools': profileServer,
    },
    allowedTools: ['mcp__creator-tools__read_creator_profile'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // Minimal thinking
    thinking: { type: 'disabled' },
    effort: 'low',
  },
});

for await (const msg of q) {
  if (firstTokenMs === null && (msg.type === 'assistant' || msg.type === 'system')) {
    firstTokenMs = Date.now() - t0;
  }

  if (msg.type === 'assistant') {
    // Collect text content
    if (Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          assistantText += block.text;
        }
      }
    }
  }

  if (msg.type === 'result') {
    result = msg;
  }
}

const totalMs = Date.now() - t0;

// ── 4. Print measurements ─────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  AutoCrew Engine Spike — Day 1 Results');
console.log('═══════════════════════════════════════════════════════════\n');

console.log(`Cold start → first event:  ${firstTokenMs ?? 'N/A'} ms`);
console.log(`Total wall time:           ${totalMs} ms`);

if (result) {
  console.log(`\nToken usage:`);
  console.log(`  input_tokens:             ${result.usage?.input_tokens ?? 'N/A'}`);
  console.log(`  output_tokens:            ${result.usage?.output_tokens ?? 'N/A'}`);
  console.log(`  cache_read_input_tokens:  ${result.usage?.cache_read_input_tokens ?? 0}`);
  console.log(`  cache_creation:           ${result.usage?.cache_creation_input_tokens ?? 0}`);
  console.log(`\nCost USD:   $${result.total_cost_usd ?? 'N/A'}`);
  console.log(`Turns used: ${result.num_turns}`);
  console.log(`Stop reason: ${result.stop_reason}`);
  console.log(`Is error: ${result.is_error}`);
}

console.log('\n─── Generated 口播脚本 ────────────────────────────────────\n');
const scriptText = result?.result ?? assistantText;
console.log(scriptText);
console.log('\n═══════════════════════════════════════════════════════════\n');
