/**
 * 启用本体（spec §4.1）：可恢复的启用事务（Codex 审 P1：不能先打开开关再尽力补保护）。
 *
 *   写启用事务日志（running + 排除清单）→ 对账落盘 → 按旧状态补等价决定（含 legacy.ts 核过的旧登记）
 *   → 逐条投影 status 并冻结（强制，开关还没开）→ 全部成功才写启用版本 → 删事务日志。
 *
 * 任何一条失败：开关不写，失败逐条列给创始人。创始人可以把某几条**明确排除**（exclude），它们留在旧行为、
 * 卡片上标「未纳入本体」——从不静默跳过。进程中途退出（日志还在）：启动时按同一份排除清单续跑。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { contentRoot, ONTOLOGY_PROJECT_RULES, PROJECT_RULES } from "../../storage/content-project.js";
import { listContents } from "../../storage/local-store.js";
import { DERIVE_VERSION, isOntologyEnabled, productionServiceDir, readEnabledMarker, writeEnabledVersion } from "../../storage/production-store.js";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { withLegacyDecisions } from "./explain.js";
import { importLegacyRegistration } from "./legacy.js";
import { withFileOwnership } from "./mutex.js";
import { reconcileAll, type ReconcileReport } from "./reconcile.js";
import { mutateProduction, refreshContent } from "./service.js";

export interface EnableFailure { id: string; title: string; step: "对账" | "迁移" | "投影"; error: string }
export interface EnableResult { ok: boolean; version: number; report: ReconcileReport | null; failures: EnableFailure[]; excluded: string[]; errors: string[] }
interface EnableTxn { state: "running"; startedAt: string; exclude: string[] }

const txnFile = (dataDir: string) => productionServiceDir(dataDir, "enable-txn.json");

export async function readEnableTxn(dataDir: string): Promise<EnableTxn | null> {
  try { return JSON.parse(await fs.readFile(txnFile(dataDir), "utf8")) as EnableTxn; } catch { return null; }
}

export async function ontologyStatus(dataDir: string) {
  const m = await readEnabledMarker(dataDir);
  return { enabled: await isOntologyEnabled(dataDir), version: m?.version ?? null, target: DERIVE_VERSION, excluded: m?.excluded ?? [], pending: Boolean(await readEnableTxn(dataDir)) };
}

async function materializeLegacy(dataDir: string, skip: ReadonlySet<string>, failures: EnableFailure[]): Promise<void> {
  for (const c of await listContents(dataDir)) {
    if (!isVideoPlatform(c.platform) || c.deletedAt || c.status === "archived" || skip.has(c.id)) continue;
    try {
      await mutateProduction(c.id, dataDir, async (d, content) => {
        const at = new Date().toISOString();
        const w = withLegacyDecisions(d, content, at, await importLegacyRegistration(content, d.round, dataDir, at));
        const added = w.decisions.length - d.decisions.length + w.registrations.length - d.registrations.length;
        Object.assign(d, { facts: w.facts, decisions: w.decisions, registrations: w.registrations });
        return { value: added, events: added ? [{ type: "legacy_migrated", detail: { status: content.status, added } }] : [] };
      });
    } catch (e) { failures.push({ id: c.id, title: c.title, step: "迁移", error: e instanceof Error ? e.message : String(e) }); }
  }
}

async function projectAll(dataDir: string, skip: ReadonlySet<string>, failures: EnableFailure[]): Promise<void> {
  for (const c of await listContents(dataDir)) {
    if (!isVideoPlatform(c.platform) || c.deletedAt || skip.has(c.id)) continue;
    await refreshContent(c.id, dataDir, { force: true })
      .catch((e: unknown) => failures.push({ id: c.id, title: c.title, step: "投影", error: e instanceof Error ? e.message : String(e) }));
  }
}

/** 项目 AGENTS.md 改成一行指向（§8）：只替换没被手改过的旧约定；替换失败不挡启用，照实记日志 */
async function pointProjectRules(dataDir: string, skip: ReadonlySet<string>): Promise<void> {
  for (const c of await listContents(dataDir)) {
    if (!isVideoPlatform(c.platform) || skip.has(c.id)) continue;
    const file = path.join(contentRoot(c.id, dataDir), "AGENTS.md");
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (text === PROJECT_RULES) await fs.writeFile(file, ONTOLOGY_PROJECT_RULES).catch((e: unknown) => console.warn(`[production] ${c.id} 的 AGENTS.md 没改成指向：${e instanceof Error ? e.message : String(e)}`));
  }
}

async function run(dataDir: string, exclude: string[]): Promise<EnableResult> {
  const skip = new Set(exclude);
  const failures: EnableFailure[] = [];
  const done = (ok: boolean, report: ReconcileReport | null): EnableResult =>
    ({ ok, version: DERIVE_VERSION, report, failures, excluded: exclude, errors: failures.map((f) => `${f.title}（${f.id}）${f.step}失败：${f.error}`) });
  await writeJsonAtomicMkdir(txnFile(dataDir), { state: "running", startedAt: new Date().toISOString(), exclude } satisfies EnableTxn);
  const report = await reconcileAll(dataDir, { write: true, exclude: skip });
  failures.push(...report.errors.map((e) => ({ id: e.id, title: e.title, step: "对账" as const, error: e.error })));
  if (!failures.length) await materializeLegacy(dataDir, skip, failures);
  if (!failures.length) await projectAll(dataDir, skip, failures);
  if (failures.length) {
    // 干净地失败：开关没写，日志删掉（不自动续跑），失败清单交给创始人决定排除哪几条再试
    await fs.rm(txnFile(dataDir), { force: true });
    return done(false, report);
  }
  await writeEnabledVersion(dataDir, DERIVE_VERSION, exclude);
  await pointProjectRules(dataDir, skip);
  await fs.rm(txnFile(dataDir), { force: true });
  return done(true, report);
}

/** 创始人确认启用；exclude = 创始人看过失败清单后明确排除的稿 */
export async function enableOntology(dataDir: string, opts: { exclude?: string[] } = {}): Promise<EnableResult> {
  return withFileOwnership(() => run(dataDir, [...new Set(opts.exclude ?? [])]));
}

/** 启动时续跑中断的启用事务（同一份排除清单）；没有就什么都不做 */
export async function resumeEnable(dataDir: string): Promise<EnableResult | null> {
  const txn = await readEnableTxn(dataDir);
  if (!txn || (await isOntologyEnabled(dataDir))) {
    if (txn) await fs.rm(txnFile(dataDir), { force: true });
    return null;
  }
  return enableOntology(dataDir, { exclude: txn.exclude });
}
