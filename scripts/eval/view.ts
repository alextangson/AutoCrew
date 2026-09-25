/**
 * 最小 trace 查看器（P6-e）：把一个 trial 的 stream-json 压成人读的时间线——
 * 助手说的话、每次工具调用（参数截断）、工具回执（截断）、hook 输出、最后的 result。
 *
 *   npx tsx scripts/eval/view.ts <trial-dir> [--full]
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("用法：view.ts <trial-dir> [--full]");
const full = process.argv.includes("--full");
const clip = (s: string, n: number) => (full || s.length <= n ? s : `${s.slice(0, n)}…(${s.length})`);
const text = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b?.type === "text" ? b.text : `[${b?.type}]`)).join("\n") : "");

function line(e: Record<string, any>): string[] {
  if (e.type === "system" && e.subtype === "hook_response") return [`· hook ${e.hook_name}: ${clip(String(e.output ?? e.stdout ?? "").trim(), 200)}`];
  if (e.type === "result") return [`= result ${e.subtype} turns=${e.num_turns} cost=$${Number(e.total_cost_usd ?? 0).toFixed(2)} denials=${JSON.stringify(e.permission_denials ?? [])}`];
  const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
  const sub = e.parent_tool_use_id ? "  [sub] " : "";
  return blocks.flatMap((b: Record<string, any>) => {
    if (e.type === "assistant" && b.type === "text") return [`${sub}» ${clip(String(b.text), 1500)}`];
    if (e.type === "assistant" && b.type === "tool_use") return [`${sub}→ ${b.name} ${clip(JSON.stringify(b.input), 600)}`];
    if (e.type === "user" && b.type === "tool_result") return [`${sub}← ${b.is_error ? "ERR " : ""}${clip(text(b.content).replace(/\s+/g, " "), 500)}`];
    return [];
  });
}

const seed = JSON.parse(readFileSync(path.join(dir, "seed.json"), "utf-8"));
console.log(`# ${path.basename(dir)}\nprompt: ${seed.prompt}\n`);
for (const raw of readFileSync(path.join(dir, "transcript.jsonl"), "utf-8").split("\n")) {
  if (!raw.trim()) continue;
  try { for (const l of line(JSON.parse(raw))) console.log(l); } catch { /* 半行 */ }
}
