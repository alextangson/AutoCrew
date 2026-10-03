/**
 * 一次性回填（docs/2026-10-03-outcome-binding-backfill-spec.md「要写入的数据」两张表）：
 * 把 7 个平台作品绑到 5 篇已发布稿，补 10 条历史作品记录并挂上各平台作品。
 *
 * 作品 id 不手抄：按表里的 平台 + 北京发布日 + 平台标题 去已入账的回流行里找。
 * 抖音只认完整 19 位 id；只找到被截坏的 id（…000）就整体停下——先跑一次抖音回流。
 * 默认 --dry-run 只打印；--apply 先把 platform-items.json / outcomes.jsonl / 内容索引备份到
 * ~/.cache/autocrew-yt/backup-20261003/<时间戳>/ 再写。重复跑幂等（已绑的报 already，已建的报 exists）。
 *
 * 用法：npx tsx scripts/backfill-bindings-20261003.mts [数据目录] [--apply]
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDataDir, listContents, type Content } from "../src/storage/local-store.js";
import { listOutcomes } from "../src/modules/flywheel/outcome-store.js";
import { lookupPlatformItem } from "../src/modules/flywheel/platform-items.js";
import { isTruncatedItemId, normalizeTitle, shanghaiDate, type PerformanceOutcome } from "../src/modules/flywheel/outcome-schema.js";
import { bindWorkManually, createHistoryRecord } from "../src/modules/flywheel/work-binding.js";
import { isImportedHistory } from "../src/storage/imported-history.js";

/** 表里的一个平台作品：标题按归一化前缀比（视频号会把正文拼进标题）；multi = 同日同题允许多条（都挂上） */
export interface ItemSpec { platform: string; date: string; title: string; multi?: boolean }

const P = (platform: string, date: string, title: string, multi?: boolean): ItemSpec => ({ platform, date, title, ...(multi ? { multi } : {}) });

/** 表一：绑定到现有 5 篇已发布稿（稿子按 id 后缀找） */
export const DRAFT_BINDINGS: Array<{ suffix: string; label: string; items: ItemSpec[] }> = [
  { suffix: "j2v9ag", label: "深度思考开到 max", items: [
    P("douyin", "2026-10-02", "深度思考开到max，AI反而更容易跑偏"),
    P("wechat_video", "2026-10-02", "深度思考开到max反而跑偏"),
    P("xiaohongshu", "2026-10-02", "深度思考开到max，反而跑偏？"),
  ] },
  { suffix: "n0ezov", label: "AI 最气人的 3 个瞬间", items: [P("wechat_video", "", "AI最气人的3个瞬间怎么治")] },
  { suffix: "pzey0m", label: "客户问一句「你们用 AI 吗」", items: [P("wechat_video", "", "客户问你们用AI吗怎么答")] },
  { suffix: "2g2bzh", label: "你每天纠正 AI 同一件事", items: [P("wechat_video", "", "AI又忘了说十遍不如写成规则")] },
  { suffix: "5t07zj", label: "每家都在卷 AI 会议纪要", items: [P("wechat_video", "", "纪要越漂亮方案越没重点")] },
];

