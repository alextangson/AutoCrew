/** 「我的内容」视图的目标清单：从稿件算出每个栏目下应该出现哪些文件。只读，不碰视图目录。 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Content, VideoKit } from "./local-store.js";
import { listContents } from "./local-store.js";
import { resolveContentProject, projectRelativeFile, isMissing } from "./content-project.js";
import { isVideoPlatform } from "./stage-guard.js";
import { listRetros, readRetro } from "../modules/retro/retro.js";
import { renderCheckList, unverifiedAdditions } from "../modules/video/handoff/spoken.js";
import { spokenRel } from "../modules/video/handoff/register-spoken.js";
import { readArchiveLog, renderArchiveLog } from "./nas-archive-log.js";
import { explainContent, explainContext, type ExplainContext } from "../modules/production/read.js";

/** 已发布栏只留最近几条；NAS 归档也不动这几条 */
export const KEEP_PUBLISHED = 5;

export const COLUMNS = ["写稿中", "待录制", "剪辑中", "待发布", "已发布", "复盘"] as const;
export type Column = (typeof COLUMNS)[number];
/** 视图里的栏目目录名：阿拉伯数字打头，Finder 按流程顺序排（中文数字会按拼音排） */
export function columnDir(col: Column): string { return `${COLUMNS.indexOf(col) + 1} ${col}`; }

export type Desired =
  | { rel: string; owner: string; kind: "copy"; text: string }
  | { rel: string; owner: string; kind: "link"; source: string }
  | { rel: string; owner: string; kind: "symlink"; target: string };

export interface Plan {
  entries: Desired[];
  /** 视图相对目录 → 所属稿件 id（栏目目录记 `_column`） */
  dirs: Record<string, string>;
  failed: Set<string>;
  errors: string[];
}

export const GUIDE = `# 我的内容 · 使用说明

这里是 AutoCrew 按稿件进度自动整理出来的文件夹，每分钟对一次账。栏目文件夹前面的数字（1 写稿中 … 6 复盘）只是让它们按流程顺序排。

- 写稿中：还在写、在审、在改的稿子，以及 AI 已写完、等你认稿的稿子，只放口播稿。
- 待录制：你认过的视频稿，等你录口播。
- 剪辑中：放口播稿和「成片放这里」。剪映直接导出到「成片放这里」就行，它指向这条稿件的项目目录。
- 待发布：成片、两张封面、口播稿、发布文案都在一个文件夹里，拖去上传即可。缺什么写在「还缺什么.txt」里。登记过成片的还有「口播稿-实拍版.md」（按成片字幕还原的实际说法）；实拍时新说了定稿里没有的数字或出处，会列在「发布前核对.txt」里，发布前看一眼，不挡发布。
- 已发布：只留最近 5 条。发布满 7 天、又不在最近 5 条里的，素材会搬到 NAS，搬了什么、腾出多少空间记在「归档记录.md」。
- 复盘：最新一份复盘报告。

口播稿、发布文案是副本，AI 改稿后会自动更新。写稿中、待录制里的口播稿你可以直接改，下一次对账会把你的改稿存成稿件新版本，AI 以后写稿也会学你的改法。这几种情况不会同步：AI 正在写这篇、文件被清空、稿子已经交剪辑、你改的同时 AI 也改了——这时你的文件另存成「口播稿（我改过的 时间）.md」保留，原因写在「⚠️ 同步出错.txt」里。其它栏目的副本是只读的，改了也不会同步，同样另存保留。

你自己放进来的文件永远不会被删；有你自己文件的文件夹也会原样保留。
`;

/**
 * 这条稿在哪一栏：与看板、晨报、desk 同一个 explain()（本体 spec §2.6）。本体未启用时按旧状态给（影子模式）。
 * 复盘栏不属于任何稿件。
 */
export async function columnOf(c: Content, dataDir: string, ctx?: ExplainContext): Promise<Column | null> {
  return (await explainContent(c, dataDir, ctx)).column;
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }

export function folderTitle(c: Content): string {
  const date = new Date(c.createdAt);
  // eslint-disable-next-line no-control-regex
  const clean = c.title.replace(/^\s*[［[]生成中断?[］\]]\s*/, "").replace(/[/\\:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ").replace(/^\.+/, "").trim();
  return `${pad2(date.getMonth() + 1)}${pad2(date.getDate())} ${Array.from(clean || "未命名").slice(0, 40).join("")}`;
}

/** 同栏目重名：按创建时间先到先得，后到的补稿件 ID 尾号 */
export function folderNames(items: Content[]): Map<string, string> {
  const sorted = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const seen = new Set<string>(), out = new Map<string, string>();
  for (const c of sorted) {
    let name = folderTitle(c);
    if (seen.has(name)) name = `${name} ${c.id.slice(-6)}`;
    seen.add(name);
    out.set(c.id, name);
  }
  return out;
}

async function readIfExists(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); } catch (e) { if (isMissing(e)) return null; throw e; }
}

