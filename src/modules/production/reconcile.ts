/**
 * 对账（spec §4；手动收件 spec 2026-10-06）：服务内单一入口，和所有写路径同属 ProductionService、同排文件归属事务。
 *
 * - 触发：启动一次 + 每 30 分钟（安全巡检，先对账再排「我的内容」）；对话里「同步一下」立即跑一次（sweep.ts，单飞）；
 *   record 后本条；content get 前本条（只做项目内快扫）。看板读取不调这里、不写。
 * - 只看项目文件夹（换掉 / 删掉的文件、登记）：收件箱、下载、ChatCut / 剪映导出目录一律不扫——原片由创始人在对话里说是哪条，
 *   成片由 agent record。
 * - 逐条隔离：每条 try/catch，失败汇总进报告（看板顶部 + 晨报 warnings）。
 * - 影子模式（未启用）：只算不写，报告里给「要挪 N 张卡」的差异清单。
 */
import { isImportedHistory } from "../../storage/imported-history.js";
import fs from "node:fs/promises";
import { getContent, listContents, transitionStatus, type Content } from "../../storage/local-store.js";
import { anySubmitted, firstPublishTime, readPublishRecord } from "../../storage/publish-record.js";
import { contentRoot } from "../../storage/content-project.js";
import { DERIVE_VERSION, isOntologyActive, productionServiceDir, readEnabledMarker, readProductionDocOrEmpty } from "../../storage/production-store.js";
import { importLegacyRegistration } from "./legacy.js";
import { importObservations, trustedObservations } from "./receipts.js";
import { isUngated } from "./publish-check-link.js";
import { commitRegistration } from "./registration.js";
import type { ProductionDoc } from "../../storage/production-types.js";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import { readArchiveLog } from "../../storage/nas-archive-log.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { triggerSliverCheck } from "./sliver/check.js";
import { explain, withLegacyDecisions, type Column } from "./explain.js";
import { withFileOwnership } from "./mutex.js";
import { migrateCoverGroups } from "./cover-groups.js";
import { validCoverApproval } from "./derive.js";

/** 当前有效封面批准的两张 sha（迁移时它们不动） */
function approvedCoverShas(doc: ProductionDoc, content: Content): Set<string> {
  const d = validCoverApproval(doc, content.body ?? "");
  return new Set([d?.cover_3x4_sha, d?.cover_4x3_sha].filter((x): x is string => Boolean(x)));
}
import { loadHashCache, saveHashCache, sweepHashCache } from "./hash-cache.js";
import { applyObservations, observeProject, type Observations } from "./observe.js";
import { publishEvidenceOf } from "./read.js";
import { ensureProductionReady, mutateProduction, refreshContent } from "./service.js";
import { shaIndex } from "./sha-index.js";
import "./legacy-discovery.js";

export interface ShadowMove { id: string; title: string; from: Column | null; to: Column | null; rule: string | null; evidence: string[] }
/** 旧报告里还可能有 inbox / watch（自动找原片时代）：读方不再看它们，留在盘上不碍事 */
export interface ReconcileReport {
  at: string; enabled: boolean; errors: Array<{ id: string; title: string; error: string }>; moves: ShadowMove[]; warnings: string[];
}

async function observe(content: Content, doc: ProductionDoc, dataDir: string, archived: Set<string>): Promise<Observations> {
  return observeProject(content, doc, await fs.realpath(contentRoot(content.id, dataDir)), dataDir, archived.has(content.id));
}

async function ownedElsewhere(dataDir: string, contentId: string): Promise<(sha: string) => boolean> {
  const idx = await shaIndex(dataDir);
  return (sha) => (idx.entries[sha] ?? []).some((e) => e.content_id !== contentId && e.kind === "aroll" && e.state === "accepted");
}

