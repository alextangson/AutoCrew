/**
 * P6-e 报告：每场景 pass 率与 pass^k、各不变量失败数、中位轮数 / MCP 往返 / 花费，
 * 加一份指纹（代码 HEAD、claude-code 宿主的 tools/list 与 instructions 哈希、两份技能哈希、实际模型）。
 * 「行为成立」的每一句都指向场景 id 与它的 pass^k（claimsBacked）。
 * 人读 transcript 写下的逐场景观察放在 `<run>/notes.md`，原样并进报告。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mcpRequest, REPO_ROOT, startDaemon } from "./daemon.js";
import { DENIED_TOOLS, RUN_TIMEOUT_MS } from "./run.js";
import { SCENARIOS } from "./scenarios.js";
import type { TrialGrade } from "./suite.js";
import { EVAL_ROOT, seedStatic, makeTrialPaths } from "./world.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const median = (xs: number[]) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};
const fmt = (x: number, digits = 0) => (Number.isFinite(x) ? x.toFixed(digits) : "–");

function loadGrades(runId: string): TrialGrade[] {
  const root = path.join(EVAL_ROOT, runId);
  return readdirSync(root).sort().flatMap((name) => {
    const file = path.join(root, name, "grade.json");
    return existsSync(file) ? [JSON.parse(readFileSync(file, "utf-8")) as TrialGrade] : [];
  });
}

async function protocolHashes(runId: string): Promise<{ tools: string; instructions: string; toolCount: number }> {
  const p = await makeTrialPaths(runId, "fingerprint", 0);
  await seedStatic(p);
  const d = await startDaemon(p.data, path.join(p.dir, "daemon.log"));
  try {
    const list = await mcpRequest(d, "tools/list", {}, "eval-fingerprint");
    const init = await mcpRequest(d, "initialize", { protocolVersion: "2025-06-18" }, "eval-fingerprint");
    const tools = list.result.tools as unknown[];
    return { tools: sha(JSON.stringify(tools)), instructions: sha(String(init.result.instructions)), toolCount: tools.length };
  } finally {
    await d.stop();
  }
}

function fileSha(file: string): string {
  return existsSync(file) ? sha(readFileSync(file)).slice(0, 16) : "（缺）";
}

/** 命令行：提示词与每 trial 的 mcp-config 路径换成占位，其余原样 */
function flagLine(args: string[]): string {
  return args.map((a, i) => (args[i - 1] === "-p" ? "<prompt>" : args[i - 1] === "--mcp-config" ? "<trial>/mcp-config.json" : a)).join(" ");
}

async function fingerprint(runId: string, grades: TrialGrade[]): Promise<string[]> {
  const git = (...a: string[]) => spawnSync("git", a, { cwd: REPO_ROOT, encoding: "utf-8" }).stdout.trim();
  const proto = await protocolHashes(runId);
  const skills = path.join(os.homedir(), ".claude", "skills");
  const models = [...new Set(grades.flatMap((g) => g.models))].join(", ") || "（无）";
  const firstRun = grades.map((g) => path.join(g.dir, "run.json")).find(existsSync);
  const args: string[] = firstRun ? JSON.parse(readFileSync(firstRun, "utf-8")).args ?? [] : [];
  return [
    `- code: \`${git("rev-parse", "HEAD")}\` (${git("rev-parse", "--abbrev-ref", "HEAD")}; uncommitted outside scripts/eval: ${git("status", "--porcelain", "--", ".", ":!scripts/eval", ":!docs/evals").split("\n").filter(Boolean).length})`,
    `- tools/list (host claude-code, ${proto.toolCount} tools) sha256: \`${proto.tools.slice(0, 16)}\``,
    `- MCP instructions sha256: \`${proto.instructions.slice(0, 16)}\``,
    `- skills (installed, ~/.claude/skills): video-session/SKILL.md \`${fileSha(path.join(skills, "video-session", "SKILL.md"))}\`, write-script/SKILL.md \`${fileSha(path.join(skills, "write-script", "SKILL.md"))}\`, morning-task-prompt.md \`${fileSha(path.join(skills, "video-session", "references", "morning-task-prompt.md"))}\``,
    `- served model(s) from result.modelUsage: ${models}`,
    `- claude CLI: ${spawnSync("claude", ["--version"], { encoding: "utf-8" }).stdout.trim()}`,
    `- flags: \`claude ${flagLine(args)}\``,
    `- denied tools: ${DENIED_TOOLS.join(", ")} (user settings allow Bash(*); denied so the eval cannot reach :4317 or ~/.autocrew); hard timeout ${RUN_TIMEOUT_MS / 60_000} min/run`,
  ];
}

