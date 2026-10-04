/**
 * 一次性回填（docs/2026-10-04-old-works-nas-backfill-spec.md + 创始人裁定 2026-10-04）：
 * A. 新建 3 条 8 月历史记录（四个平台：视频号 / 小红书按作品 id 绑定，抖音 / B 站按 标题@日期 认领）；
 * B. 6 行 B 站无编号数据认领到已有历史记录；
 * C. 6 条历史记录挂 NAS 旧资料库的存档原稿（只读复制 draft.md）。
 *
 * 默认 dry-run 只打印；--apply 先领资料库写入锁、备份再写。NAS 没挂载 → 停下，什么都不写。
 * 计划有任何问题（找不到行 / 有歧义 / 已归属别的稿）→ 一行都不写。重复执行幂等。
 *
 * 用法：npx tsx scripts/backfill-old-works-20261004.mts [数据目录] [--apply] [--nas=<旧资料库 contents 目录>]
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDataDir, listContents, type Content } from "../src/storage/local-store.js";
import { latestByKey } from "../src/modules/flywheel/outcome-store.js";
import { readPlatformItemsStrict, platformItemKey, type PlatformItemBinding } from "../src/modules/flywheel/platform-items.js";
import { isTruncatedItemId, normalizeTitle, shanghaiDate, type PerformanceOutcome } from "../src/modules/flywheel/outcome-schema.js";
import { createHistoryRecord } from "../src/modules/flywheel/work-binding.js";
import { claimWorkByTitle, readClaimsStrict, claimKey, type WorkClaim } from "../src/modules/flywheel/work-claims.js";
import { readArchiveSource, attachArchiveDraft, type ArchiveRead } from "../src/modules/flywheel/archive-draft.js";
import { isImportedHistory } from "../src/storage/imported-history.js";
import { acquireLibraryLock } from "../src/storage/library-lock.js";

export const DEFAULT_NAS = "/Volumes/MacMiniData/01_Lawrence/Account/_旧资料库-20260926/workspaces/default/contents";

/** 一组行：平台 + 北京发布日 + 平台标题前缀（归一化后比） */
export interface RowSpec { platform: string; date: string; title: string }
const R = (platform: string, date: string, title: string): RowSpec => ({ platform, date, title });

export interface RecordSpec {
  title: string; date: string; create: boolean;
  /** 带作品 id 的行 → work_bind（建记录时挂上） */
  idItems: RowSpec[];
  /** 无编号行 → work_claim */
  claims: RowSpec[];
  archive?: { oldId: string; inferred: boolean };
}

export const RECORDS: RecordSpec[] = [
  // 表 A：8 月三条，四个平台
  { title: "一起搞懂Agent Harness", date: "2026-08-22", create: true,
    idItems: [R("wechat_video", "2026-08-22", "一起搞懂Agent Harness"), R("xiaohongshu", "2026-08-22", "一起搞懂Agent Harness")],
    // B 站这条的发布日是 08-25（晚于其他平台），按行上的日期认
    claims: [R("douyin", "2026-08-22", "一起搞懂Agent Harness"), R("bilibili", "2026-08-25", "一起搞懂Agent Harness")],
    archive: { oldId: "18yfm1", inferred: false } },
  { title: "DeepSeek Harness终于可以远程指挥AI干活了", date: "2026-08-25", create: true,
    idItems: [R("wechat_video", "2026-08-25", "DeepSeek Harness"), R("xiaohongshu", "2026-08-25", "DeepSeek Harness")],
    claims: [R("douyin", "2026-08-25", "DeepSeek Harness"), R("bilibili", "2026-08-25", "DeepSeek Harness")],
    archive: { oldId: "acguqh", inferred: false } },
  { title: "我招了 10 个 AI 员工，后来开掉了 6 个", date: "2026-08-31", create: true,
    idItems: [R("wechat_video", "2026-08-31", "我招了 10 个 AI 员工"), R("xiaohongshu", "2026-08-31", "我招了 10 个 AI 员工")],
    claims: [R("douyin", "2026-08-31", "我招了 10 个 AI 员工"), R("bilibili", "2026-08-31", "我招了 10 个 AI 员工")] },
  // 表 B + C：已有历史记录
  { title: "让Agent帮你买东西，以后可能轮不到你挑了", date: "2026-09-04", create: false, idItems: [],
    claims: [R("bilibili", "2026-09-04", "如果Agent替你买东西")], archive: { oldId: "n36s7w", inferred: false } },
  { title: "别再收藏提示词了！这 7 条才让 AI 真变强", date: "2026-09-09", create: false, idItems: [],
    claims: [R("bilibili", "2026-09-09", "别再收藏提示词了")] },
  { title: "AI入职四件套｜MCP、Skills、RAG、Memory", date: "2026-09-11", create: false, idItems: [],
    claims: [R("bilibili", "2026-09-11", "AI入职四件套")], archive: { oldId: "b45gxi", inferred: true } },
  { title: "ChatGPT Image 2.5 实测，实现指哪改哪？", date: "2026-09-14", create: false, idItems: [],
    claims: [R("bilibili", "2026-09-14", "ChatGPT Image 2.5 实测")] },
  { title: "AI给自己造了个身体，接管了我家的全屋智能", date: "2026-09-16", create: false, idItems: [],
    claims: [R("bilibili", "2026-09-16", "AI给自己造了个身体")], archive: { oldId: "pjv94o", inferred: false } },
  { title: "什么时候该用 Jev，什么时候该用大模型？", date: "2026-09-24", create: false, idItems: [],
    claims: [R("bilibili", "2026-09-24", "什么时候该用 Jev")] },
  { title: "谁AI上班｜8个让AI替我上班的实用工具", date: "2026-09-28", create: false, idItems: [], claims: [],
    archive: { oldId: "1v12vp", inferred: false } },
];

