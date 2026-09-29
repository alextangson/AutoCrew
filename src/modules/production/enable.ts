/**
 * 启用本体（spec §4.1）：每个资料库持久化「本体已启用版本」。未启用时新模型只算影子结果，
 * 看板顶部给差异清单，创始人确认后原子启用：
 *   恢复未完成事务 → 对账落盘（导入项目内与旧存法事实）→ 按旧状态补等价决定（legacy 认稿 / 我发了 / 登记）
 *   → 写启用版本（读方从这一刻起切到推导）→ 逐条投影 status 并冻结。
 * 启用版本最后才写：中途失败 = 仍是影子模式，重跑幂等。
 */
import { listContents } from "../../storage/local-store.js";
import { DERIVE_VERSION, isOntologyEnabled, readEnabledVersion, writeEnabledVersion } from "../../storage/production-store.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { withLegacyDecisions } from "./explain.js";
import { withFileOwnership } from "./mutex.js";
import { reconcileAll, type ReconcileReport } from "./reconcile.js";
import { ensureProductionReady, mutateProduction, refreshContent } from "./service.js";

export interface EnableResult { ok: boolean; version: number; report: ReconcileReport; errors: string[] }

export async function ontologyStatus(dataDir: string): Promise<{ enabled: boolean; version: number | null; target: number }> {
  return { enabled: await isOntologyEnabled(dataDir), version: await readEnabledVersion(dataDir), target: DERIVE_VERSION };
}

async function materializeLegacy(dataDir: string, errors: string[]): Promise<void> {
  for (const c of await listContents(dataDir)) {
    if (!isVideoPlatform(c.platform) || c.deletedAt || c.status === "archived") continue;
    try {
      await mutateProduction(c.id, dataDir, (d, content) => {
        const w = withLegacyDecisions(d, content, new Date().toISOString());
        const added = w.decisions.length - d.decisions.length + w.registrations.length - d.registrations.length;
        d.decisions = w.decisions;
        d.registrations = w.registrations;
        return { value: added, events: added ? [{ type: "legacy_migrated", detail: { status: content.status, added } }] : [] };
      });
    } catch (e) { errors.push(`${c.title}（${c.id}）：迁移失败 ${e instanceof Error ? e.message : String(e)}`); }
  }
}

export async function enableOntology(dataDir: string): Promise<EnableResult> {
  await ensureProductionReady(dataDir);
  return withFileOwnership(async () => {
    const errors: string[] = [];
    const report = await reconcileAll(dataDir, { write: true });
    errors.push(...report.errors.map((e) => `${e.title}（${e.id}）：${e.error}`));
    await materializeLegacy(dataDir, errors);
    if (errors.length) return { ok: false, version: DERIVE_VERSION, report, errors };
    await writeEnabledVersion(dataDir);
    for (const c of await listContents(dataDir)) {
      if (!isVideoPlatform(c.platform) || c.deletedAt) continue;
      await refreshContent(c.id, dataDir).catch((e: unknown) => errors.push(`${c.title}（${c.id}）：投影失败 ${e instanceof Error ? e.message : String(e)}`));
    }
    return { ok: errors.length === 0, version: DERIVE_VERSION, report, errors };
  });
}
