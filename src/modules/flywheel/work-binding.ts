/**
 * 人工绑定 + 历史作品记录（回流认领规格 2026-10-03 ③④）。
 *
 * ③ 人工绑定：稿子 id + 平台 + 平台作品 id → 绑定表登记 via=manual（精确事实），
 *    已入账的同作品行按新归属各补一条（append-only，latest-wins）。
 * ④ 历史作品：资料库改造前发布的作品补一条「已发布、imported_history」的记录，只挂绑定不挂正文；
 *    删除时连绑定一起删、撤掉它名下的行，回流原始行重新回到未绑定。
 */
import { getContent, listContents, saveContent, softDeleteContent, getDataDir, type Content } from "../../storage/local-store.js";
import { IMPORTED_HISTORY, isImportedHistory } from "../../storage/imported-history.js";
import { commitManualBinding, readPlatformItemsStrict, platformItemKey, removeBindingsForContent, type PlatformItemBinding } from "./platform-items.js";
import { isTruncatedItemId, normalizePlatform, normalizeTitle } from "./outcome-schema.js";
import { reattributeItem, retractContentOutcomes } from "./outcome-store.js";

/** 回流认得的平台（别名 xhs 先归一） */
export const BINDABLE_PLATFORMS: readonly string[] = ["douyin", "wechat_video", "xiaohongshu", "bilibili", "wechat_mp"];

export type WorkResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; existing?: PlatformItemBinding & { key: string }; partial?: true; written?: string[]; next_action?: string };

export interface ItemRef { platform: string; itemId: string }

/** 平台 / 作品 id 的边界校验；返回规整后的值或说清哪项不对 */
export function checkItemRef(platformRaw: unknown, itemIdRaw: unknown): { ok: true; ref: ItemRef } | { ok: false; error: string } {
  const platform = typeof platformRaw === "string" ? normalizePlatform(platformRaw.trim()) : "";
  if (!BINDABLE_PLATFORMS.includes(platform)) {
    return { ok: false, error: `平台「${String(platformRaw ?? "")}」不认识，只能是 ${BINDABLE_PLATFORMS.join(" / ")}（xhs 也认）` };
  }
  if (typeof itemIdRaw === "number") {
    return { ok: false, error: "平台作品 id 必须按字符串传（数字会丢精度，抖音 19 位 id 尤其如此）" };
  }
  const itemId = typeof itemIdRaw === "string" ? itemIdRaw.trim() : "";
  if (!itemId) return { ok: false, error: "平台作品 id 是空的" };
  if (isTruncatedItemId(platform, itemId)) {
    return { ok: false, error: `抖音作品 id ${itemId} 是被截坏的（…000 结尾的双精度写法），不能拿来绑定——先跑一次抖音回流拿到完整 id` };
  }
  return { ok: true, ref: { platform, itemId } };
}

