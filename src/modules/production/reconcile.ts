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
import { isOntologyEnabled, productionServiceDir, readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { Fact, ProductionDoc } from "../../storage/production-types.js";
import { writeJsonAtomicMkdir } from "../../storage/json-atomic.js";
import { readArchiveLog } from "../../storage/nas-archive-log.js";
import { isVideoPlatform } from "../../storage/stage-guard.js";
import { exportMatchesTitle } from "../video/unregistered-cut.js";
import { explain, withLegacyDecisions, type Column } from "./explain.js";
import { STABLE_MS } from "./files.js";
import { withFileOwnership } from "./mutex.js";
import { applyObservations, cachedSha, observeProject, VIDEO_EXT, type Observations, type Seen } from "./observe.js";
import { publishEvidenceOf } from "./read.js";
import { movableRoots, now } from "./roots.js";
import { ensureProductionReady, mutateProduction } from "./service.js";
import { shaIndex } from "./sha-index.js";

export interface ExternalFile { file: string; name: string; from: "inbox" | "export"; sha256: string; size: number; mtime_ms: number }
export interface ShadowMove { id: string; title: string; from: Column | null; to: Column | null; rule: string | null; evidence: string[] }
export interface ReconcileReport { at: string; enabled: boolean; errors: Array<{ id: string; title: string; error: string }>; moves: ShadowMove[]; warnings: string[] }

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
  const preview = structuredClone(doc);
  const { changed } = applyObservations(preview, obs, owned);
  if (!opts.write || !changed) return preview;
  const r = await mutateProduction(content.id, dataDir, (d) => {
    const { added, changed: n } = applyObservations(d, obs, owned);
    return { value: n, events: added.map((f) => ({ type: "fact_imported", detail: { fact_id: f.id, kind: f.kind, state: f.state, source: f.source, evidence: f.evidence } })) };
  });
  return r.doc;
}

async function shadowMove(content: Content, doc: ProductionDoc, dataDir: string): Promise<ShadowMove | null> {
  const publish = await publishEvidenceOf(content, dataDir);
  const legacy = explain({ content, doc, enabled: false, publish });
  const derived = explain({ content, doc: withLegacyDecisions(doc, content), enabled: true, publish });
  if (legacy.column === derived.column) return null;
  return { id: content.id, title: content.title, from: legacy.column, to: derived.column, rule: derived.rule, evidence: [...derived.evidence, ...derived.badges] };
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

/** 全库对账：已启用 → 落盘；未启用 → 只算影子差异。报告落在工作区服务目录（不是制作真相） */
export async function reconcileAll(dataDir: string, opts: { write?: boolean } = {}): Promise<ReconcileReport> {
  await ensureProductionReady(dataDir);
  const enabled = await isOntologyEnabled(dataDir);
  const write = opts.write ?? enabled;
  const report: ReconcileReport = { at: new Date().toISOString(), enabled, errors: [], moves: [], warnings: [] };
  await withFileOwnership(async () => {
    const externals = await listExternal(dataDir, report.warnings);
    const archived = new Set((await readArchiveLog(dataDir).catch(() => [])).map((e) => e.contentId));
    for (const c of await listContents(dataDir)) {
      if (c.deletedAt) continue;
      try {
        await syncSubmitted(c, dataDir, enabled);
        if (!isVideoPlatform(c.platform)) continue;
        const doc = await reconcileOne(c, dataDir, { write, externals, archived });
        const move = enabled ? null : await shadowMove(c, doc, dataDir);
        if (move) report.moves.push(move);
      } catch (e) {
        report.errors.push({ id: c.id, title: c.title, error: e instanceof Error ? e.message : String(e) });
      }
    }
  });
  await writeJsonAtomicMkdir(reportFile(dataDir), report);
  return report;
}

/** content get / record 后的本条快扫：只看项目内，不看外部目录；只在启用后写 */
export async function reconcileContent(contentId: string, dataDir: string): Promise<void> {
  if (!(await isOntologyEnabled(dataDir))) return;
  await ensureProductionReady(dataDir);
  await withFileOwnership(async () => {
    const c = await getContent(contentId, dataDir);
    if (!c || c.deletedAt || !isVideoPlatform(c.platform)) return;
    const archived = new Set((await readArchiveLog(dataDir).catch(() => [])).map((e) => e.contentId));
    await reconcileOne(c, dataDir, { write: true, externals: null, archived });
  });
}
