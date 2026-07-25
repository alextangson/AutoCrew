/**
 * 灵感收件箱 · Telegram bot 配置（设计 spec §2.1「工作区归属」）。
 *
 * 单独成文件、不并进 settings.ts，是因为落盘根不同：engine/search/publish 都写
 * **工作区** <dataDir>（server 端从注册表解析后注入 _dataDir），而收件箱写**全局根**
 * ~/.autocrew/inbox.json，绝不跟工作区走——同一 bot 的 getUpdates 只允许一个消费
 * 游标，worker 只能是 server 进程内的全局单例。消息固定落 targetWorkspaceId 指定的
 * 工作区，换目标 = 改配置，而不是切「当前工作区」。
 *
 * 根目录解析与 workspace-store 同款：getDataDir() 不带参 = AUTOCREW_DATA_DIR 或
 * ~/.autocrew（workspace-store 也拿它当注册表与子工作区的父目录）。rootDir/_rootDir
 * 仅供测试注入——下划线前缀键在 IPC 边界被 sanitizePayload 剥掉，前端伪造不进来。
 *
 * 读侧一律掩码（token 与代理凭证），renderer 拿不到原文；worker 走
 * getInboxSettingsRaw()，不经 IPC。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../storage/local-store.js";

/** 与 settings.ts / cover-handlers.ts 同款格式（各模块自持一份，既有惯例） */
function maskKey(key: string): string {
  return key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** 收件箱配置。userId 一律 string：TG id 已越过 JS 安全整数区间，用 number 会丢精度 */
export interface InboxSettings {
  botToken: string;
  /** 首次 getMe 获取并锁定；与 offset 文件里的 botId 不一致 = 换了 bot，重置 offset */
  botId?: string;
  /** 白名单外的消息静默忽略（不回执，避免探测）；空 = 谁都不放行 */
  allowedUserIds: string[];
  /** 消息固定落这个工作区，不跟随「当前工作区」切换 */
  targetWorkspaceId: string;
  /** 大陆网络必须（Node fetch 不自动走系统代理）；含账密时读侧脱敏 */
  proxyUrl?: string;
  /**
   * 抖音解析器（justoneapi）的 key。缺省 = 抖音链接落 blocked + 指引，不静默降级
   * 去通用抓取。**不走 proxyUrl**——那条代理是 Telegram 通道的（spec §3.2）。
   */
  justoneapiKey?: string;
}

const INBOX_FILE = "inbox.json";
/** 与 workspace-store 的 DEFAULT_ID 对齐——注册表首读恒有这一条 */
const DEFAULT_WORKSPACE_ID = "default";
const INBOX_FIELDS = [
  "bot_token",
  "bot_id",
  "allowed_user_ids",
  "target_workspace_id",
  "proxy_url",
  "justoneapi_key",
];
/** TG user id 恒为正整数；非数字的白名单永远匹配不上，必须当场拒而不是静默失效 */
const TG_USER_ID_RE = /^\d{1,20}$/;
/** scheme://user[:pass]@host —— 只吃凭证段，端口/路径原样保留 */
const PROXY_CRED_RE = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]+@/i;

function inboxFilePath(rootDir?: string): string {
  return path.join(getDataDir(rootDir), INBOX_FILE);
}

/** 代理串凭证段脱敏（spec §3.2）；无凭证或不成串则原样回——它不是密钥，不瞎猜 */
function maskProxyUrl(url: string): string {
  return PROXY_CRED_RE.test(url) ? url.replace(PROXY_CRED_RE, "$1***:***@") : url;
}

async function readInboxJson(rootDir?: string): Promise<Partial<InboxSettings>> {
  try {
    return JSON.parse(await fs.readFile(inboxFilePath(rootDir), "utf-8")) as Partial<InboxSettings>;
  } catch (err) {
    // 首次没文件 = 未配置；文件坏了要炸出来（静默当空会把真配置覆盖掉）
    if ((err as { code?: string }).code !== "ENOENT") throw err;
    return {};
  }
}

/** 补齐缺省，把磁盘上的半成品收敛成完整结构 */
function normalizeInbox(raw: Partial<InboxSettings>): InboxSettings {
  return {
    botToken: raw.botToken ?? "",
    ...(raw.botId ? { botId: raw.botId } : {}),
    allowedUserIds: Array.isArray(raw.allowedUserIds) ? raw.allowedUserIds : [],
    targetWorkspaceId: raw.targetWorkspaceId || DEFAULT_WORKSPACE_ID,
    ...(raw.proxyUrl ? { proxyUrl: raw.proxyUrl } : {}),
    ...(raw.justoneapiKey ? { justoneapiKey: raw.justoneapiKey } : {}),
  };
}

/** worker 专用的未掩码读取（不经 IPC 暴露）。未配置（无文件 / 无 token）→ null */
export async function getInboxSettingsRaw(rootDir?: string): Promise<InboxSettings | null> {
  const raw = normalizeInbox(await readInboxJson(rootDir));
  return raw.botToken ? raw : null;
}