export type Status = "new" | "already" | "conflict";
export interface PlannedId { spec: RowSpec; itemId: string; rowTitle: string; status: Status; owner?: string }
export interface PlannedClaim { spec: RowSpec; rowTitle: string; status: Status; owner?: string }
export interface PlannedArchive { oldId: string; inferred: boolean; dir: string | null; read: ArchiveRead | null; status: "attach" | "already" | "skip"; note?: string }
export interface PlannedRecord { spec: RecordSpec; existingId: string | null; ids: PlannedId[]; claims: PlannedClaim[]; archive: PlannedArchive | null }
export interface Plan { nasRoot: string; records: PlannedRecord[]; problems: string[] }

const rowDate = (r: PerformanceOutcome) => (r.publishedAt ? shanghaiDate(r.publishedAt) : "");
const hasTrustedId = (r: PerformanceOutcome) => !!r.platformItemId?.trim() && !isTruncatedItemId(r.platform, r.platformItemId);
const matches = (r: PerformanceOutcome, s: RowSpec) => r.platform === s.platform && rowDate(r) === s.date && normalizeTitle(r.platformTitle).startsWith(normalizeTitle(s.title));
const where = (s: RowSpec) => `${s.platform} ${s.date}「${s.title}」`;

function resolveId(spec: RowSpec, rows: PerformanceOutcome[], owner: string | null, table: Record<string, PlatformItemBinding>, problems: string[]): PlannedId | null {
  const ids = new Map<string, string>();
  for (const r of rows) if (matches(r, spec) && hasTrustedId(r)) ids.set(r.platformItemId!, r.platformTitle);
  if (ids.size !== 1) { problems.push(`${where(spec)} 带 id 的作品找到 ${ids.size} 条，应恰好 1 条`); return null; }
  const [[itemId, rowTitle]] = [...ids];
  const bound = table[platformItemKey(spec.platform, itemId)];
  const status: Status = !bound ? "new" : bound.contentId === owner ? "already" : "conflict";
  return { spec, itemId, rowTitle, status, ...(status === "conflict" ? { owner: bound!.contentId } : {}) };
}

function resolveClaim(spec: RowSpec, rows: PerformanceOutcome[], owner: string | null, claims: Record<string, WorkClaim>, problems: string[]): PlannedClaim | null {
  const group = rows.filter((r) => matches(r, spec));
  if (group.some(hasTrustedId)) { problems.push(`${where(spec)} 这组行带作品 id，不该走无编号认领`); return null; }
  const titles = new Map(group.map((r) => [normalizeTitle(r.platformTitle), r.platformTitle]));
  if (titles.size !== 1) { problems.push(`${where(spec)} 无编号行找到 ${titles.size} 组标题，应恰好 1 组`); return null; }
  const rowTitle = [...titles.values()][0];
  const held = claims[claimKey(spec.platform, rowTitle, spec.date)]?.contentId;
  const rowOwner = group.find((r) => r.contentId !== null && r.contentId !== owner)?.contentId;
  const other = held && held !== owner ? held : rowOwner ?? null;
  const status: Status = other ? "conflict" : held && held === owner ? "already" : "new";
  return { spec, rowTitle, status, ...(other ? { owner: other } : {}) };
}