interface Row { id: string; trials: number; passed: number; passAll: boolean; turns: number; mcp: number; cost: number; wall: number; failures: Map<string, number> }

function aggregate(grades: TrialGrade[]): Row[] {
  return SCENARIOS.flatMap((s) => {
    const gs = grades.filter((g) => g.scenario === s.id);
    if (!gs.length) return [];
    const failures = new Map<string, number>();
    for (const g of gs) for (const v of g.verdicts) if (!v.ok) failures.set(v.name, (failures.get(v.name) ?? 0) + 1);
    const passed = gs.filter((g) => g.passed).length;
    return [{
      id: s.id, trials: gs.length, passed, passAll: passed === gs.length,
      turns: median(gs.map((g) => g.numTurns ?? NaN)), mcp: median(gs.map((g) => g.sessionRows)),
      cost: median(gs.map((g) => g.costUsd ?? NaN)), wall: median(gs.map((g) => (g.wallMs ?? NaN) / 60_000)), failures,
    }];
  });
}

function resultsTable(rows: Row[]): string[] {
  const head = ["| scenario | trials | pass rate | pass^k | median turns | median MCP round-trips | median cost (USD) | median wall (min) |", "|---|---|---|---|---|---|---|---|"];
  return [...head, ...rows.map((r) => `| \`${r.id}\` | ${r.trials} | ${r.passed}/${r.trials} | ${r.passAll ? 1 : 0} (k=${r.trials}) | ${fmt(r.turns)} | ${fmt(r.mcp)} | ${fmt(r.cost, 2)} | ${fmt(r.wall, 1)} |`)];
}

function claimsSection(rows: Row[]): string[] {
  return rows.map((r) => {
    const origin = SCENARIOS.find((s) => s.id === r.id)?.origin ?? "";
    if (r.passAll) return `- **Held** (${origin}) — \`${r.id}\` pass^${r.trials} = 1 (${r.passed}/${r.trials}).`;
    const worst = [...r.failures.entries()].map(([k, n]) => `${k} ×${n}`).join("; ");
    return `- **Not established** (${origin}) — \`${r.id}\` pass^${r.trials} = 0 (${r.passed}/${r.trials}); failing: ${worst}.`;
  });
}

/** 跨场景不变量单独成句：每个场景的 pass^k 都含它们，拆开看才说得清「G2 在多少条 trial 上成立」 */
function crossCuttingClaims(grades: TrialGrade[]): string[] {
  return ["G2: zero kind:llm rows in run-log", "no MCP row hit engine_disabled"].map((name) => {
    const held = grades.filter((g) => g.verdicts.some((v) => v.name === name && v.ok)).length;
    return `- **${held === grades.length ? "Held" : "Not established"}** (spec §2 G2 主路零引擎) — \`${name}\` 在全部场景 ${held}/${grades.length} 条 trial 上成立。`;
  });
}

function failureList(grades: TrialGrade[]): string[] {
  const bad = grades.filter((g) => !g.passed);
  if (!bad.length) return ["（无）"];
  return bad.flatMap((g) => g.verdicts.filter((v) => !v.ok).map((v) => `- \`${g.scenario}\` t${g.trial} — **${v.name}**: ${v.why}  \n  \`${g.dir}\``));
}