/** 视图里「口播稿.md」的原文：交接后是冻结的定稿，之前是当前稿 */
export async function scriptText(c: Content, root: string): Promise<string | null> {
  const gen = c.video?.handoff?.generation;
  if (gen) {
    const handoff = await readIfExists(path.join(root, `01-script/handoff/g${String(gen).padStart(4, "0")}/final-script.md`));
    if (handoff !== null) return handoff;
  }
  return readIfExists(path.join(root, projectRelativeFile("draft.md")));
}

async function publishKit(c: Content, root: string): Promise<VideoKit | null> {
  const raw = await readIfExists(path.join(root, "06-publish/copy", `${c.platform ?? "unknown"}.json`));
  if (raw !== null) return (JSON.parse(raw) as { kit?: VideoKit }).kit ?? null;
  return c.videoKit ?? null;
}

function renderKit(c: Content, kit: VideoKit): string {
  const tags = c.hashtags?.length ? c.hashtags.map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ") : "（没有单独的标签）";
  return `# 发布文案（${kit.platform || c.platform || "未知平台"}）\n\n## 标题\n\n${kit.postTitle}\n\n## 正文\n\n${kit.caption}\n\n## 标签\n\n${tags}\n`;
}

interface PlanPlatform { platform?: string; title?: string; caption?: string; tags?: unknown; caption_status?: string; scheduled_at?: string }
const CAPTION_STATUS: Record<string, string> = { submitted: "已提交到平台", local_draft_not_submitted: "只存了本地草稿，还没提交" };

function renderPlanPlatform(p: PlanPlatform): string {
  const tags = Array.isArray(p.tags) && p.tags.length ? p.tags.map((t) => `#${String(t).replace(/^#/, "")}`).join(" ") : "（没有单独的标签）";
  const meta = [p.scheduled_at && `定时：${p.scheduled_at}`, p.caption_status && `状态：${CAPTION_STATUS[p.caption_status] ?? p.caption_status}`].filter(Boolean).join("；");
  return `## ${p.platform ?? "未知平台"}\n\n${meta ? `${meta}\n\n` : ""}**标题**：${p.title ?? "（没写）"}\n\n**正文**：\n\n${p.caption ?? "（没写）"}\n\n**标签**：${tags}\n`;
}

/** 发布计划（publish-content 技能写的 06-publish/publish-plan.json）里有各平台文案就用它，否则退回发布包 */
async function publishCopy(c: Content, root: string): Promise<string | null> {
  const raw = await readIfExists(path.join(root, "06-publish/publish-plan.json"));
  if (raw !== null) {
    const platforms = (JSON.parse(raw) as { platforms?: PlanPlatform[] }).platforms;
    if (Array.isArray(platforms) && platforms.length) return `# 发布文案\n\n${platforms.map(renderPlanPlatform).join("\n")}`;
  }
  const kit = await publishKit(c, root);
  return kit ? renderKit(c, kit) : null;
}

async function coverFiles(root: string): Promise<Record<"封面-3x4" | "封面-4x3", string | null>> {
  let names: string[] = [];
  try { names = await fs.readdir(path.join(root, "05-cover")); } catch (e) { if (!isMissing(e)) throw e; }
  const pick = (base: string) => names.find((n) => n.startsWith(`${base}.`)) ?? null;
  const a = pick("封面-3x4"), b = pick("封面-4x3");
  return { "封面-3x4": a && path.join(root, "05-cover", a), "封面-4x3": b && path.join(root, "05-cover", b) };
}

type ItemFile = { name: string } & ({ kind: "copy"; text: string } | { kind: "link"; source: string } | { kind: "symlink"; target: string });

async function deliveryFiles(c: Content, root: string): Promise<ItemFile[]> {
  const files: ItemFile[] = [], missing: string[] = [];
  const final = c.video?.final;
  const finalPath = final ? path.join(root, projectRelativeFile(`assets/${final.asset_filename}`)) : null;
  if (finalPath && (await fs.stat(finalPath).then(() => true, () => false))) {
    files.push({ name: `成片${path.extname(finalPath)}`, kind: "link", source: finalPath });
  } else if (isVideoPlatform(c.platform)) missing.push("成片：还没有登记的成片");
  for (const [base, source] of Object.entries(await coverFiles(root))) {
    if (source) files.push({ name: `${base}${path.extname(source)}`, kind: "link", source });
    else missing.push(`${base}：还没有定稿封面`);
  }
  const copy = await publishCopy(c, root);
  if (copy) files.push({ name: "发布文案.md", kind: "copy", text: copy });
  else missing.push("发布文案：还没有做发布包");
  if (missing.length) files.push({ name: "还缺什么.txt", kind: "copy", text: `这条稿件发布前还缺：\n\n${missing.map((m) => `- ${m}`).join("\n")}\n` });
  return files;
}

