/**
 * list：把等创始人定的事带进对话（spec 2026-10-06 proactive-chat-review）。
 * 每件能在对话里定的事带服务端写好的 brief；带 preview_dir 时把要看的文件放进会话文件夹，返回相对路径。
 */
import path from "node:path";
import { getDataDir } from "../../../storage/local-store.js";
import { readProductionDocOrEmpty } from "../../../storage/production-store.js";
import type { ProductionDoc } from "../../../storage/production-types.js";
import { readInbox } from "../inbox-read.js";
import type { InboxItem } from "../inbox.js";
import { briefOf, pickedGroup, pickedVersion, staleSelector } from "./brief.js";
import { factPath } from "./files.js";
import { placePreview, sweepPreview, type PreviewFile } from "./preview.js";
import { askAttachments } from "./ask-view.js";
import { publishView } from "./publish-view.js";
import { chatDecidable, chatItem } from "./view.js";
import { ruleBrief } from "./rule-decide.js";
import { playbookBrief } from "./playbook-decide.js";
import { promotionBrief } from "./promotion-decide.js";

type Result = Record<string, unknown>;
export interface ListInput { preview_dir?: string; content_id?: string; item_id?: string; group_id?: string; fact_id?: string }

const decidable = chatDecidable;
const IMAGE = /\.(png|jpe?g|webp|gif|heic)$/i;

function fileOf(doc: ProductionDoc, item: InboxItem, factId: string | undefined, label: string, dataDir: string): PreviewFile | null {
  const f = doc.facts.find((x) => x.id === factId);
  if (!f?.path) return null;
  const source = factPath(item.content_id!, f, dataDir);
  const prefix = [label, f.version ? `v${f.version}` : ""].filter(Boolean).join("-");
  return { source, name: prefix ? `${prefix}-${path.basename(source)}` : path.basename(source), video: !IMAGE.test(source) };
}

/** 这件事要看的文件：封面 = 选中那组的两张；成片 = 选中那一版；候选 = 那个文件 */
function previewFiles(item: InboxItem, doc: ProductionDoc, dataDir: string, sel: ListInput): PreviewFile[] {
  const one = (id: string | undefined, label: string) => fileOf(doc, item, id, label, dataDir);
  let out: Array<PreviewFile | null> = [];
  if (item.type === "cover_pick") {
    const g = pickedGroup(item, sel.group_id);
    out = [one(g?.["3:4"]?.fact_id, ""), one(g?.["4:3"]?.fact_id, "")];
  } else if (item.type === "cut_review") {
    out = [one(pickedVersion(item, sel.fact_id)?.fact_id, "成片")];
  } else if (item.type === "candidate" && item.detail.preview) {
    out = [one(String(item.detail.fact_id ?? ""), "候选")];
  }
  return out.filter((x): x is PreviewFile => Boolean(x));
}

async function present(item: InboxItem, n: number | null, dataDir: string, input: ListInput): Promise<Result> {
  const base = await chatItem(item, dataDir);
  if (!decidable(item)) return base;
  if (item.type === "writing_rule" || item.type === "playbook_change" || item.type === "writing_promotion") { const b = item.type === "writing_rule" ? ruleBrief(item) : item.type === "writing_promotion" ? promotionBrief(item) : playbookBrief(item); return { ...base, ...(n ? { number: n } : {}), brief: n ? `${n}. ${b}` : b, shown: {} }; }
  const doc = await readProductionDocOrEmpty(item.content_id!, dataDir);
  const sel = input.item_id === item.item_id ? input : {};
  const brief = await briefOf(item, doc, dataDir, sel);
  const shown = item.type === "cover_pick" ? { group_id: pickedGroup(item, sel.group_id)?.group_id }
    : item.type === "cut_review" ? { fact_id: pickedVersion(item, sel.fact_id)?.fact_id } : {};
  const key = { content_id: item.content_id!, item_id: item.item_id };
  const ask = item.type === "ask" ? await askAttachments(item, doc, dataDir, input.item_id === item.item_id) : null;
  const files = ask ? ask.files : item.type === "publish_check" ? (await publishView(item, dataDir)).files : previewFiles(item, doc, dataDir, sel);
  const placed = input.preview_dir ? await placePreview(input.preview_dir, item.title, key, files) : null;
  const preview = placed || ask?.pages.length ? { ...(placed ?? { files: [], opened: [], problems: [] }), ...(ask?.pages.length ? { pages: ask.pages } : {}) } : null;
  return { ...base, ...(n ? { number: n } : {}), brief: n ? `${n}. ${brief}` : brief, shown, ...(preview ? { preview } : {}) };
}

