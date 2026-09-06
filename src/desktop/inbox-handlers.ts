/**
 * 灵感收件箱工作台 handlers（收件箱设计 §4）：
 * `inbox:list / retry / delete / reingest / status` + 配置读写透传。
 *
 * 四条纪律：
 * 1. **读的是 targetWorkspaceId 那个工作区，不是「当前工作区」**——台账由 worker 写在
 *    那儿（§2.1「消息固定落 targetWorkspaceId」）。runtime 已解析出 dataDir 就以它为准，
 *    没起来才回退当前工作区（那时台账本来就是空的）。
 * 2. **台账永不物理删**（§3.1）：`inbox:delete` 的语义是「从视图隐藏」——写 hiddenAt
 *    时间戳，查重/追溯/启动补扫读到的仍是全量。传 restore 即恢复，移除有后悔药。
 * 3. **worker 没起来不假装成功**：retry/reingest 回 `queued:false` + 人话说明，
 *    视图照实显示；item 已置回 pending，worker 起来时的启动补扫会吃掉它。
 * 4. **终态复活由本层显式改状态**：worker 的 claim 门不收 digested/rejected，
 *    retryInboxItem 也不替调用方决定——「人工翻案」是这里的语义，不是 worker 的。
 */
import { getDataDir } from "../storage/local-store.js";
import { getItem, listItems, updateItem, type InboxItem, type InboxStatus } from "../modules/inbox/inbox-store.js";
import { getInboxRuntimeStatus, retryInboxItem } from "./inbox-runtime.js";
import { getDigestStatus, sendDigestNow } from "./digest-scheduler.js";

type Payload = Record<string, unknown>;
type Reply = Record<string, unknown>;

/** worker 未运行时的人话出口——绝不吞成「已重试」 */
const RUNTIME_DOWN =
  "收件箱 worker 没在跑（去设置页 · 灵感收件箱 配好 Telegram bot）——这条已排回队列，worker 起来会自动处理";

function badPayload(payload: Payload): Reply | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  return null;
}

function fail(err: unknown): Reply {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/**
 * 台账所在目录。runtime 已接线（running）时它就是 targetWorkspace 的 dataDir；
 * 未配置/工作区缺失时回退当前工作区——此时视图顶部会显示配对引导，列表空也说得通。
 */
export function inboxDataDir(payload: Payload): string {
  return getInboxRuntimeStatus().dataDir ?? (payload._dataDir as string) ?? getDataDir();
}

function requireId(payload: Payload): string | null {
  return typeof payload.id === "string" && payload.id.trim() ? payload.id.trim() : null;
}

/** 处理中的条目不许被人工掀翻：worker 正握着 lease，改状态会导致同一条被跑两遍 */
function busy(item: InboxItem): Reply | null {
  return item.status === "fetching"
    ? { ok: false, error: "这条正在处理中——等它跑完（或 10 分钟租约过期自动回收）再操作" }
    : null;
}

/** 台账是 FIFO 升序（老的在前），视图要新的在前——倒序在这里做，不动 store 的队列语义 */
export async function inboxListHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  try {
    const all = (await listItems(inboxDataDir(payload))).reverse();
    const visible = payload.include_hidden === true ? all : all.filter((it) => !it.hiddenAt);
    const counts: Partial<Record<InboxStatus, number>> = {};
    for (const it of visible) counts[it.status] = (counts[it.status] ?? 0) + 1;
    return {
      ok: true,
      data: {
        items: visible,
        counts,
        total: visible.length,
        hidden: all.filter((it) => it.hiddenAt).length,
      },
    };
  } catch (err) {
    return fail(err);
  }
}

/**
 * 重试。failed/blocked 走 worker 的 claim 门（attempts 超限由 retryInboxItem 清零）；
 * rejected 是终态、门不收——先翻回 pending 才是真的「人工复活」。
 * stage 保留：`both` 判定的 checkpoint 跨重试存活，接着断点续做（要从头来用 reingest）。
 */