async function planArchive(a: NonNullable<RecordSpec["archive"]>, existing: Content | null, nasRoot: string, entries: string[], problems: string[]): Promise<PlannedArchive> {
  const base = { oldId: a.oldId, inferred: a.inferred };
  if (existing?.archiveDraft) {
    if (existing.archiveDraft.oldContentId === a.oldId) return { ...base, dir: null, read: null, status: "already" };
    problems.push(`历史记录 ${existing.id} 已挂旧稿 ${existing.archiveDraft.oldContentId}，裁定要挂 ${a.oldId}——不覆盖`);
    return { ...base, dir: null, read: null, status: "skip", note: "已挂别的旧稿" };
  }
  const hits = entries.filter((e) => e.endsWith(`-${a.oldId}`));
  if (hits.length !== 1) return { ...base, dir: null, read: null, status: "skip", note: `旧资料库里找到 ${hits.length} 个旧稿 ${a.oldId} 文件夹` };
  const dir = path.join(nasRoot, hits[0]);
  const read = await readArchiveSource({ dir, oldId: a.oldId, inferred: a.inferred });
  return read.ok ? { ...base, dir, read, status: "attach" } : { ...base, dir, read, status: "skip", note: read.error };
}

/** NAS 挂没挂：旧资料库 contents 目录读得出来才算 */
export async function nasEntries(nasRoot: string): Promise<string[] | null> {
  try { return await fs.readdir(nasRoot); } catch { return null; }
}

async function assertNasMounted(nasRoot: string, state: string): Promise<void> {
  if (!(await nasEntries(nasRoot))) throw new Error(`NAS 旧资料库读不出（${nasRoot}）——已停下，${state}；挂上 MacMiniData 后重跑`);
}

/** 只读：算出要写什么。不写任何文件 */
export async function planOldWorks(dataDir: string, nasRoot = DEFAULT_NAS): Promise<Plan> {
  const problems: string[] = [];
  const entries = await nasEntries(nasRoot);
  if (!entries) return { nasRoot, records: [], problems: [`NAS 旧资料库没挂载或读不出（${nasRoot}）——已停下，什么都没写；挂上 MacMiniData 后再跑`] };
  const [table, claims, latest, contents] = await Promise.all([readPlatformItemsStrict(dataDir), readClaimsStrict(dataDir), latestByKey(dataDir), listContents(dataDir)]);
  const rows = [...latest.values()];
  const records: PlannedRecord[] = [];
  for (const spec of RECORDS) {
    const norm = normalizeTitle(spec.title);
    const existing = contents.find((c) => isImportedHistory(c) && !c.deletedAt && normalizeTitle(c.title) === norm && (c.publishedAt ?? "").slice(0, 10) === spec.date) ?? null;
    if (!existing && !spec.create) problems.push(`历史记录 ${spec.date}「${spec.title}」不存在（应在 10-03 回填时建好）`);
    const owner = existing?.id ?? null;
    const ids = spec.idItems.map((s) => resolveId(s, rows, owner, table, problems)).filter((x): x is PlannedId => !!x);
    const cl = spec.claims.map((s) => resolveClaim(s, rows, owner, claims, problems)).filter((x): x is PlannedClaim => !!x);
    const archive = spec.archive ? await planArchive(spec.archive, existing, nasRoot, entries, problems) : null;
    records.push({ spec, existingId: owner, ids, claims: cl, archive });
  }
  for (const r of records) for (const it of [...r.ids, ...r.claims]) {
    if (it.status === "conflict") problems.push(`${where(it.spec)} 已归属别的稿子 ${it.owner}——不覆盖`);
  }
  return { nasRoot, records, problems };
}