const UNHANDLED = [
  "`title-sync`（§3.3 会话标题同步）：`set_session_title` 是桌面端工具，`claude -p` 里没有，无头跑不了。",
  "CCB 派工（§3.5 `ask codex`）：eval 拒绝了 Bash，且 CCB 未挂；只测了手动派工那句话。",
  "Codex 侧 `register`（§3.4）：需要 Codex 宿主与四道闸门凭据，本 eval 只跑 Claude 宿主；register 的门归 `src/modules/video/handoff/register.test.ts` 等单测（本次未复跑）。",
  "多轮对话：晨报之后用户回数字开工、交接之后回来说剪完——每个 trial 只有一轮用户输入。",
  "§4 其余用例（交接/登记的路径守卫、雷达并发限额、read_page 配额、kit_stale 等）是确定性门，归 P6-a–d 的 harness 单测，不属于模型行为 eval；本次没有复跑那些单测。",
  "被 12 分钟硬超时杀掉的 trial 没有 result 事件：它的轮数与花费不进中位数，实际花费未知。",
  "试跑 run `p6e-20260925` 因模型读到 `scripts/eval` 作废（原因与修法见上文），目录保留在同一缓存根下备查。",
];

const DOC = path.join(REPO_ROOT, "docs", "evals", "2026-09-25-p6e-behavior-eval.md");

/** 报告正文（不含标题）。h = 本层标题的井号：整份报告用 "##"，追加到已有报告里的一节用 "###" */
async function reportBody(runId: string, h: string): Promise<string[]> {
  const grades = loadGrades(runId);
  const rows = aggregate(grades);
  const notesFile = path.join(EVAL_ROOT, runId, "notes.md");
  const notes = existsSync(notesFile) ? readFileSync(notesFile, "utf-8").trim() : "（尚未写：读 transcript 后补在 notes.md）";
  const perInvariant = rows.flatMap((r) => [...r.failures.entries()].map(([k, n]) => `| \`${r.id}\` | ${k} | ${n}/${r.trials} |`));
  await fs.writeFile(path.join(EVAL_ROOT, runId, "results.json"), JSON.stringify({ runId, rows: rows.map((r) => ({ ...r, failures: Object.fromEntries(r.failures) })), grades }, null, 2));
  return [
    `> 生成：\`npx tsx scripts/eval/suite.ts --report ${runId}\`。原始 transcript / run-log / 世界目录：\`${path.join(EVAL_ROOT, runId)}\`。`, "",
    `${h} 指纹`, "", ...(await fingerprint(runId, grades)), "",
    `${h} 结果`, "", ...resultsTable(rows), "",
    `${h}# 各不变量失败次数`, "", "| scenario | invariant | failed |", "|---|---|---|", ...(perInvariant.length ? perInvariant : ["| – | （无失败） | – |"]), "",
    `${h} 结论（claimsBacked：每句指向场景与 pass^k）`, "", ...crossCuttingClaims(grades), ...claimsSection(rows), "",
    `${h} 逐场景观察（读 transcript）`, "", notes, "",
    `${h} 失败明细`, "", ...failureList(grades), "",
  ];
}

/**
 * `--publish`：整份覆盖 docs/evals 里的报告；`--append <标题>`：在已有报告末尾追加一节（修复后重跑用，
 * 前面的轮次原样留作历史）。同名一节已存在就替换那一节，不重复追加。
 */
export async function writeReport(runId: string, publish = process.argv.includes("--publish")): Promise<string> {
  const i = process.argv.indexOf("--append");
  const appendTitle = i >= 0 ? process.argv[i + 1] : undefined;
  const md = [`# P6-e 行为 eval 报告（run \`${runId}\`）`, "", ...(await reportBody(runId, "##")), "## 未覆盖", "", ...UNHANDLED.map((u) => `- ${u}`), ""].join("\n");
  const out = path.join(EVAL_ROOT, runId, "report.md");
  await fs.writeFile(out, md);
  if (appendTitle) {
    const section = [`## ${appendTitle}`, "", ...(await reportBody(runId, "###"))].join("\n");
    const doc = readFileSync(DOC, "utf-8");
    const at = doc.indexOf(`\n## ${appendTitle}\n`);
    await fs.writeFile(DOC, `${(at >= 0 ? doc.slice(0, at) : doc).trimEnd()}\n\n${section}`);
  } else if (publish) {
    await fs.writeFile(DOC, md);
  }
  console.log(`报告：${out}${appendTitle ? `（已追加「${appendTitle}」到 docs/evals/）` : publish ? "（已复制到 docs/evals/）" : ""}`);
  return out;
}