/** 单条对账：写模式经 ProductionService 落盘；影子模式返回合并后的内存 doc */
export async function reconcileOne(content: Content, dataDir: string, opts: { write: boolean; archived: Set<string>; warnings?: string[] }): Promise<ProductionDoc> {
  const doc = await readProductionDocOrEmpty(content.id, dataDir);
  if (isImportedHistory(content)) return doc;
  const obs = await observe(content, doc, dataDir, opts.archived);
  for (const w of obs.warnings ?? []) opts.warnings?.push(`${content.title}（${content.id}）：${w}`);
  const owned = await ownedElsewhere(dataDir, content.id);
  const receipts = opts.write ? await trustedObservations(content, dataDir) : [];
  const preview = structuredClone(doc);
  const approved = approvedCoverShas(preview, content);
  const changed = migrateCoverGroups(preview, approved).length + (doc.cover_schema === 1 ? 0 : 1) + applyObservations(preview, obs, owned).changed + importObservations(preview, receipts);
  if (!opts.write) return preview;
  if (!changed) {
    // 事实没变也补一次投影（认稿之类在别处落的决定，保证 status 与冻结跟上推导）
    await refreshContent(content.id, dataDir);
    return preview;
  }
  const r = await mutateProduction(content.id, dataDir, (d) => {
    // §6.2 迁移只改标签：不在 vNNN/ final/、又不属于有效批准的正式封面转候选并写原因；文件不动
    const { added, changed: n } = applyObservations(d, obs, owned);
    const before = d.facts.length;
    importObservations(d, receipts);
    // 新写入的可信发布观察：没把关 / 有原话例外都进时间线（发布审查闸门 §11）
    const gateEvents = d.facts.slice(before).filter((f) => f.gate).flatMap((f) => [
      ...(!isUngated(f.gate) ? [] : [{ type: "publish_ungated", detail: { fact_id: f.id, platform: f.platform, note: `发布前未把关：${f.gate!.note ?? ""}` } }]),
      ...f.gate!.overrides.map((q) => ({ type: "publish_override", detail: { fact_id: f.id, platform: f.platform, note: `发布前例外：『${q}』`, check_id: f.gate!.check_id } })),
    ]);
    return { value: n, events: [...added.map((f) => ({ type: "fact_imported", detail: { fact_id: f.id, kind: f.kind, state: f.state, source: f.source, evidence: f.evidence } })), ...gateEvents] };
  });
  return r.doc;
}

async function shadowMove(content: Content, doc: ProductionDoc, dataDir: string): Promise<ShadowMove | null> {
  const publish = await publishEvidenceOf(content, dataDir, undefined, doc.round_started_at);
  const legacy = explain({ content, doc, enabled: false, publish });
  const imported = await importLegacyRegistration(content, doc.round, dataDir, "1970-01-01T00:00:00.000Z", { cached: true });
  const derived = explain({ content, doc: withLegacyDecisions(doc, content, undefined, imported), enabled: true, publish });
  if (legacy.column === derived.column) return null;
  const why = imported.reason && content.video?.final ? [`旧登记没迁移：${imported.reason}`] : [];
  // 给创始人看的依据一律人话（平台中文名、原因句），规则代码只留在 rule 字段
  return { id: content.id, title: content.title, from: legacy.column, to: derived.column, rule: derived.rule,
    evidence: [derived.reason, ...derived.alerts, ...why].filter(Boolean) };
}

/**
 * 发布记录已投出的待发布稿 → 已发布（原看板 GET 里的 syncPublished，§4 看板读零写入后搬到对账循环）。
 * 图文一直走这里；视频稿启用本体后由推导投影，影子模式下照旧走这里。
 */
async function syncSubmitted(c: Content, dataDir: string, enabled: boolean): Promise<void> {
  if ((c.status !== "publish_ready" && c.status !== "publishing") || (enabled && isVideoPlatform(c.platform))) return;
  const record = await readPublishRecord(c.id, c.manualPublications, dataDir);
  if (!anySubmitted(record)) return;
  const at = firstPublishTime(record);
  const r = await transitionStatus(c.id, "published", { force: true, expectedStatus: c.status, ...(at ? { patch: { publishedAt: at } } : {}) }, dataDir);
  if (!r.ok) throw new Error(`发布记录已投出，但同步成已发布失败：${r.error}`);
}