export async function inboxRetryHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const id = requireId(payload);
  if (!id) return { ok: false, error: "id 必填" };
  try {
    const dataDir = inboxDataDir(payload);
    const item = await getItem(id, dataDir);
    if (!item) return { ok: false, error: `收件箱没有这一条：${id}` };
    const blocked = busy(item);
    if (blocked) return blocked;
    if (item.status === "digested") {
      return { ok: false, error: "这条已经消化完成——要重来请用「重新消化」" };
    }
    const revived =
      item.status === "rejected"
        ? await updateItem(id, { status: "pending", errorCode: undefined, failReason: undefined, retryable: undefined }, dataDir)
        : item;
    const queued = await retryInboxItem(id);
    return { ok: true, data: { item: revived ?? item, queued, ...(queued ? {} : { note: RUNTIME_DOWN }) } };
  } catch (err) {
    return fail(err);
  }
}

/**
 * 重新消化（digested/rejected 一键重新入库）：清 stage 与 attempts 回 pending，从头走一遍。
 * verdict/targetIds 留着——重跑失败时旧落点还在，追溯不断；跑成功会被覆盖。
 * 落库端各自幂等（卡按 `pat-<itemId>`、题按 canonicalUrl），重来不会产生第二张卡（§3.1）。
 */
export async function inboxReingestHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const id = requireId(payload);
  if (!id) return { ok: false, error: "id 必填" };
  try {
    const dataDir = inboxDataDir(payload);
    const item = await getItem(id, dataDir);
    if (!item) return { ok: false, error: `收件箱没有这一条：${id}` };
    const blocked = busy(item);
    if (blocked) return blocked;
    const next = await updateItem(
      id,
      {
        status: "pending",
        stage: undefined,
        attempts: 0,
        claimedAt: undefined,
        errorCode: undefined,
        failReason: undefined,
        retryable: undefined,
      },
      dataDir,
    );
    const queued = await retryInboxItem(id);
    return { ok: true, data: { item: next ?? item, queued, ...(queued ? {} : { note: RUNTIME_DOWN }) } };
  } catch (err) {
    return fail(err);
  }
}

/**
 * 从视图移除 / 恢复。**不删台账**——只写 hiddenAt（§3.1 永久台账）。
 * 代价说清楚：被移除的条目仍参与查重，同链接再转发会回「已收录过」并指向它。
 */
export async function inboxDeleteHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const id = requireId(payload);
  if (!id) return { ok: false, error: "id 必填" };
  try {
    const dataDir = inboxDataDir(payload);
    const item = await getItem(id, dataDir);
    if (!item) return { ok: false, error: `收件箱没有这一条：${id}` };
    const restore = payload.restore === true;
    const next = await updateItem(id, { hiddenAt: restore ? undefined : new Date().toISOString() }, dataDir);
    return { ok: true, data: { item: next ?? item, hidden: !restore } };
  } catch (err) {
    return fail(err);
  }
}

/**
 * runtime 状态透传（doctor 与设置页同源）：未配置/工作区缺失也是正常返回，不是错误。
 * `digest` 是每日选题摘要的状态（摘要 spec §2.5）——现读状态文件，读不出来不阻断本通道。
 */
export async function inboxStatusHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const digest = await getDigestStatus().catch(() => null);
  return { ok: true, data: { ...getInboxRuntimeStatus(), ...(digest ? { digest } : {}) } };
}

/**
 * 「现在发一份」（摘要 spec §2.5）：绕过当天幂等，但 60 秒内连点第二次会被挡下。
 * 发出去的这一份会**替换** lastDigest——之后回的数字按新清单算。
 */
export async function inboxDigestSendNowHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  // 不吃 payload._dataDir：摘要状态归调度器所有，按「当前工作区」另写一份会让
  // 「现在发一份」和到点自动发各记各的清单，回复就对不上号了
  const res = await sendDigestNow();
  if (!res.ok) return { ok: false, error: res.error ?? "摘要发送失败" };
  return {
    ok: true,
    data: {
      count: res.count ?? 0,
      message: res.count ? `已发出 ${res.count} 条选题` : "已发出（今天雷达没有新的命中定位的选题）",
    },
  };
}
