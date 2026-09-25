/**
 * 评分读两样东西（P6-e）：世界状态（临时数据目录里的稿件、选题、交接文件）与 trace
 * （守护进程 run-log 里的 MCP 行、无头会话的 stream-json）。**不读模型的自述**来判成败——
 * 最后那段话只拿来查「说的和发生的对不对得上」。
 *
 * 每条不变量是纯函数：拿一份 Trial，回 `{ ok, why }`。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface Verdict { ok: boolean; why: string }
export interface Invariant { name: string; check: (t: Trial) => Verdict }

export interface McpRow {
  ts: string;
  name: string;
  action?: string;
  ok: boolean;
  error?: string;
  session?: string;
  input: string;
  output: string;
}

export interface ToolUse {
  id: string;
  /** 去掉 mcp__autocrew__ 前缀的工具名（内置工具原样） */
  name: string;
  input: Record<string, any>;
  resultText?: string;
  isError?: boolean;
}

export interface Trace {
  /** 全部 run-log 行（含种子期） */
  allRows: Array<Record<string, any>>;
  /** 种子之后、agent=mcp 的工具行 */
  mcpRows: McpRow[];
  /** 本次会话（转发器 nonce sess-*）的 MCP 行 */
  sessionRows: McpRow[];
  toolUses: ToolUse[];
  finalText: string;
  result: Record<string, any> | null;
  init: Record<string, any> | null;
}

export interface WorldContent { id: string; meta: Record<string, any>; dir: string }
export interface World { data: string; contents: WorldContent[]; topics: Array<Record<string, any>> }

export interface Trial {
  scenario: string;
  trial: number;
  dir: string;
  seed: Record<string, any>;
  trace: Trace;
  world: World;
  timedOut: boolean;
}

export const pass = (why = ""): Verdict => ({ ok: true, why });
export const fail = (why: string): Verdict => ({ ok: false, why });

// ── 读 trace ─────────────────────────────────────────────────────────────────

function readJsonl(file: string): Array<Record<string, any>> {
  if (!existsSync(file)) return [];
  const out: Array<Record<string, any>> = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 坏行 */ }
  }
  return out;
}

export function readRunLog(data: string): Array<Record<string, any>> {
  const dir = path.join(data, "logs", "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().flatMap((f) => readJsonl(path.join(dir, f)));
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: any) => (b?.type === "text" ? String(b.text ?? "") : "")).join("\n");
}

function stripPrefix(name: string): string {
  return name.startsWith("mcp__autocrew__") ? name.slice("mcp__autocrew__".length) : name;
}

/** stream-json → 工具调用（配上结果）与最后一段话 */
export function parseTranscript(file: string): Pick<Trace, "toolUses" | "finalText" | "result" | "init"> {
  const events = readJsonl(file);
  const uses = new Map<string, ToolUse>();
  let lastText = "";
  let result: Record<string, any> | null = null;
  let init: Record<string, any> | null = null;
  for (const e of events) {
    if (e.type === "system" && e.subtype === "init") init = e;
    if (e.type === "result") result = e;
    const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
    for (const b of blocks) {
      if (e.type === "assistant" && b.type === "tool_use") uses.set(b.id, { id: b.id, name: stripPrefix(b.name), input: b.input ?? {} });
      if (e.type === "assistant" && b.type === "text" && !e.parent_tool_use_id) lastText = String(b.text ?? "");
      if (e.type === "user" && b.type === "tool_result" && uses.has(b.tool_use_id)) {
        Object.assign(uses.get(b.tool_use_id)!, { resultText: blockText(b.content), isError: Boolean(b.is_error) });
      }
    }
  }
  const finalText = typeof result?.result === "string" && result.result.trim() ? result.result : lastText;
  return { toolUses: [...uses.values()], finalText, result, init };
}

/** seedSessions：种子用过的会话 nonce（与转发器同形），不算进「模型会话」 */
export function loadTrace(dir: string, data: string, seedEndIso: string, seedSessions: string[] = []): Trace {
  const allRows = readRunLog(data);
  const mcpRows = allRows.filter((r) => r.kind === "tool" && r.agent === "mcp" && r.ts > seedEndIso) as McpRow[];
  const sessionRows = mcpRows.filter((r) => typeof r.session === "string" && r.session.startsWith("sess-") && !seedSessions.includes(r.session));
  return { allRows, mcpRows, sessionRows, ...parseTranscript(path.join(dir, "transcript.jsonl")) };
}

// ── 读世界 ───────────────────────────────────────────────────────────────────

export function loadWorld(data: string): World {
  const contentsDir = path.join(data, "contents");
  const contents = existsSync(contentsDir)
    ? readdirSync(contentsDir).flatMap((id) => {
      const file = path.join(contentsDir, id, "meta.json");
      return existsSync(file) ? [{ id, dir: path.join(contentsDir, id), meta: JSON.parse(readFileSync(file, "utf-8")) }] : [];
    })
    : [];
  const topicsDir = path.join(data, "topics");
  const topics = existsSync(topicsDir)
    ? readdirSync(topicsDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(topicsDir, f), "utf-8")))
    : [];
  return { data, contents, topics };
}

export function content(t: Trial, id: string = t.seed.contentId): WorldContent | undefined {
  return t.world.contents.find((c) => c.id === id);
}

// ── 查询助手 ─────────────────────────────────────────────────────────────────

export function uses(t: Trial, tool: string, action?: string): ToolUse[] {
  return t.trace.toolUses.filter((u) => u.name === tool && (action === undefined || u.input?.action === action));
}

export function rows(t: Trial, tool: string, action?: string): McpRow[] {
  return t.trace.sessionRows.filter((r) => r.name === tool && (action === undefined || r.action === action));
}

export function parseOut(row: McpRow): Record<string, any> | null {
  try { return JSON.parse(row.output); } catch { return null; }
}

export function parseIn(row: McpRow): Record<string, any> {
  try { return JSON.parse(row.input); } catch { return {}; }
}

/** 回执里的拒绝码：code 优先，其次 status；输出被截断时退回字面匹配 */
export function rowCode(row: McpRow): string {
  const out = parseOut(row);
  if (out) return String(out.code ?? out.status ?? "");
  return /"code":"([a-z_]+)"/.exec(row.output)?.[1] ?? "";
}

export function describeUse(u: ToolUse): string {
  const { action, ...rest } = u.input ?? {};
  return `${u.name}${action ? `.${action}` : ""}(${Object.keys(rest).join(",")})`;
}

export function statusOf(t: Trial, id?: string): string | undefined {
  return content(t, id)?.meta.status;
}