export function reportFile(dataDir: string): string {
  return productionServiceDir(dataDir, "reconcile-report.json");
}

export async function readReconcileReport(dataDir: string): Promise<ReconcileReport | null> {
  try { return JSON.parse(await fs.readFile(reportFile(dataDir), "utf8")) as ReconcileReport; } catch { return null; }
}

/**
 * 全库对账：按本体走的稿 → 落盘；影子模式 / 启用时被排除的稿 → 只算（被排除的不进「要挪」清单，卡上另有标记）。
 * `write` 只给启用事务用：把尚未启用的库里、未被排除的稿都落盘。报告落在工作区服务目录（不是制作真相）。
 */
export async function reconcileAll(dataDir: string, opts: { write?: boolean; exclude?: ReadonlySet<string> } = {}): Promise<ReconcileReport> {
  const started = await ensureProductionReady(dataDir);
  const marker = await readEnabledMarker(dataDir);
  const enabled = marker?.version === DERIVE_VERSION;
  const excluded = new Set([...(marker?.excluded ?? []), ...(opts.exclude ?? [])]);
  const report: ReconcileReport = { at: new Date().toISOString(), enabled, errors: [], moves: [], warnings: [] };
  for (const e of started.hookErrors ?? []) report.warnings.push(`启动收尾没做完：${e}`);
  await loadHashCache(dataDir);
  await withFileOwnership(async () => {
    const archived = new Set((await readArchiveLog(dataDir).catch(() => [])).map((e) => e.contentId));
    for (const c of await listContents(dataDir)) {
      // 历史作品记录只挂回流数据，不进制作对账（回流认领规格 2026-10-03）
      if (c.deletedAt || isImportedHistory(c)) continue;
      const active = !excluded.has(c.id) && (opts.write ?? enabled);
      try {
        await syncSubmitted(c, dataDir, enabled && !excluded.has(c.id));
        if (!isVideoPlatform(c.platform)) continue;
        let doc = await reconcileOne(c, dataDir, { write: active, archived, warnings: report.warnings });
        if (active && enabled) {
          const commit = await commitRegistration(c.id, dataDir, { backoff: true });
          if (commit.ok && commit.registration) doc = await readProductionDocOrEmpty(c.id, dataDir);
          // 登记失败 / 警告进对账报告（看板顶部 + 晨报），不静默
          if (!commit.ok) report.warnings.push(`${c.title}（${c.id}）登记没完成：${commit.reason}`);
          for (const w of commit.ok ? commit.warnings ?? [] : []) report.warnings.push(`${c.title}（${c.id}）：${w}`);
          // 对账发现新成片 / 新工程记录后跑抽帧检查（同指纹的确定结果只算一次）
          const sliverErr = await triggerSliverCheck(c.id, dataDir);
          if (sliverErr) report.warnings.push(`${c.title}（${c.id}）：${sliverErr}`);
        }
        const move = enabled || excluded.has(c.id) ? null : await shadowMove(c, doc, dataDir);
        if (move) report.moves.push(move);
      } catch (e) {
        report.errors.push({ id: c.id, title: c.title, error: e instanceof Error ? e.message : String(e) });
      }
    }
  });
  await sweepHashCache().catch(() => 0);
  await saveHashCache(dataDir).catch((e: unknown) => report.warnings.push(`哈希缓存没存上：${e instanceof Error ? e.message : String(e)}`));
  await writeJsonAtomicMkdir(reportFile(dataDir), report);
  return report;
}

/** content get / record 后的本条快扫：只看项目内；只在启用后写 */
export async function reconcileContent(contentId: string, dataDir: string): Promise<void> {
  if (!(await isOntologyActive(dataDir, contentId))) return;
  await ensureProductionReady(dataDir);
  await withFileOwnership(async () => {
    const c = await getContent(contentId, dataDir);
    if (!c || c.deletedAt || isImportedHistory(c) || !isVideoPlatform(c.platform)) return;
    const archived = new Set((await readArchiveLog(dataDir).catch(() => [])).map((e) => e.contentId));
    await reconcileOne(c, dataDir, { write: true, archived });
  });
}