/** 表二：10 条历史作品记录（同日同题一组） */
export const HISTORY: Array<{ title: string; date: string; items: ItemSpec[] }> = [
  { title: "让Agent帮你买东西，以后可能轮不到你挑了", date: "2026-09-04", items: [
    P("douyin", "2026-09-04", "让Agent帮你买东西，以后可能轮不到你挑了"),
    P("wechat_video", "2026-09-04", "以后替你买东西可能轮不到你挑了"),
    P("xiaohongshu", "2026-09-04", "如果Agent替你买东西，可能轮不到你挑了"),
  ] },
  { title: "别再收藏提示词了！这 7 条才让 AI 真变强", date: "2026-09-09", items: [
    P("douyin", "2026-09-09", "别再收藏提示词了！这 7 条才让 AI 真变强"),
    P("wechat_video", "2026-09-09", "7个写好skills的技巧"),
    P("xiaohongshu", "2026-09-09", "别再收藏提示词了！这 7 条才让 AI 真变强"),
  ] },
  { title: "AI入职四件套｜MCP、Skills、RAG、Memory", date: "2026-09-11", items: [
    P("douyin", "2026-09-11", "AI入职四件套｜MCP、Skills、RAG、Memory"),
    P("wechat_video", "2026-09-11", "到底怎么搭建会干活的 AI啊"),
    P("xiaohongshu", "2026-09-11", "AI入职四件套｜MCP、Skills、RAG、Memory"),
  ] },
  { title: "ChatGPT Image 2.5 实测，实现指哪改哪？", date: "2026-09-14", items: [
    P("douyin", "2026-09-14", "ChatGPT Image 2.5 实测，实现指哪改哪？"),
    P("wechat_video", "2026-09-14", "用AI改图改到第七版的人看过来"),
    P("xiaohongshu", "2026-09-14", "ChatGPT Image 2.5 实测，实现指哪改哪？"),
  ] },
  { title: "AI给自己造了个身体，接管了我家的全屋智能", date: "2026-09-16", items: [
    // 抖音这天同题两条：10:00 那条已设私密（0 播放），22:31 是公开重发——都是这条视频，都挂上
    P("douyin", "2026-09-16", "AI给自己造了个身体，接管了我家的全屋智能", true),
    P("wechat_video", "2026-09-16", "AI给自己造了个身体，接管了我家的全屋智能"),
    P("xiaohongshu", "2026-09-16", "AI给自己造了个身体，接管了我家的全屋智能"),
  ] },
  { title: "什么时候该用 Jev，什么时候该用大模型？", date: "2026-09-24", items: [
    P("douyin", "2026-09-24", "什么时候该用 Jev，什么时候该用大模型？"),
    P("wechat_video", "2026-09-24", "什么时候该用 Jev？"),
    P("xiaohongshu", "2026-09-24", "谁AI上班｜Jev vs 大模型，什么时候用哪个"),
  ] },
  { title: "刚付Typeless年费，腾讯出了免费版", date: "2026-09-26", items: [
    P("douyin", "2026-09-26", "刚付Typeless年费，腾讯出了免费版"),
    P("wechat_video", "2026-09-26", "chatterfly语音输入法"),
    P("xiaohongshu", "2026-09-26", "刚付Typeless年费，腾讯出了免费版"),
  ] },
  { title: "谁AI上班｜8个让AI替我上班的实用工具", date: "2026-09-28", items: [
    P("douyin", "2026-09-28", "谁AI上班｜8个让AI替我上班的实用工具"),
    P("wechat_video", "2026-09-28", "8个实用的Agent必备工具"),
    P("xiaohongshu", "2026-09-28", "谁AI上班｜8个让AI替我上班的实用工具"),
  ] },
  { title: "开源的agent新媒体团队", date: "2026-09-29", items: [P("wechat_video", "2026-09-29", "开源的agent新媒体团队")] },
  { title: "用AI干活的3种形态，你停在哪一种？", date: "2026-09-30", items: [
    P("douyin", "2026-09-30", "用AI干活的3种形态，你停在哪一种？"),
    P("wechat_video", "2026-09-30", "用AI干活的3种形态"),
    P("xiaohongshu", "2026-09-30", "我AI上班｜别再陪AI加班了"),
  ] },
];

export interface ResolvedItem { spec: ItemSpec; itemId: string; rowTitle: string; status: "new" | "already" | "conflict"; owner?: string }
export interface Plan {
  drafts: Array<{ contentId: string; label: string; items: ResolvedItem[] }>;
  history: Array<{ title: string; date: string; existingId: string | null; items: ResolvedItem[] }>;
  problems: string[];
}

/** 一条表项 → 回流行里的作品 id（去重）。找不到 / 有歧义 / 抖音只剩截坏 id → problems */
function resolveSpec(spec: ItemSpec, rows: PerformanceOutcome[], problems: string[]): Array<{ itemId: string; rowTitle: string }> {
  const want = normalizeTitle(spec.title);
  const hits = rows.filter((r) => r.platform === spec.platform && r.platformItemId &&
    normalizeTitle(r.platformTitle).startsWith(want) && (!spec.date || (r.publishedAt && shanghaiDate(r.publishedAt) === spec.date)));
  const ids = new Map<string, string>();
  for (const h of hits) ids.set(h.platformItemId!, h.platformTitle);
  const trusted = [...ids].filter(([id]) => !isTruncatedItemId(spec.platform, id));
  const where = `${spec.platform} ${spec.date || "(不限日期)"}「${spec.title}」`;
  if (trusted.length === 0) {
    problems.push(ids.size > 0
      ? `${where} 只找到被截坏的抖音 id（${[...ids.keys()].join("、")}）——需要先跑一次抖音回流拿到完整 id`
      : `${where} 在已入账的回流行里没找到`);
    return [];
  }
  if (trusted.length > 1 && !spec.multi) {
    problems.push(`${where} 命中多条作品（${trusted.map(([id]) => id).join("、")}），有歧义，不猜`);
    return [];
  }
  return trusted.map(([itemId, rowTitle]) => ({ itemId, rowTitle }));
}

async function withStatus(found: Array<{ itemId: string; rowTitle: string }>, spec: ItemSpec, owner: string | null, dataDir: string): Promise<ResolvedItem[]> {
  const out: ResolvedItem[] = [];
  for (const f of found) {
    const bound = await lookupPlatformItem(spec.platform, f.itemId, dataDir);
    const status = !bound ? "new" : bound.contentId === owner ? "already" : "conflict";
    out.push({ spec, ...f, status, ...(bound && status === "conflict" ? { owner: bound.contentId } : {}) });
  }
  return out;
}

function findDraft(contents: Content[], suffix: string, problems: string[]): Content | null {
  const hits = contents.filter((c) => c.id.endsWith(`-${suffix}`));
  if (hits.length !== 1) { problems.push(`稿子 …${suffix} 找到 ${hits.length} 篇，应恰好 1 篇`); return null; }
  if (hits[0].status !== "published") problems.push(`稿子 ${hits[0].id} 状态是 ${hits[0].status}，不是已发布`);
  return hits[0];
}

