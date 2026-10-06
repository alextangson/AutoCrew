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
import { briefOf, pickedGroup, pickedVersion } from "./brief.js";
import { factPath } from "./files.js";
import { placePreview, sweepPreview, type PreviewFile } from "./preview.js";
import { CHAT_ACTIONS, chatItem } from "./view.js";

type Result = Record<string, unknown>;
export interface ListInput { preview_dir?: string; content_id?: string; item_id?: string; group_id?: string; fact_id?: string }

const decidable = (i: InboxItem) => Boolean(CHAT_ACTIONS[i.type]) && Boolean(i.content_id);
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
  const doc = await readProductionDocOrEmpty(item.content_id!, dataDir);
  const sel = input.item_id === item.item_id ? input : {};
  const brief = await briefOf(item, doc, dataDir, sel);
  const shown = item.type === "cover_pick" ? { group_id: pickedGroup(item, sel.group_id)?.group_id }
    : item.type === "cut_review" ? { fact_id: pickedVersion(item, sel.fact_id)?.fact_id } : {};
  const preview = input.preview_dir
    ? await placePreview(input.preview_dir, item.title, { content_id: item.content_id!, item_id: item.item_id }, previewFiles(item, doc, dataDir, sel))
    : null;
  return { ...base, ...(n ? { number: n } : {}), brief: n ? `${n}. ${brief}` : brief, shown, ...(preview ? { preview } : {}) };
}

const NEXT = [
  "把每件的 brief 原样转述给创始人（不要自己加判断标准）；preview.files 的 path 写成 markdown 链接让他点开，preview.opened / problems 照说。",
  "不止一件时按 number 列成编号清单，他可以回「1 用，2 还要改：……」。说「用」就按 shown 里的 group_id / fact_id decide。",
  "他想看更早的一组 / 一版：list{item_id, group_id 或 fact_id, preview_dir} 只放那一个。chat_decidable:false 的给 board_link。",
].join("");

/** 清掉已定的事的预览文件、7 天以上的预览文件 */
export async function sweepDecided(dataDir: string, previewDir: string): Promise<void> {
  const all = (await readInbox(dataDir)).items;
  await sweepPreview(previewDir, (c, i) => all.some((x) => x.content_id === c && x.item_id === i));
}

/** list：可按 content_id / item_id 收窄；带 preview_dir 时先清理再放文件 */
export async function listForChat(dataDir = getDataDir(), input: ListInput = {}): Promise<Result> {
  if (input.preview_dir) await sweepDecided(dataDir, input.preview_dir).catch(() => undefined);
  const all = (await readInbox(dataDir)).items;
  const items = all.filter((i) => (!input.content_id || i.content_id === input.content_id) && (!input.item_id || i.item_id === input.item_id));
  const many = items.filter(decidable).length > 1;
  let n = 0;
  const shown = [];
  for (const i of items) shown.push(await present(i, many && decidable(i) ? ++n : null, dataDir, input));
  return { ok: true, count: shown.length, items: shown, next_action: NEXT };
}

/**
 * SessionStart 那一行（§3）：有能在对话里定的事就叫 agent 第一句回复把它们列出来；没有就返回 null，什么都不说。
 */
export async function chatReviewLine(dataDir = getDataDir()): Promise<string | null> {
  const n = (await readInbox(dataDir)).items.filter(decidable).length;
  if (!n) return null;
  return `有 ${n} 件等创始人在对话里拍板：你的第一句回复就调 autocrew_review_inbox{action:"list", preview_dir:<你这个会话的工作目录>}，按返回把它们列给他（Codex 剪辑工位忽略这句）。`;
}
