/**
 * 真运行时冒烟：把构建产物挂进一个真的 cordis Context + 真的 dsh ToolRuntime，
 * 确认工具真的注册进去了、能查得到、能执行。
 *
 * 单元测试用的是假 ctx（快、进 CI），这支脚本补的是另一半：dsh 注册表在注册时会
 * 校验 output 声明，假 ctx 抓不到那一类拒绝。
 *
 *   npm run build && node scripts/smoke-register.mjs
 */
import { Context } from "@deepseek-ai/cordis";
// ToolRuntime 声明 inject: ['systemPrompt']，不挂它注册表永远停在 pending。
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import * as autocrew from "../dist/index.js";

const DATA_DIR = "/tmp/autocrew-dsh-smoke";

// cordis 的 fiber 是 thenable：await 它才等到 apply 真正跑完。
const ctx = new Context();
await ctx.plugin(SystemPrompt);
await ctx.plugin(ToolRuntime, { mode: "native" });
await ctx.plugin(autocrew, { dataDir: DATA_DIR });

const schemas = ctx.tools.schemas();
const names = schemas.map((s) => s.name);
console.log(`registered tools: ${names.join(", ") || "(none)"}`);
if (!names.includes("autocrew_status")) {
  console.error("FAIL: autocrew_status did not register");
  process.exit(1);
}

const definition = ctx.tools.get("autocrew_status");
const value = await definition.execute({ action: "overview" }, { signal: new AbortController().signal });
console.log(`execute ok: ${JSON.stringify(value)}`);

const content = definition.output.render({ action: "overview" }, value);
if (!Array.isArray(content) || content[0]?.type !== "text") {
  console.error("FAIL: render did not produce text content");
  process.exit(1);
}

let threw = false;
try {
  await definition.execute({ action: "compare" }, { signal: new AbortController().signal });
} catch (err) {
  threw = true;
  console.log(`failure surfaced: ${err.message}`);
}
if (!threw) {
  console.error("FAIL: ok:false was swallowed instead of thrown");
  process.exit(1);
}

console.log("SMOKE OK");
process.exit(0);
