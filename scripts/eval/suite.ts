/**
 * P6-e 行为 eval 入口：场景 × trials × 不变量（agent-craft scaffold/evals.ts 的形状）。
 *
 *   npx tsx scripts/eval/suite.ts [--only a,b] [--trials 3] [--parallel 3] [--run-id id] [--max-turns 40]
 *   npx tsx scripts/eval/suite.ts --regrade <run-id>     只重评已有 trial（修评分器用，不再跑模型）
 *   npx tsx scripts/eval/suite.ts --report <run-id>      只出报告
 *
 * 每个 trial：新目录 → 静态种子 → 临时守护进程 → MCP 种子旅程 → `claude -p` → 评分 → 关守护进程。
 * 场景之间并行（≤ parallel），同一场景的 trials 串行。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { SEED_SESSION, startDaemon } from "./daemon.js";
import { loadTrace, loadWorld, type Trial, type Verdict } from "./grade.js";
import { writeReport } from "./report.js";
import { runClaude, type RunOutcome } from "./run.js";
import { SCENARIOS, scenarioById, type Scenario } from "./scenarios.js";
import { EVAL_ROOT, makeTrialPaths, seedStatic } from "./world.js";

export interface TrialGrade {
  scenario: string;
  trial: number;
  dir: string;
  passed: boolean;
  verdicts: Array<{ name: string } & Verdict>;
  wallMs?: number;
  numTurns?: number;
  costUsd?: number;
  sessionRows: number;
  mcpToolUses: number;
  models: string[];
  exitCode?: number | null;
  timedOut: boolean;
  error?: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function gradeTrial(s: Scenario, dir: string): TrialGrade {
  const seed = JSON.parse(readFileSync(path.join(dir, "seed.json"), "utf-8"));
  const run = existsSync(path.join(dir, "run.json")) ? JSON.parse(readFileSync(path.join(dir, "run.json"), "utf-8")) : {};
  const data = seed.dataDir ?? path.join(dir, "data"); // 旧布局（试跑）世界就在记录目录里
  const trace = loadTrace(dir, data, seed.seedEnd, seed.seedSessions ?? []);
  const t: Trial = { scenario: s.id, trial: seed.trial, dir, seed, trace, world: loadWorld(data), timedOut: Boolean(run.timedOut) };
  const verdicts = s.invariants.map((i) => {
    try { return { name: i.name, ...i.check(t) }; } catch (err) { return { name: i.name, ok: false, why: `评分器抛错：${String(err)}` }; }
  });
  const r = t.trace.result;
  return {
    scenario: s.id, trial: seed.trial, dir, passed: verdicts.every((v) => v.ok), verdicts,
    wallMs: run.wallMs, numTurns: r?.num_turns, costUsd: r?.total_cost_usd, exitCode: run.exitCode, timedOut: t.timedOut,
    sessionRows: t.trace.sessionRows.length,
    mcpToolUses: t.trace.toolUses.filter((u) => u.name.startsWith("autocrew_")).length,
    models: Object.keys(r?.modelUsage ?? {}),
  };
}

async function seedTrial(s: Scenario, runId: string, n: number) {
  const p = await makeTrialPaths(runId, s.id, n);
  await seedStatic(p, s.radar?.() ?? []);
  const daemon = await startDaemon(p.data, path.join(p.dir, "daemon.log"));
  try {
    const seed = await s.seed(daemon, p);
    await new Promise((r) => setTimeout(r, 300)); // run-log 是 fire-and-forget 追加：让种子行先落盘
    const prompt = s.prompt(seed);
    const seedSessions = [SEED_SESSION, ...(seed.seedSessions ?? [])];
    const info = { ...seed, seedSessions, trial: n, prompt, dataDir: p.data, world: p.world, seedEnd: new Date().toISOString() };
    await fs.writeFile(path.join(p.dir, "seed.json"), JSON.stringify(info, null, 2));
    return { p, daemon, prompt };
  } catch (err) {
    await daemon.stop();
    throw err;
  }
}

async function runTrial(s: Scenario, runId: string, n: number, maxTurns: number): Promise<TrialGrade> {
  const { p, daemon, prompt } = await seedTrial(s, runId, n);
  let outcome: RunOutcome;
  try {
    outcome = await runClaude({ prompt, trialDir: p.dir, daemon, maxTurns });
    await new Promise((r) => setTimeout(r, 1_000));
  } finally {
    await daemon.stop();
  }
  const { result: _r, ...run } = outcome;
  await fs.writeFile(path.join(p.dir, "run.json"), JSON.stringify(run, null, 2));
  const grade = gradeTrial(s, p.dir);
  await fs.writeFile(path.join(p.dir, "grade.json"), JSON.stringify(grade, null, 2));
  return grade;
}

function logGrade(g: TrialGrade): void {
  const bad = g.verdicts.filter((v) => !v.ok).map((v) => `${v.name}: ${v.why}`);
  const wall = g.wallMs ? `${Math.round(g.wallMs / 1000)}s` : "?";
  console.log(`[${g.passed ? "PASS" : "FAIL"}] ${g.scenario} t${g.trial}  wall=${wall} turns=${g.numTurns ?? "?"} mcp=${g.sessionRows} cost=$${(g.costUsd ?? 0).toFixed(2)}`);
  for (const b of bad) console.log(`        ✗ ${b}`);
}

async function runScenario(s: Scenario, runId: string, trials: number, maxTurns: number): Promise<void> {
  for (let n = 1; n <= trials; n++) {
    try {
      logGrade(await runTrial(s, runId, n, maxTurns));
    } catch (err) {
      console.error(`[HARNESS] ${s.id} t${n}: ${err instanceof Error ? err.stack : String(err)}`);
    }
  }
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  });
  await Promise.all(workers);
}

async function regrade(runId: string): Promise<void> {
  const root = path.join(EVAL_ROOT, runId);
  for (const name of readdirSync(root).sort()) {
    const m = /^(.+)-t(\d+)$/.exec(name);
    if (!m || !existsSync(path.join(root, name, "seed.json"))) continue;
    const grade = gradeTrial(scenarioById(m[1]), path.join(root, name));
    await fs.writeFile(path.join(root, name, "grade.json"), JSON.stringify(grade, null, 2));
    logGrade(grade);
  }
}

async function main(): Promise<void> {
  const reportOnly = arg("report");
  if (reportOnly) return void (await writeReport(reportOnly));
  const again = arg("regrade");
  if (again) { await regrade(again); await writeReport(again); return; }
  const runId = arg("run-id") ?? `p6e-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const only = arg("only")?.split(",");
  const scenarios = only ? only.map(scenarioById) : SCENARIOS;
  const trials = Number(arg("trials") ?? 3);
  const maxTurns = Number(arg("max-turns") ?? 40);
  console.log(`run ${runId}: ${scenarios.length} 场景 × ${trials} trials，并行 ${arg("parallel") ?? 3}`);
  const started = Date.now();
  await pool(scenarios, Number(arg("parallel") ?? 3), (s) => runScenario(s, runId, trials, maxTurns));
  console.log(`全部完成，用时 ${Math.round((Date.now() - started) / 60_000)} 分钟`);
  await writeReport(runId);
}

await main();
