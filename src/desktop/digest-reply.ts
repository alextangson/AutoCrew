/**
 * 摘要回复处理（每日选题摘要 spec §2.4）——白名单用户发来一条**纯数字**，且盘上存在
 * 上一份清单时，这条消息不是灵感，是一个动作。
 *
 * 三条纪律：
 * 1. **拦在入账之前**：纯数字进灵感库等于每回一次就多一条「灵感：3」——所以本函数返回
 *    true 的那一刻，poller 就不再 appendItem（seam 在 `telegram-poller.handleUpdate`）。
 * 2. **回复永远对最新一份清单生效**，那份不是今天的就在回复里带上它的日期——
 *    不说日期，用户会以为自己点的是今天的第 3 条。
 * 3. **拒绝要说原话**：搜索没配就把 `SEARCH_NOT_CONFIGURED` 那句人话发回去，不起 job、
 *    不假装已排队（「点了没反应」是最坏的失败形态）。
 */
import { sendTelegramReceipt } from "../modules/inbox/telegram-api.js";
import {
  interpretDigestReply,
  jobStatusReply,
  outOfRangeReply,
  staleDigestPrefix,
  startedReply,
  DIGEST_SKIP_REPLY,
  type DigestReply,
} from "../modules/inbox/daily-digest.js";
import { getJob } from "../modules/research/research-job-store.js";
import { getDataDir } from "../storage/local-store.js";
import { triggerDeepResearch } from "./research-runtime.js";
import type { InboxSettings } from "./settings-inbox.js";
import { digestDataDir } from "./digest-scheduler.js";
import { loadDigestState, localDateKey, patchDigestState } from "./digest-state.js";

export interface DigestReplyMessage {
  text: string;
  chatId?: number;
}

export interface DigestReplyDeps {
  settings: InboxSettings;
  /** 状态与选题的落点；缺省跟调度器同一个工作区（回复必须读它写的那份清单） */
  dataDir?: string;
  reply?: (chatId: number, text: string) => Promise<boolean>;
  trigger?: typeof triggerDeepResearch;
  getJobImpl?: typeof getJob;
  now?: () => number;
}

/** 记下「这个序号已经起过调研」——同一个数字再回一次就是查进度，不是再起一轮 */
async function markPicked(n: number, dataDir: string | undefined): Promise<void> {
  const state = await loadDigestState(dataDir);
  if (!state.lastDigest) return;
  const picked = state.lastDigest.picked ?? [];
  if (picked.includes(n)) return;
  await patchDigestState({ lastDigest: { ...state.lastDigest, picked: [...picked, n] } }, dataDir);
}

async function pickText(
  action: Extract<DigestReply, { kind: "pick" }>,
  deps: DigestReplyDeps,
  dataDir: string | undefined,
): Promise<string> {
  const { item } = action;
  if (action.repeat) {
    const job = await (deps.getJobImpl ?? getJob)(item.topicId, getDataDir(dataDir));
    return jobStatusReply(item.title, job?.status, job?.failReason);
  }
  const res = await (deps.trigger ?? triggerDeepResearch)(item.topicId, dataDir);
  if (!res.accepted) return res.reason; // 搜索未配 / 研究进行中 / 投递失败：原话回给 Telegram
  await markPicked(action.n, dataDir);
  return startedReply(item.title);
}

async function replyText(
  action: DigestReply,
  deps: DigestReplyDeps,
  dataDir: string | undefined,
): Promise<string | null> {
  switch (action.kind) {
    case "skip":
      return DIGEST_SKIP_REPLY;
    case "out_of_range":
      return outOfRangeReply(action.count);
    case "pick":
      return pickText(action, deps, dataDir);
    default:
      return null;
  }
}

/**
 * 返回 true = 这条消息已被当作摘要回复处理完，**不要**再入灵感账。
 * 返回 false = 它不是回复（不是纯数字，或盘上还没有任何清单），照常走原路。
 */
export async function handleDigestReply(msg: DigestReplyMessage, deps: DigestReplyDeps): Promise<boolean> {
  const dataDir = deps.dataDir ?? digestDataDir();
  const state = await loadDigestState(dataDir);
  const action = interpretDigestReply(msg.text, state.lastDigest);
  if (action.kind === "none") return false;

  const text = await replyText(action, deps, dataDir);
  if (text === null) return false;
  if (msg.chatId === undefined) return true; // 回不了话也不该把「3」记成灵感

  const now = (deps.now ?? Date.now)();
  const prefix = state.lastDigest ? staleDigestPrefix(state.lastDigest.date, localDateKey(now)) : "";
  const send =
    deps.reply ??
    ((chatId: number, body: string) =>
      sendTelegramReceipt(chatId, body, {
        botToken: deps.settings.botToken,
        ...(deps.settings.proxyUrl ? { proxyUrl: deps.settings.proxyUrl } : {}),
      }));
  await send(msg.chatId, prefix ? `${prefix}${text}` : text);
  return true;
}