/** 只读：算出要写什么。不写任何文件 */
export async function planBackfill(dataDir: string): Promise<Plan> {
  const [rows, contents] = await Promise.all([listOutcomes(dataDir), listContents(dataDir)]);
  const problems: string[] = [];
  const plan: Plan = { drafts: [], history: [], problems };
  for (const d of DRAFT_BINDINGS) {
    const draft = findDraft(contents, d.suffix, problems);
    const items: ResolvedItem[] = [];
    for (const spec of d.items) items.push(...await withStatus(resolveSpec(spec, rows, problems), spec, draft?.id ?? null, dataDir));
    if (draft) plan.drafts.push({ contentId: draft.id, label: d.label, items });
  }
  for (const h of HISTORY) {
    const norm = normalizeTitle(h.title);
    const existing = contents.find((c) => isImportedHistory(c) && normalizeTitle(c.title) === norm && (c.publishedAt ?? "").slice(0, 10) === h.date) ?? null;
    const items: ResolvedItem[] = [];
    for (const spec of h.items) items.push(...await withStatus(resolveSpec(spec, rows, problems), spec, existing?.id ?? null, dataDir));
    plan.history.push({ title: h.title, date: h.date, existingId: existing?.id ?? null, items });
  }
  for (const it of [...plan.drafts.flatMap((d) => d.items), ...plan.history.flatMap((h) => h.items)]) {
    if (it.status === "conflict") problems.push(`${it.spec.platform}:${it.itemId} 已绑定别的稿子 ${it.owner}——不覆盖`);
  }
  return plan;
}

/** 写之前备份：绑定表、回流账本、内容索引（项目绑定清单 / 布局） */
export async function backupFiles(dataDir: string, root = path.join(os.homedir(), ".cache/autocrew-yt/backup-20261003")): Promise<string> {
  const dest = path.join(root, new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.mkdir(dest, { recursive: true });
  for (const name of ["platform-items.json", "outcomes.jsonl", "project-registry.json", "project-layout.json"]) {
    try { await fs.copyFile(path.join(dataDir, name), path.join(dest, name)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await fs.writeFile(path.join(dest, `${name}.absent`), "写入前不存在\n");
    }
  }
  return dest;
}

/** 照计划写。计划有 problems 就一行都不写 */
export async function applyBackfill(plan: Plan, dataDir: string, backupRoot?: string): Promise<{ backup: string; log: string[] }> {
  if (plan.problems.length) throw new Error(`计划有 ${plan.problems.length} 个问题，没有写入：\n${plan.problems.join("\n")}`);
  const backup = await backupFiles(dataDir, backupRoot);
  const log: string[] = [];
  for (const d of plan.drafts) {
    for (const it of d.items) {
      const r = await bindWorkManually(d.contentId, it.spec.platform, it.itemId, dataDir);
      if (!r.ok) throw new Error(`绑定失败（已写入的部分可从 ${backup} 恢复）：${r.error}`);
      log.push(`绑定 ${d.label} ← ${it.spec.platform}:${it.itemId} ${r.status}，补归属 ${r.reattributed} 行`);
    }
  }
  for (const h of plan.history) {
    const r = await createHistoryRecord({ title: h.title, published_date: h.date, items: h.items.map((i) => ({ platform: i.spec.platform, item_id: i.itemId })) }, dataDir);
    if (!r.ok) throw new Error(`历史记录失败（已写入的部分可从 ${backup} 恢复）：${r.error}`);
    log.push(`历史 ${h.date}「${h.title}」${r.status} ${r.contentId}：${r.bindings.map((b) => `${b.platform}:${b.itemId} ${b.status}/${b.reattributed}`).join("，")}`);
  }
  return { backup, log };
}

export function describePlan(plan: Plan): string {
  const line = (i: ResolvedItem) => `    ${i.spec.platform.padEnd(12)} ${i.itemId}  [${i.status}]  「${i.rowTitle.split("\n")[0].slice(0, 40)}」`;
  return [
    "== 绑定到现有已发布稿 ==",
    ...plan.drafts.flatMap((d) => [`  ${d.label}（${d.contentId}）`, ...d.items.map(line)]),
    "== 历史作品记录 ==",
    ...plan.history.flatMap((h) => [`  ${h.date}「${h.title}」${h.existingId ? `已存在 ${h.existingId}` : "将新建"}`, ...h.items.map(line)]),
    plan.problems.length ? `== 问题（${plan.problems.length}），不会写入 ==\n${plan.problems.map((p) => `  - ${p}`).join("\n")}` : "== 无问题 ==",
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dataDir = getDataDir(args.find((a) => !a.startsWith("--")));
  console.log(`数据目录：${dataDir}\n模式：${apply ? "apply" : "dry-run（不写任何文件）"}\n`);
  const plan = await planBackfill(dataDir);
  console.log(describePlan(plan));
  if (apply) {
    const { backup, log } = await applyBackfill(plan, dataDir);
    console.log(`\n已备份到 ${backup}\n${log.join("\n")}`);
  } else if (plan.problems.length) {
    process.exitCode = 2;
  }
}