/** 写之前备份：绑定表、认领表、回流账本、内容索引，以及要动的历史记录的当前状态 */
export async function backupFiles(dataDir: string, root = path.join(os.homedir(), ".cache/autocrew-yt/backup-20261004")): Promise<string> {
  const dest = path.join(root, new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.mkdir(dest, { recursive: true });
  for (const name of ["platform-items.json", "work-claims.json", "outcomes.jsonl", "project-registry.json", "project-layout.json"]) {
    try { await fs.copyFile(path.join(dataDir, name), path.join(dest, name)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await fs.writeFile(path.join(dest, `${name}.absent`), "写入前不存在\n");
    }
  }
  const history = (await listContents(dataDir)).filter(isImportedHistory);
  await fs.writeFile(path.join(dest, "history-records.json"), JSON.stringify(history, null, 2));
  return dest;
}

/** 照计划写。计划有 problems 就一行都不写 */
export async function applyOldWorks(plan: Plan, dataDir: string, backupRoot?: string): Promise<{ backup: string; log: string[] }> {
  if (plan.problems.length) throw new Error(`计划有 ${plan.problems.length} 个问题，没有写入：\n${plan.problems.join("\n")}`);
  // 计划和写入之间 NAS 可能掉线：备份、写入前再查一次，掉了就整体停下
  await assertNasMounted(plan.nasRoot, "没有备份、没有写入");
  const backup = await backupFiles(dataDir, backupRoot);
  const fail = (what: string, err: string) => new Error(`${what}失败（已写入的部分可从 ${backup} 恢复；修好后重跑会接着做完）：${err}`);
  const log: string[] = [];
  for (const r of plan.records) {
    let id = r.existingId;
    if (r.spec.create) {
      const c = await createHistoryRecord({ title: r.spec.title, published_date: r.spec.date, items: r.ids.map((i) => ({ platform: i.spec.platform, item_id: i.itemId })) }, dataDir);
      if (!c.ok) throw fail(`历史记录 ${r.spec.date}`, c.error);
      id = c.contentId;
      log.push(`历史 ${r.spec.date}「${r.spec.title}」${c.status} ${id}：${c.bindings.map((b) => `${b.platform}:${b.itemId} ${b.status}/${b.reattributed}`).join("，")}`);
    }
    for (const cl of r.claims) {
      const res = await claimWorkByTitle(id!, cl.spec.platform, cl.rowTitle, cl.spec.date, dataDir);
      if (!res.ok) throw fail(`认领 ${where(cl.spec)}`, res.error);
      log.push(`认领 ${cl.spec.platform} ${cl.spec.date}「${cl.rowTitle.slice(0, 30)}」→ ${id} ${res.status}，补 ${res.copied} 行`);
    }
    const a = r.archive;
    if (a && a.status === "attach" && a.dir) {
      // 不用计划时缓存的正文：挂之前重新只读一遍源文件；NAS 掉线或文件没了是致命错误，不当成单条缺稿跳过
      await assertNasMounted(plan.nasRoot, `已写入的部分可从 ${backup} 恢复`);
      const src = { dir: a.dir, oldId: a.oldId, inferred: a.inferred };
      const read = await readArchiveSource(src);
      if (!read.ok) throw fail(`重读旧稿 ${a.oldId}（计划时读得到、现在读不到——NAS 可能掉线）`, read.error);
      const res = await attachArchiveDraft(id!, src, read, dataDir);
      if (!res.ok) throw fail(`挂存档原稿 ${a.oldId}`, res.error);
      log.push(`存档原稿 ${id} ← 旧稿 ${a.oldId}${a.inferred ? "（推断）" : ""} ${res.status}`);
    }
  }
  return { backup, log };
}

export function describePlan(plan: Plan): string {
  const out = [`NAS 旧资料库：${plan.nasRoot}`];
  const skipped: string[] = [];
  for (const r of plan.records) {
    out.push(`  ${r.spec.date}「${r.spec.title}」${r.existingId ? `已存在 ${r.existingId}` : "将新建"}`);
    for (const i of r.ids) out.push(`    绑定 ${i.spec.platform.padEnd(12)} ${i.itemId}  [${i.status}]  「${i.rowTitle.split("\n")[0].slice(0, 36)}」`);
    for (const c of r.claims) out.push(`    认领 ${c.spec.platform.padEnd(12)} @${c.spec.date}  [${c.status}]  「${c.rowTitle.split("\n")[0].slice(0, 36)}」`);
    const a = r.archive;
    if (!a) out.push("    存档原稿：不挂（裁定）");
    else if (a.status === "skip") { out.push(`    存档原稿：旧稿 ${a.oldId} 跳过——${a.note}`); skipped.push(`${r.spec.date} 旧稿 ${a.oldId}：${a.note}`); }
    else out.push(`    存档原稿：旧稿 ${a.oldId}${a.inferred ? "（推断）" : ""} [${a.status}]${a.read?.ok ? ` ${a.read.body.length} 字「${a.read.oldTitle ?? ""}」` : ""}`);
  }
  if (skipped.length) out.push(`== 不挂原稿、其余照做（${skipped.length}） ==`, ...skipped.map((s) => `  - ${s}`));
  out.push(plan.problems.length ? `== 问题（${plan.problems.length}），不会写入 ==\n${plan.problems.map((p) => `  - ${p}`).join("\n")}` : "== 无问题 ==");
  return out.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const nas = args.find((a) => a.startsWith("--nas="))?.slice(6) || DEFAULT_NAS;
  const dataDir = getDataDir(args.find((a) => !a.startsWith("--")));
  console.log(`数据目录：${dataDir}\n模式：${apply ? "apply" : "dry-run（不写任何文件）"}\n`);
  const plan = await planOldWorks(dataDir, nas);
  console.log(describePlan(plan));
  if (apply && !plan.problems.length) {
    // 资料库单写者：和服务一样先领写入锁（:4317 在跑时领不到会直接报错，不抢占）
    const release = acquireLibraryLock();
    try {
      const { backup, log } = await applyOldWorks(plan, dataDir);
      console.log(`\n已备份到 ${backup}\n${log.join("\n")}`);
    } finally {
      release();
    }
  } else if (plan.problems.length) {
    process.exitCode = 2;
  }
}
