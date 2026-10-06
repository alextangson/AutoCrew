/**
 * 请示在对话里答（spec 2026-10-06 proactive-chat-review，Addendum：agent asks are chat-decidable）。
 * brief：谁问的、原问题、编号选项（原文）、附件；花费照原话写清钱数与用途。附件：图片 / 视频进会话文件夹；网页只在单看这一件时原地用默认浏览器打开。
 */
import path from "node:path";
import { contentRoot } from "../../../storage/content-project.js";
import type { Ask, ProductionDoc } from "../../../storage/production-types.js";
import type { InboxItem } from "../inbox.js";
import { openPage, type PreviewFile } from "./preview.js";

const IMAGE = /\.(png|jpe?g|webp|gif|heic)$/i;
const HTML = /\.html?$/i;

export const askOf = (item: InboxItem, doc: ProductionDoc): Ask | undefined => (doc.asks ?? []).find((a) => a.id === item.detail.ask_id);
const changedOf = (item: InboxItem) => item.detail.attachments_changed === true;
const whoOf = (item: InboxItem) => item.waiting?.label ?? "agent";

export function askBrief(item: InboxItem, doc: ProductionDoc): string {
  const a = askOf(item, doc);
  if (!a) return `《${item.title}》${whoOf(item)}的请示：记录不在了，刷新再看`;
  const head = `《${item.title}》${whoOf(item)}请示（${a.kind}）：${a.question}`;
  if (changedOf(item)) return [head, "附件在它问你之后变过，这件现在答不了。", `回我「让 ${whoOf(item)} 重发」`].join("\n");
  return [
    head,
    ...(a.kind === "花费" ? [`要花的钱和花在哪（照它的原话）：「${a.question}」`] : []),
    "选项：",
    ...a.options.map((o, i) => `${i + 1}. ${o.label}`),
    ...(a.attachments.length ? [`附件：${a.attachments.map((x) => path.basename(x.path)).join("、")}`] : []),
    "回我选第几个（可以再加几句，比如「第 3 组换成……」）；拿不准对应哪个选项时我会先问你。",
  ].join("\n");
}

/** 请示附件：图片 / 视频放进会话文件夹（交给 placePreview），网页原地打开 */
export async function askAttachments(item: InboxItem, doc: ProductionDoc, dataDir: string, openPages: boolean): Promise<{ files: PreviewFile[]; pages: Array<{ name: string; path: string; opened: boolean; reason: string }> }> {
  const a = askOf(item, doc);
  const out = { files: [] as PreviewFile[], pages: [] as Array<{ name: string; path: string; opened: boolean; reason: string }> };
  if (!a || changedOf(item)) return out;
  const root = contentRoot(item.content_id!, dataDir);
  for (const [i, x] of a.attachments.entries()) {
    const file = path.isAbsolute(x.path) ? x.path : path.join(root, x.path);
    const name = path.basename(file);
    // 网页只在单看这一件（list 带 item_id）时打开，免得每次会话开场都弹浏览器
    if (HTML.test(file)) out.pages.push({ name, ...(openPages ? await openPage(file) : { path: file, opened: false, reason: "没打开；要看就 list{item_id} 单看这一件，会用默认浏览器打开它" }) });
    else out.files.push({ source: file, name: `请示${i + 1}-${name}`, video: !IMAGE.test(file) });
  }
  return out;
}