/** 收件箱配置读：token 掩码、proxy 凭证脱敏——renderer 永远拿不到原文 */
export async function getInboxSettings(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const cfg = normalizeInbox(await readInboxJson((payload._rootDir as string) || undefined));
    return {
      ok: true,
      data: {
        configured: Boolean(cfg.botToken),
        botTokenMasked: cfg.botToken ? maskKey(cfg.botToken) : null,
        botId: cfg.botId ?? null,
        allowedUserIds: cfg.allowedUserIds,
        targetWorkspaceId: cfg.targetWorkspaceId,
        proxyUrlMasked: cfg.proxyUrl ? maskProxyUrl(cfg.proxyUrl) : null,
        justoneapiConfigured: Boolean(cfg.justoneapiKey),
        justoneapiKeyMasked: cfg.justoneapiKey ? maskKey(cfg.justoneapiKey) : null,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 白名单入参：数组或分隔串（GUI 是一个文本框）。去空、去重、逐条校验 */
function parseAllowedUserIds(input: unknown): { ids: string[] } | { error: string } {
  const parts = Array.isArray(input) ? input : typeof input === "string" ? input.split(/[\s,，、]+/) : null;
  if (!parts) return { error: "allowed_user_ids 必须是字符串数组或逗号分隔的字符串" };
  const ids: string[] = [];
  for (const part of parts) {
    if (typeof part !== "string") return { error: "allowed_user_ids 只接受字符串（数字型 id 会丢精度）" };
    const clean = part.trim();
    if (!clean) continue;
    if (!TG_USER_ID_RE.test(clean)) return { error: `allowed_user_ids 含非法 Telegram 用户 id：${clean}` };
    if (!ids.includes(clean)) ids.push(clean);
  }
  return { ids };
}

/**
 * 把 payload 增量应用到 next（就地改），返回错误串或 null。
 * 掩码值原样回传 = 用户没动那一格，保留旧真值——设置页拿掩码当 placeholder 回显，
 * 服务端必须兜死，不能指望前端「空则不提交」。
 */
function applyInboxUpdates(next: InboxSettings, payload: Record<string, unknown>): string | null {
  if (payload.bot_token !== undefined) {
    const v = payload.bot_token;
    if (typeof v !== "string" || !v.trim()) return "bot_token 必须是非空字符串";
    const clean = v.trim();
    const echo = Boolean(next.botToken) && clean === maskKey(next.botToken);
    if (!echo && clean !== next.botToken) {
      next.botToken = clean;
      delete next.botId; // 换 token 可能换 bot：botId 交回 getMe 重新锁定，offset 随之重置
    }
  }
  if (payload.bot_id !== undefined) {
    const v = payload.bot_id;
    if (typeof v !== "string" || !v.trim()) return "bot_id 必须是非空字符串";
    next.botId = v.trim();
  }
  if (payload.allowed_user_ids !== undefined) {
    const parsed = parseAllowedUserIds(payload.allowed_user_ids);
    if ("error" in parsed) return parsed.error;
    next.allowedUserIds = parsed.ids;
  }
  if (payload.target_workspace_id !== undefined) {
    const v = payload.target_workspace_id;
    if (typeof v !== "string" || !v.trim()) return "target_workspace_id 必须是非空字符串";
    next.targetWorkspaceId = v.trim();
  }
  if (payload.proxy_url !== undefined) {
    const v = payload.proxy_url;
    if (typeof v !== "string") return "proxy_url 必须是字符串（清空传空串）";
    const clean = v.trim();
    if (!clean) delete next.proxyUrl;
    else if (!(next.proxyUrl && clean === maskProxyUrl(next.proxyUrl))) next.proxyUrl = clean;
  }
  // 与 bot_token 同款掩码纪律：设置页拿掩码当 placeholder 回显，原样回传 = 没动这一格
  if (payload.justoneapi_key !== undefined) {
    const v = payload.justoneapi_key;
    if (typeof v !== "string") return "justoneapi_key 必须是字符串（清空传空串）";
    const clean = v.trim();
    if (!clean) delete next.justoneapiKey;
    else if (!(next.justoneapiKey && clean === maskKey(next.justoneapiKey))) next.justoneapiKey = clean;
  }
  return null;
}

/** 收件箱配置写：落全局根 inbox.json（600 权限），成功且有实变更才广播 */
export async function setInboxSettings(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  if (!INBOX_FIELDS.some((k) => payload[k] !== undefined)) {
    return { ok: false, error: `没有可写入的字段（${INBOX_FIELDS.join(" / ")}）` };
  }
  const rootDir = (payload._rootDir as string) || undefined;
  try {
    const next = normalizeInbox(await readInboxJson(rootDir));
    const before = JSON.stringify(next);
    const error = applyInboxUpdates(next, payload);
    if (error) return { ok: false, error };

    const filePath = inboxFilePath(rootDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await fs.chmod(filePath, 0o600); // 已存在的松权限文件也要收紧
    // 只有真变了才通知：这事件会热重启 worker（断长轮询）并唤醒 blocked 项，
    // 对着没改动的保存空转一次不划算，也让 B 阶段的语义更干净。
    if (JSON.stringify(next) !== before) notifyInboxSettingsChanged(next);
    return getInboxSettings({ _rootDir: rootDir });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const inboxListeners: Array<(settings: InboxSettings) => void> = [];

/**
 * 订阅收件箱配置变更（B 阶段：worker 热重启 + blocked 项唤醒）。返回退订函数。
 * 回调收到未掩码配置——订阅方是同进程内的 worker，不跨 IPC，token 不出进程。
 */
export function onInboxSettingsChanged(cb: (settings: InboxSettings) => void): () => void {
  inboxListeners.push(cb);
  return () => {
    const i = inboxListeners.indexOf(cb);
    if (i >= 0) inboxListeners.splice(i, 1);
  };
}

function notifyInboxSettingsChanged(settings: InboxSettings): void {
  for (const cb of [...inboxListeners]) {
    try {
      cb(settings);
    } catch (err) {
      // 订阅方抛错不许把已落盘的保存拖成失败；留痕在日志，worker 侧另有自愈
      console.error("[inbox] settings listener failed:", err);
    }
  }
}