const NEXT = [
  "把每件的 brief 原样转述给创始人（不要自己加判断标准）；preview.files 的 path 写成 markdown 链接让他点开，preview.opened / problems 照说；preview.pages 是网页：给绝对路径；只有 list{item_id} 单看这一件时才会在浏览器打开，说清打开了没有。",
  "不止一件时按 number 列成编号清单，他可以回「1 用，2 还要改：……」。说「用」就按 shown 里的 group_id / fact_id decide。",
  "请示：他的话对得上唯一一个选项才 decide answer_ask（带 option_id，多说的话放 note）；对不上或只说「行」而选项不止一个就先问他，别猜。",
  "发之前再看一眼：他说「都没问题」时，可以对这次列出来的每件 publish_check 各 decide 一次 publish_check_confirm（同一句原话、各自的 item_id / gen / request_id）；他点了哪几个平台就只定那几个；没在这次列表里给他看过的不许顺带定。",
  "发了没（publish_claim / published_ask）：他说「都发了」同样对这次列出来的每件各 decide 一次（同一句原话）；点了平台就只定那些；没列出来的不许顺带定。他给的作品链接原样放 url。",
  "写作规则（writing_rule）：他说哪几条要就 approve_rule，不要就 reject_rule，替换就 replace_rule 带 target_rule_id；只说「你定 / 都行」不算，问他要哪条。",
  "体裁手册改动（playbook_change）：brief 里的改前改后原样给他看；他说批就 approve_playbook，不要就 reject_playbook；只说「你定 / 都行」不算，问他。回 stale 说明手册之后改过，这份作废。",
  "改稿意见升级（writing_promotion）：brief 原样给他看；批 = approve_promotion（只记成「已批、等人工改」，不会自动改范文或写法），不要 = reject_promotion；只说「你定 / 都行」不算。",
  "认稿（draft）：brief 里是稿子全文，原样贴给他，别缩写；他说没问题就 approve_script，要改就 revise_script 带 note。waiting_behind 有值时说清成片 / 封面在等这份稿。",
  "画面闪帧（sliver）：brief 原样转述。他说「不查了」= waive_sliver_check（只在 decisions 里有时）；「第 N 处是故意的」= waive_sliver 带 facts.points 里第 N 处的 sliver_key；「都是故意的」= 对 points 里每一处各 decide 一次 waive_sliver（同一句原话、各自的 request_id）；「去改：……」= reject_cut 带 note。",
  "他一句话同时管闪帧和成片（比如「不查了，用」）：先 decide 闪帧那件，再 list 一次拿成片那件新的 gen，用同一句原话 decide approve_cut。",
  "他想看更早的一组 / 一版：list{item_id, group_id 或 fact_id, preview_dir} 只放那一个。chat_decidable:false 的给 board_link。",
].join("");

/** 单件的完整样子（brief + 预览）：给 decide 被拒时返回「现在的样子」用；不开网页 */
export function presentItem(item: InboxItem, dataDir: string, previewDir?: string): Promise<Result> {
  return present(item, null, dataDir, { preview_dir: previewDir });
}

/** 清掉已定的事的预览文件、7 天以上的预览文件；清不掉返回原因（不吞） */
export async function sweepDecided(dataDir: string, previewDir: string): Promise<string[]> {
  try {
    const all = (await readInbox(dataDir, { withDrafts: true })).items;
    const r = await sweepPreview(previewDir, (c, i) => all.some((x) => x.content_id === c && x.item_id === i));
    return r.errors.map((e) => `会话文件夹里的旧预览没清干净：${e}`);
  } catch (e) {
    return [`会话文件夹里的旧预览没清掉（${(e as Error).message}）`];
  }
}

/** list：可按 content_id / item_id 收窄；带 preview_dir 时先清理再放文件 */
export async function listForChat(dataDir = getDataDir(), input: ListInput = {}): Promise<Result> {
  const warnings = input.preview_dir ? await sweepDecided(dataDir, input.preview_dir) : [];
  const all = (await readInbox(dataDir, { withDrafts: true })).items;
  // 库级条目可能来自多篇稿（同一条手册意见被几篇重复提）：detail.content_ids 里任一篇都算
  const ofContent = (i: InboxItem) => i.content_id === input.content_id || ((i.detail.content_ids as string[] | undefined) ?? []).includes(input.content_id!);
  const items = all.filter((i) => (!input.content_id || ofContent(i)) && (!input.item_id || i.item_id === input.item_id));
  const named = input.item_id ? items.find((i) => i.item_id === input.item_id) : undefined;
  const stale = named ? staleSelector(named, input) : null;
  if (named && stale) return { ok: false, code: "stale_selector", error: stale, item: await present(named, null, dataDir, { ...input, group_id: undefined, fact_id: undefined }), ...(warnings.length ? { warnings } : {}) };
  const many = items.filter(decidable).length > 1;
  let n = 0;
  const shown = [];
  for (const i of items) shown.push(await present(i, many && decidable(i) ? ++n : null, dataDir, input));
  return { ok: true, count: shown.length, items: shown, ...(warnings.length ? { warnings } : {}), next_action: NEXT };
}

/**
 * SessionStart 那一行（§3）：有能在对话里定的事就叫 agent 第一句回复把它们列出来；没有就返回 null，什么都不说。
 */
export async function chatReviewLine(dataDir = getDataDir()): Promise<string | null> {
  const n = (await readInbox(dataDir, { withDrafts: true })).items.filter(decidable).length;
  if (!n) return null;
  return `有 ${n} 件等创始人在对话里拍板：你的第一句回复就调 autocrew_review_inbox{action:"list", preview_dir:<你这个会话的工作目录>}，按返回把它们列给他（Codex 剪辑工位忽略这句）。`;
}
