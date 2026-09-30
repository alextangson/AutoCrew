/**
 * 对账（spec §4）：服务内单一入口，和所有写路径同属 ProductionService、同排文件归属事务。
 *
 * - 触发：60 秒循环（先对账再排「我的内容」）；record 后本条；content get 前本条（只做项目内快扫）。
 *   看板读取不调这里、不写。
 * - 项目内与旧存法 → accepted；外部新文件（收件箱、ChatCut / 剪映导出）按文件名前缀对上标题（unregistered-cut 规则）→ 候选：
 *   认稿前后的稿首次归属；剪辑中以后的稿是新版本，已发布的标 post_publish。
 * - 逐条隔离：每条 try/catch，失败汇总进报告（看板顶部 + 晨报 warnings）。
 * - 影子模式（未启用）：只算不写，报告里给「要挪 N 张卡」的差异清单。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getContent, listContents, transitionStatus, type Content } from "../../storage/local-store.js";
import { anySubmitted, firstPublishTime, readPublishRecord } from "../../storage/publish-record.js";
import { contentRoot } from "../../storage/content-project.js";
import { DERIVE_VERSION, isOntologyActive, productionServiceDir, readEnabledMarker, readProductionDocOrEmpty } from "../../storage/production-store.js";
import { importLegacyRegistration } from "./legacy.js";
import { importObservations, trustedObservations } from "./receipts.js";
import { isUngated } from "./publish-check-link.js";
import { commitRegistration } from "./registration.js";
import type { Fact, ProductionDoc } from "../../storage/production-types.js";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import { readArchiveLog } from "../../storage/nas-archive-log.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { exportMatchesTitle } from "../video/unregistered-cut.js";
import { triggerSliverCheck } from "./sliver/check.js";
import { explain, withLegacyDecisions, type Column } from "./explain.js";
import { STABLE_MS } from "./files.js";
import { withFileOwnership } from "./mutex.js";
import { applyObservations, cachedSha, loadHashCache, observeProject, saveHashCache, VIDEO_EXT, type Observations, type Seen } from "./observe.js";
import { publishEvidenceOf } from "./read.js";
import { movableRoots, now } from "./roots.js";
import { ensureProductionReady, mutateProduction, refreshContent } from "./service.js";
import { shaIndex } from "./sha-index.js";
import { matchWorkerError } from "./match/queue.js";

export interface ExternalFile { file: string; name: string; from: "inbox" | "export"; sha256: string; size: number; mtime_ms: number }
export interface ShadowMove { id: string; title: string; from: Column | null; to: Column | null; rule: string | null; evidence: string[] }
/** 1b §4 / §5：收件箱里没对上 / 没核对成的视频（待录制列头读它）、每个监视文件夹最近一次扫描 */
export interface InboxFileView { name: string; path: string; size: number; mtime_ms: number; guess: string[] }
export interface InboxStatus { unmatched: InboxFileView[]; failed: Array<{ name: string; path: string; reason: string }>; checking: number }
export interface WatchStatus { path: string; at: string; error?: string; files: number; suggested: number }
export interface ReconcileReport {
  at: string; enabled: boolean; errors: Array<{ id: string; title: string; error: string }>; moves: ShadowMove[]; warnings: string[];
  inbox?: InboxStatus; watch?: WatchStatus[];
}

const FIRST_ATTRIBUTION = new Set(["draft_ready", "approved"]);
const BOUND = new Set(["editing", "cover_pending", "publish_ready", "publishing", "published"]);

/** 外部目录顶层的视频文件（还在写的跳过）；读不了的目录进 warnings */
export async function listExternal(dataDir: string, warnings: string[]): Promise<ExternalFile[]> {
  const roots = await movableRoots(dataDir);
  const dirs: Array<[string | null, ExternalFile["from"]]> = [[roots.inbox, "inbox"], [roots.chatcut, "export"], [roots.jianying, "export"]];
  const out: ExternalFile[] = [];
  for (const [dir, from] of dirs) {
    if (!dir) continue;
    let names: string[];
    try { names = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name); }
    catch (e) { warnings.push(`读不了 ${dir}（${(e as NodeJS.ErrnoException).code ?? "?"}）`); continue; }
    for (const name of names.filter((n) => VIDEO_EXT.has(path.extname(n).toLowerCase()))) {
      const file = path.join(dir, name);
      const h = await cachedSha(file).catch(() => null);
      if (h && now() - h.mtime_ms >= STABLE_MS) out.push({ file, name, from, ...h });
    }
  }
  return out;
}

