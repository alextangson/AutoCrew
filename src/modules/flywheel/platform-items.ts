/**
 * 平台作品 id ↔ 稿件绑定表 `<dataDir>/platform-items.json`（spec §5.1）。
 *
 * 为什么单独一张表：content meta 保持单向数据流（回流侧不回写稿件），绑定是 flywheel
 * 私有的索引。语义上它是**缓存不是账本**——丢了/坏了只是退回按标题模糊认领，
 * 所以损坏一律重建空表 + warn，不阻塞任何入库。
 *
 * 自愈路线：首次靠「链接解析出的 id 相等」或「精确标题命中」认对一次，之后同一 itemId
 * 永远精确命中——哪怕作品标题后来被改过（dice 模糊命中置信不够，不登记）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";
import { writeJsonAtomic } from "../../storage/json-atomic.js";
import { normalizePlatform } from "./outcome-schema.js";
import { resolvePublishUrl } from "./publish-url.js";

const ITEMS_FILE = "platform-items.json";
const SCHEMA_VERSION = 1;

/** 绑定证据：url = 链接解析出的 id 对上；title = 归一化标题精确命中 */
export type BindingVia = "url" | "title";

export interface PlatformItemBinding {
  contentId: string;
  boundAt: string;
  via: BindingVia;
}

export interface PlatformItemsFile {
  schemaVersion: number;
  items: Record<string, PlatformItemBinding>;
}

/** 待登记的绑定：解析阶段产出，落盘成功后由调用方提交 */
export interface PendingBinding {
  platform: string;
  itemId: string;
  contentId: string;
  via: BindingVia;
}

function itemsPath(dataDir?: string): string {
  return path.join(getDataDir(dataDir), ITEMS_FILE);
}

export function platformItemKey(platform: string, itemId: string): string {
  return `${normalizePlatform(platform)}:${itemId.trim()}`;
}

function isBinding(value: unknown): value is PlatformItemBinding {
  const b = value as PlatformItemBinding | null;
  return !!b && typeof b.contentId === "string" && (b.via === "url" || b.via === "title");
}

/**
 * 读全表。不存在 → 空表；损坏/版本不认 → 空表 + warn（下一次写入自然重建文件）。
 * 读路径不写盘：读不该有副作用，坏文件留在原地也方便人去看一眼。
 */
export async function readPlatformItems(dataDir?: string): Promise<Record<string, PlatformItemBinding>> {
  const file = itemsPath(dataDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return {};
    console.warn(`[flywheel] 绑定表读不出(${(err as Error).message})——按空表处理，绑定退回标题匹配`);
    return {};
  }
  let parsed: PlatformItemsFile | null = null;
  try {
    parsed = JSON.parse(raw) as PlatformItemsFile;
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed.items !== "object" || !parsed.items) {
    console.warn("[flywheel] 绑定表损坏或版本不认——重建空表，绑定退回标题匹配后重新自愈");
    return {};
  }
  const items: Record<string, PlatformItemBinding> = {};
  for (const [key, value] of Object.entries(parsed.items)) {
    if (isBinding(value)) items[key] = value; // 单条坏值不废掉整张表
  }
  return items;
}

export async function lookupPlatformItem(
  platform: string,
  itemId: string,
  dataDir?: string,
): Promise<PlatformItemBinding | null> {
  if (!itemId.trim()) return null;
  const items = await readPlatformItems(dataDir);
  return items[platformItemKey(platform, itemId)] ?? null;
}

/**
 * 进程内绑定表写队列（仿 outcome-store 的 serializeOutcomeWrite）。
 * **必须与 outcomes 写队列分开**：登记绑定发生在 recordOutcome/importPerformanceRows
 * 的写事务内部，共用一条链会自己等自己 → 死锁。
 */
const bindingWriteChains = new Map<string, Promise<unknown>>();

function serializeBindingWrite<T>(dataDir: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = getDataDir(dataDir);
  const prev = bindingWriteChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn); // 前一步失败也不许卡住后一步
  const tail = next.then(() => undefined, () => undefined);
  bindingWriteChains.set(key, tail);
  void tail.then(() => {
    if (bindingWriteChains.get(key) === tail) bindingWriteChains.delete(key);
  });
  return next;
}

/** 已有绑定只被更强证据顶替：url（人贴的链接/解析出的 id）> title（精确标题命中） */
function shouldOverwrite(existing: PlatformItemBinding | undefined, next: PendingBinding): boolean {
  if (!existing) return true;
  if (existing.contentId === next.contentId && existing.via === next.via) return false;
  return next.via === "url" && existing.via === "title";
}

/**
 * 提交绑定（批量一次落盘）。返回真正写进去的条数。
 * 已存在且证据不更强的键原样保留——「首次认对以后永远精确」，冲突走 needsReview 让人裁，
 * 不在这里自动改判。
 */
export async function commitBindings(pending: PendingBinding[], dataDir?: string): Promise<number> {
  if (pending.length === 0) return 0;
  return serializeBindingWrite(dataDir, async () => {
    const items = await readPlatformItems(dataDir);
    const boundAt = new Date().toISOString();
    let written = 0;
    for (const p of pending) {
      const key = platformItemKey(p.platform, p.itemId);
      if (!p.itemId.trim() || !p.contentId || !shouldOverwrite(items[key], p)) continue;
      items[key] = { contentId: p.contentId, boundAt, via: p.via };
      written += 1;
    }
    if (written === 0) return 0;
    await fs.mkdir(getDataDir(dataDir), { recursive: true });
    const file: PlatformItemsFile = { schemaVersion: SCHEMA_VERSION, items };
    await writeJsonAtomic(itemsPath(dataDir), file);
    return written;
  });
}

/** 某稿件当前持有的全部绑定（对账/展示用） */
export async function bindingsForContent(
  contentId: string,
  dataDir?: string,
): Promise<Array<{ key: string } & PlatformItemBinding>> {
  const items = await readPlatformItems(dataDir);
  return Object.entries(items)
    .filter(([, b]) => b.contentId === contentId)
    .map(([key, b]) => ({ key, ...b }));
}

/**
 * 确认发布/补记链接时直接按链接登记绑定（spec §5.1 ①）——不必等下一次数据回流。
 * 短链会跟一次重定向（注入 fetch，5s/3 跳上限）；解析不出返回 null，**不阻塞发布确认**。
 */
export async function bindByPublishUrl(
  contentId: string,
  platform: string | null | undefined,
  publishUrl: string,
  dataDir?: string,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  // resolvePublishUrl 只在「纯解析失败且确实是短链域」时才付一次网络往返，直链不打网
  const parsed = await resolvePublishUrl(publishUrl, platform ?? undefined, fetchImpl);
  if (!parsed) return null;
  await commitBindings([{ ...parsed, contentId, via: "url" }], dataDir);
  return parsed.itemId;
}