/** 实拍版口播（登记时从成片字幕还原）+ 实拍时新说、还没核验的数字和出处 */
async function spokenFiles(c: Content, root: string, script: string): Promise<ItemFile[]> {
  const gen = c.video?.final?.generation;
  if (!gen) return [];
  const spoken = await readIfExists(path.join(root, spokenRel(gen)));
  if (spoken === null) return [];
  const files: ItemFile[] = [{ name: "口播稿-实拍版.md", kind: "copy", text: spoken }];
  const added = unverifiedAdditions(script, spoken);
  if (added.length) files.push({ name: "发布前核对.txt", kind: "copy", text: renderCheckList(added) });
  return files;
}

/** 一条稿件在视图里的文件；没有稿子返回 null（不出现） */
async function itemFiles(c: Content, column: Column, dataDir: string): Promise<ItemFile[] | null> {
  const binding = resolveContentProject(c.id, dataDir);
  if (!binding) throw new Error("没有项目目录");
  const root = binding.project_root;
  const script = await scriptText(c, root);
  if (script === null) return null;
  const files: ItemFile[] = [{ name: "口播稿.md", kind: "copy", text: script }];
  if (column === "待发布" || column === "已发布") files.push(...(await spokenFiles(c, root, script)));
  if (column === "剪辑中") {
    const exportDir = path.join(root, "07-delivery/export");
    await fs.mkdir(exportDir, { recursive: true });
    files.push({ name: "成片放这里", kind: "symlink", target: exportDir });
  }
  if (column === "待发布" || column === "已发布") files.push(...(await deliveryFiles(c, root)));
  return files;
}

async function visible(contents: Content[], keepPublished: number, dataDir: string, plan: Plan): Promise<Map<Column, Content[]>> {
  const ctx = await explainContext(dataDir);
  const columns = new Map<string, Column>();
  for (const c of contents) {
    try {
      const col = await columnOf(c, dataDir, ctx);
      if (col) columns.set(c.id, col);
    } catch (e) {
      plan.failed.add(c.id);
      plan.errors.push(`${c.title}（${c.id}）：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const published = new Set(contents.filter((c) => columns.get(c.id) === "已发布")
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")).slice(0, keepPublished).map((c) => c.id));
  const byColumn = new Map<Column, Content[]>();
  for (const c of contents) {
    const col = columns.get(c.id);
    if (!col || (col === "已发布" && !published.has(c.id))) continue;
    byColumn.set(col, [...(byColumn.get(col) ?? []), c]);
  }
  return byColumn;
}

async function addRetro(plan: Plan, dataDir: string): Promise<void> {
  const latest = (await listRetros(dataDir))[0];
  const text = latest ? await readRetro(dataDir, latest.file) : null;
  if (text !== null) plan.entries.push({ rel: `${columnDir("复盘")}/最新复盘.md`, owner: "_retro", kind: "copy", text });
}

export async function buildPlan(dataDir: string, keepPublished: number): Promise<Plan> {
  const plan: Plan = { entries: [], dirs: {}, failed: new Set(), errors: [] };
  for (const col of COLUMNS) plan.dirs[columnDir(col)] = "_column";
  plan.entries.push({ rel: "使用说明.md", owner: "_guide", kind: "copy", text: GUIDE });
  for (const [col, items] of await visible(await listContents(dataDir), keepPublished, dataDir, plan)) {
    const names = folderNames(items);
    for (const c of items) {
      try {
        const files = await itemFiles(c, col, dataDir);
        if (!files) continue;
        const dir = `${columnDir(col)}/${names.get(c.id)}`;
        plan.dirs[dir] = c.id;
        for (const f of files) plan.entries.push({ ...f, rel: `${dir}/${f.name}`, owner: c.id } as Desired);
      } catch (e) {
        plan.failed.add(c.id);
        plan.errors.push(`${c.title}（${c.id}）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  try {
    const log = await readArchiveLog(dataDir);
    if (log.length) plan.entries.push({ rel: "归档记录.md", owner: "_archive", kind: "copy", text: renderArchiveLog(log) });
  } catch (e) { plan.failed.add("_archive"); plan.errors.push(`归档记录：${e instanceof Error ? e.message : String(e)}`); }
  try { await addRetro(plan, dataDir); }
  catch (e) { plan.failed.add("_retro"); plan.errors.push(`复盘：${e instanceof Error ? e.message : String(e)}`); }
  return plan;
}
