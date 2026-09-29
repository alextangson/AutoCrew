/**
 * 「我的内容/5 已发布」比待发布多出来的文件（spec 2026-09-29 C）：成片字幕、发布回执、原片、NAS 备份状态。
 * 没有源就不放，也不报错；待发布栏不出现这些。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Content } from "./local-store.js";
import { isMissing } from "./content-project.js";
import type { ItemFile } from "./my-content-plan.js";
import { locateProjectFile } from "./nas-kept.js";
import { readBackupState, renderBackupStatus } from "./nas-backup-state.js";
import { readProductionDocOrEmpty } from "./production-store.js";
import { ontologyApplies } from "../modules/production/publish-gate.js";

async function readIfExists(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); } catch (e) { if (isMissing(e)) return null; throw e; }
}

interface Publication { status?: string; review_status?: string; evidence?: string; url?: string; bvid?: string; post_id?: string; item_id?: string; published_at?: string }
interface ReceiptPlatform {
  platform?: string; account?: string; title?: string; scheduled_at?: string;
  campaigns?: { name?: string }[]; publication?: Publication;
}

const STATUS: Record<string, string> = {
  scheduled: "已定时", reviewing: "审核中", published: "已公开", public: "已公开", approved: "审核通过",
  rejected: "未通过", failed: "失败", draft: "草稿", submitted: "已提交", pending: "等待中",
};
const zh = (s?: string) => (s ? STATUS[s] ?? s : null);

function renderReceiptPlatform(p: ReceiptPlatform): string {
  const pub = p.publication ?? {};
  const status = [zh(pub.status), pub.review_status && `审核：${zh(pub.review_status)}`].filter(Boolean).join("；");
  const campaigns = (p.campaigns ?? []).map((c) => c.name).filter(Boolean).join("、");
  const ids = [pub.url, pub.bvid && `BV 号 ${pub.bvid}`, pub.post_id && `作品 ID ${pub.post_id}`, pub.item_id && `作品 ID ${pub.item_id}`].filter(Boolean).join("；");
  const lines = [
    p.account && `- 账号：${p.account}`,
    `- 标题：${p.title ?? "（没写）"}`,
    p.scheduled_at && `- 定时：${p.scheduled_at}`,
    pub.published_at && `- 公开时间：${pub.published_at}`,
    `- 状态：${status || "（没记录）"}`,
    campaigns && `- 活动：${campaigns}`,
    ids && `- 作品链接/ID：${ids}`,
    pub.evidence && `- 依据：${pub.evidence}`,
  ].filter(Boolean);
  return `## ${p.platform ?? "未知平台"}\n\n${lines.join("\n")}\n`;
}

/** 由 06-publish/publish-plan.json 渲染；没有 plan 或没有平台就不生成 */
export async function renderReceipt(root: string): Promise<string | null> {
  const raw = await readIfExists(path.join(root, "06-publish/publish-plan.json"));
  if (raw === null) return null;
  const platforms = (JSON.parse(raw) as { platforms?: ReceiptPlatform[] }).platforms;
  if (!Array.isArray(platforms) || !platforms.length) return null;
  return `# 发布回执\n\n只读副本，由发布计划（06-publish/publish-plan.json）生成。\n\n${platforms.map(renderReceiptPlatform).join("\n")}`;
}

/** 本机有 → 硬链接；已搬到 NAS → 「<名>在NAS.txt」；都没有 → 不放 */
async function linkOrNas(root: string, source: string, base: string): Promise<ItemFile[]> {
  const found = await locateProjectFile(root, source);
  if (found?.where === "local") return [{ name: `${base}${path.extname(source)}`, kind: "link", source: found.path }];
  if (found?.where === "nas") return [{ name: `${base}在NAS.txt`, kind: "copy", text: `${base}已搬到 NAS：\n\n${found.path}\n` }];
  return [];
}

/** 已发布原片：按本体走的稿取本轮有效的 A-roll 事实（record 出来的稿没有旧交接）；旧稿回退到交接记录 */
async function arollPathOf(c: Content, root: string, dataDir?: string): Promise<string | null> {
  if (dataDir && (await ontologyApplies(c, dataDir))) {
    const doc = await readProductionDocOrEmpty(c.id, dataDir);
    const f = doc.facts.filter((x) => x.round === doc.round && x.kind === "aroll" && x.state === "accepted" && !x.released_to && x.path).at(-1);
    return f ? (path.isAbsolute(f.path!) ? f.path! : path.join(root, f.path!)) : null;
  }
  return c.video?.handoff?.aroll_path ?? null;
}

export async function publishedFiles(c: Content, root: string, dataDir?: string): Promise<ItemFile[]> {
  const files: ItemFile[] = [];
  const srt = c.video?.final?.srt_path;
  if (srt) {
    const found = await locateProjectFile(root, srt);
    if (found?.where === "local") files.push({ name: "成片字幕.srt", kind: "link", source: found.path });
  }
  const receipt = await renderReceipt(root);
  if (receipt) files.push({ name: "发布回执.md", kind: "copy", text: receipt });
  const aroll = await arollPathOf(c, root, dataDir);
  if (aroll) files.push(...(await linkOrNas(root, aroll, "原片")));
  const state = await readBackupState(root);
  if (state) files.push({ name: "NAS备份状态.txt", kind: "copy", text: renderBackupStatus(state) });
  return files;
}