/** 外部文件 → 这条的候选（只看文件名前缀；不宣称「明显赢家」，候选最多列三个由 explain 截） */
function externalSeen(content: Content, externals: ExternalFile[]): Seen[] {
  const first = FIRST_ATTRIBUTION.has(content.status), bound = BOUND.has(content.status);
  if (!first && !bound) return [];
  return externals.filter((x) => exportMatchesTitle(x.name, content.title) && (first || x.from === "export")).map((x) => ({
    kind: (x.from === "inbox" ? "aroll" : "cut") as Fact["kind"], state: "candidate" as const, source: "reconcile" as const,
    evidence: `文件名前缀对上标题（${x.from === "inbox" ? "原片收件箱" : "剪辑软件导出"}）`, path: x.file,
    sha256: x.sha256, size: x.size, mtime_ms: x.mtime_ms, ...(content.status === "published" ? { post_publish: true as const } : {}),
  }));
}

async function observe(content: Content, doc: ProductionDoc, dataDir: string, externals: ExternalFile[] | null, archived: Set<string>): Promise<Observations> {
  const obs = await observeProject(content, doc, await fs.realpath(contentRoot(content.id, dataDir)), dataDir, archived.has(content.id));
  if (externals) obs.seen.push(...externalSeen(content, externals));
  return obs;
}

async function ownedElsewhere(dataDir: string, contentId: string): Promise<(sha: string) => boolean> {
  const idx = await shaIndex(dataDir);
  return (sha) => (idx.entries[sha] ?? []).some((e) => e.content_id !== contentId && e.kind === "aroll" && e.state === "accepted");
}

/** 单条对账：写模式经 ProductionService 落盘；影子模式返回合并后的内存 doc */
export async function reconcileOne(content: Content, dataDir: string, opts: { write: boolean; externals: ExternalFile[] | null; archived: Set<string> }): Promise<ProductionDoc> {
  const doc = await readProductionDocOrEmpty(content.id, dataDir);
  const obs = await observe(content, doc, dataDir, opts.externals, opts.archived);
  const owned = await ownedElsewhere(dataDir, content.id);
  const receipts = opts.write ? await trustedObservations(content, dataDir) : [];
  const preview = structuredClone(doc);
  const changed = applyObservations(preview, obs, owned).changed + importObservations(preview, receipts);
  if (!opts.write) return preview;
  if (!changed) {
    // 事实没变也补一次投影（认稿之类在别处落的决定，保证 status 与冻结跟上推导）
    await refreshContent(content.id, dataDir);
    return preview;
  }
  const r = await mutateProduction(content.id, dataDir, (d) => {
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
  const imported = await importLegacyRegistration(content, doc.round, dataDir, "1970-01-01T00:00:00.000Z");
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
  // 原片核对的重新入队 / 工人出错：看板顶部与晨报要看得见（1b §2）
  for (const e of started.hookErrors ?? []) report.warnings.push(`原片核对没能重新排队：${e}`);
  const workerError = matchWorkerError(dataDir);
  if (workerError) report.warnings.push(`原片核对工人出错：${workerError}`);
  await loadHashCache(dataDir);
  await withFileOwnership(async () => {
    const externals = await listExternal(dataDir, report.warnings);
    const archived = new Set((await readArchiveLog(dataDir).catch(() => [])).map((e) => e.contentId));
    for (const c of await listContents(dataDir)) {
      if (c.deletedAt) continue;
      const active = !excluded.has(c.id) && (opts.write ?? enabled);
      try {
        await syncSubmitted(c, dataDir, enabled && !excluded.has(c.id));
        if (!isVideoPlatform(c.platform)) continue;
        let doc = await reconcileOne(c, dataDir, { write: active, externals, archived });
        if (active && enabled) {
          const commit = await commitRegistration(c.id, dataDir);
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
  await saveHashCache(dataDir).catch((e: unknown) => report.warnings.push(`哈希缓存没存上：${e instanceof Error ? e.message : String(e)}`));
  await writeJsonAtomicMkdir(reportFile(dataDir), report);
  return report;
}

/** content get / record 后的本条快扫：只看项目内，不看外部目录；只在启用后写 */
export async function reconcileContent(contentId: string, dataDir: string): Promise<void> {
  if (!(await isOntologyActive(dataDir, contentId))) return;
  await ensureProductionReady(dataDir);
  await withFileOwnership(async () => {
    const c = await getContent(contentId, dataDir);
    if (!c || c.deletedAt || !isVideoPlatform(c.platform)) return;
    const archived = new Set((await readArchiveLog(dataDir).catch(() => [])).map((e) => e.contentId));
    await reconcileOne(c, dataDir, { write: true, externals: null, archived });
  });
}