/** 稿子 id + 平台 + 平台作品 id → 人工绑定 + 补归属。重复执行幂等 */
export async function bindWorkManually(
  contentId: string,
  platformRaw: unknown,
  itemIdRaw: unknown,
  dataDir?: string,
): Promise<WorkResult<{ status: "bound" | "already"; platform: string; itemId: string; reattributed: number }>> {
  const content = contentId ? await getContent(contentId, dataDir) : null;
  if (!content || content.deletedAt) return { ok: false, error: `稿子 id「${contentId}」不存在` };
  const checked = checkItemRef(platformRaw, itemIdRaw);
  if (!checked.ok) return checked;
  const { platform, itemId } = checked.ref;
  let result: Awaited<ReturnType<typeof commitManualBinding>>;
  try {
    result = await commitManualBinding(platform, itemId, content.id, dataDir);
  } catch (err) {
    return { ok: false, error: errText(err) }; // 绑定表读不出 / 写不进：此时还什么都没写
  }
  if (result.status === "conflict") {
    return {
      ok: false,
      error: `${platform}:${itemId} 已绑定稿子 ${result.existing.contentId}（${result.existing.via}，${result.existing.boundAt}）——不覆盖，要改先解绑`,
      existing: { key: `${platform}:${itemId}`, ...result.existing },
    };
  }
  // 补归属本身幂等（同稿同数据日期已有行就跳过），所以「已绑定」时也跑一遍，补上次中断漏的行
  try {
    const reattributed = await reattributeItem(platform, itemId, content.id, dataDir);
    return { ok: true, status: result.status, platform, itemId, reattributed };
  } catch (err) {
    return partial(`补归属已入账数据失败：${errText(err)}`, [`绑定 ${platform}:${itemId} → ${content.id}（via=manual）`],
      "绑定已写入、已入账的数据还没补归属。修好账本问题后重跑同一个 work_bind 即可补齐（幂等，不会重复追加）。");
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 多步写入中途失败：如实列出已经写进去的部分和恢复办法，不假装回滚 */
function partial(error: string, written: string[], nextAction: string): { ok: false; error: string; partial: true; written: string[]; next_action: string } {
  return { ok: false, error, partial: true, written, next_action: nextAction };
}

export interface HistoryInput { title: string; publishedDate: string; items: ItemRef[] }

function historyDate(c: Content): string {
  return (c.publishedAt ?? "").slice(0, 10);
}

/** 已有的同一条历史记录：同标题（归一化）+ 同发布日期 */
async function findHistory(title: string, date: string, dataDir?: string): Promise<Content | null> {
  const norm = normalizeTitle(title);
  return (await listContents(dataDir)).find((c) => isImportedHistory(c) && normalizeTitle(c.title) === norm && historyDate(c) === date) ?? null;
}

/** 建 / 删历史记录在同一进程内串行：查重、建记录、挂绑定是一个整体，并发的同名请求不能都判「不存在」 */
const historyChains = new Map<string, Promise<unknown>>();
function serializeHistory<T>(dataDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = getDataDir(dataDir);
  const next = (historyChains.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.then(() => undefined, () => undefined);
  historyChains.set(key, tail);
  void tail.then(() => { if (historyChains.get(key) === tail) historyChains.delete(key); });
  return next;
}

type HistoryCreated = WorkResult<{ status: "created" | "exists"; contentId: string; bindings: Array<{ platform: string; itemId: string; status: string; reattributed: number }> }>;

function parseHistoryInput(raw: { title?: unknown; published_date?: unknown; items?: unknown }): { ok: true; title: string; date: string; items: ItemRef[] } | { ok: false; error: string } {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return { ok: false, error: "历史记录需要标题" };
  const date = typeof raw.published_date === "string" ? raw.published_date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return { ok: false, error: `发布日期「${String(raw.published_date ?? "")}」不是 YYYY-MM-DD` };
  if (!Array.isArray(raw.items) || raw.items.length === 0) return { ok: false, error: "历史记录至少要挂一个平台作品（items:[{platform,item_id}]）" };
  const items: ItemRef[] = [];
  for (const [i, it] of raw.items.entries()) {
    const obj = (it ?? {}) as Record<string, unknown>;
    const checked = checkItemRef(obj.platform, obj.item_id);
    if (!checked.ok) return { ok: false, error: `items[${i}]：${checked.error}` };
    items.push(checked.ref);
  }
  return { ok: true, title, date, items };
}

/**
 * 建历史作品记录。同标题同日期已存在 → 认作同一条，不重复建（只补没挂上的绑定）。
 * 任何一个平台作品已绑给别的稿、或绑定表读不出 → 整条拒绝，什么都不写（先查后建）。
 */
export async function createHistoryRecord(raw: { title?: unknown; published_date?: unknown; items?: unknown }, dataDir?: string): Promise<HistoryCreated> {
  const input = parseHistoryInput(raw);
  if (!input.ok) return input;
  return serializeHistory(dataDir, () => createLocked(input, dataDir));
}

async function createLocked(input: { title: string; date: string; items: ItemRef[] }, dataDir?: string): Promise<HistoryCreated> {
  const { title, date, items } = input;
  const existing = await findHistory(title, date, dataDir);
  let table: Awaited<ReturnType<typeof readPlatformItemsStrict>>;
  try { table = await readPlatformItemsStrict(dataDir); } catch (err) { return { ok: false, error: errText(err) }; }
  for (const it of items) {
    const bound = table[platformItemKey(it.platform, it.itemId)];
    if (bound && bound.contentId !== existing?.id) {
      return { ok: false, error: `${it.platform}:${it.itemId} 已绑定稿子 ${bound.contentId}——不覆盖，这条历史记录没有建`, existing: { key: `${it.platform}:${it.itemId}`, ...bound } };
    }
  }
  const record = existing ?? await saveContent({
    title, body: "", platform: items[0].platform, status: "published", tags: ["历史作品"],
    source: IMPORTED_HISTORY, publishedAt: `${date}T00:00:00+08:00`,
  }, getDataDir(dataDir));
  const written = existing ? [] : [`历史记录 ${record.id}`];
  const bindings = [];
  for (const it of items) {
    const r = await bindWorkManually(record.id, it.platform, it.itemId, dataDir);
    if (!r.ok) {
      return partial(r.error, [...written, ...bindings.map((b) => `绑定 ${b.platform}:${b.itemId}`), ...("written" in r ? r.written as string[] : [])],
        `历史记录 ${record.id} 已${existing ? "存在" : "建好"}，挂绑定中途失败。修好原因后重跑同一个 history_create 会认出这条记录并补齐；不想要就用 history_delete{content_id:"${record.id}"} 撤掉。`);
    }
    bindings.push({ platform: it.platform, itemId: it.itemId, status: r.status, reattributed: r.reattributed });
  }
  return { ok: true, status: existing ? "exists" : "created", contentId: record.id, bindings };
}

/** 删历史记录：删绑定 → 撤它名下的行（先补未归属副本）→ 记录进回收站。只删 imported_history */
export async function deleteHistoryRecord(contentId: string, dataDir?: string): Promise<WorkResult<{ removedBindings: string[]; retracted: number }>> {
  const content = contentId ? await getContent(contentId, dataDir) : null;
  if (!content || content.deletedAt) return { ok: false, error: `稿子 id「${contentId}」不存在` };
  if (!isImportedHistory(content)) return { ok: false, error: "这不是历史作品记录（imported_history），history_delete 只删历史记录" };
  return serializeHistory(dataDir, async () => {
    let removedBindings: string[];
    try { removedBindings = await removeBindingsForContent(content.id, dataDir); } catch (err) { return { ok: false, error: errText(err) }; }
    const again = `重跑同一个 history_delete 会接着做完（幂等）。`;
    let retracted: number;
    try { retracted = await retractContentOutcomes(content.id, dataDir); } catch (err) {
      return partial(`撤回它名下的数据失败：${errText(err)}`, removedBindings.map((k) => `已删绑定 ${k}`), `绑定已删，数据还挂在这条记录名下、记录也还在。${again}`);
    }
    try { await softDeleteContent(content.id, dataDir); } catch (err) {
      return partial(`记录移进回收站失败：${errText(err)}`, [...removedBindings.map((k) => `已删绑定 ${k}`), `已撤回 ${retracted} 行数据`], `绑定已删、数据已回到未绑定，记录本身还在。${again}`);
    }
    return { ok: true, removedBindings, retracted };
  });
}
