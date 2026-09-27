/**
 * 视频线配置（设计 spec §8.1）——`<dataDir>/video.json`（600 权限）。
 *
 * 落盘根跟 engine/search/publish 一致：**工作区** <dataDir>（server 端解析后注入
 * `_dataDir`）。视频状态本来就按工作区分家（`contents/<id>/video/`），配置跟着状态
 * 走才不会串台——这点与收件箱（全局根，单例 worker）刚好相反。
 *
 * V0a 只有两个无秘钥字段（渲染并发、A-roll 快照），所以**没有掩码**；但读写结构照
 * settings-inbox 的规矩来：normalize 补缺省 → 增量应用 → 真有变化才广播。V1 接火山
 * 复刻 2.0 的 appId/token 时，maskKey + 掩码回传守恒直接补进 applyVideoUpdates，
 * 外面的读写口不用动。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getConfigDir } from "../storage/storage-roots.js";

export interface VideoSettings {
  /**
   * 渲染并发（remotion 的 --concurrency）。缺省 = 不传，交给渲染层自己按机器定。
   * 渲染吃满 CPU，机器弱的人要能压下来。
   */
  renderConcurrency?: number;
  /**
   * A-roll 快照拷贝（§4.2）。默认关：素材是**引用不复制**，开了才为强可复现付出磁盘代价。
   */
  snapshotCopy?: boolean;
  /**
   * 剪映的导出目录（P6 §13.4-F 成片第 2 步）：成片候选唯一允许落在项目外的根。
   * 不猜缺省值——没设就拒绝项目外的成片候选，并告诉创始人在哪里设。
   */
  jianyingExportDir?: string;
}

const VIDEO_FILE = "video.json";
const VIDEO_FIELDS = ["render_concurrency", "snapshot_copy", "jianying_export_dir"];
const KNOWN_KEYS = ["renderConcurrency", "snapshotCopy", "jianyingExportDir"];
/** 单机渲染，超过这个数只会互相抢 CPU；上限是防呆不是性能建议 */
const MAX_RENDER_CONCURRENCY = 16;

function videoFilePath(dataDir?: string): string {
  return path.join(getConfigDir(dataDir), VIDEO_FILE);
}

async function readVideoJson(dataDir?: string): Promise<Partial<VideoSettings>> {
  try {
    return JSON.parse(await fs.readFile(videoFilePath(dataDir), "utf-8")) as Partial<VideoSettings>;
  } catch (err) {
    // 首次没文件 = 未配置；文件坏了要炸出来（静默当空会把真配置覆盖掉）
    if ((err as { code?: string }).code !== "ENOENT") throw err;
    return {};
  }
}

/** 把磁盘上的半成品收敛成合法结构：非法值一律丢弃，不让坏配置传染到渲染层 */
function normalizeVideo(raw: Partial<VideoSettings>): VideoSettings {
  const concurrency =
    typeof raw.renderConcurrency === "number" &&
    Number.isInteger(raw.renderConcurrency) &&
    raw.renderConcurrency >= 1 &&
    raw.renderConcurrency <= MAX_RENDER_CONCURRENCY
      ? raw.renderConcurrency
      : undefined;
  return {
    ...(concurrency !== undefined ? { renderConcurrency: concurrency } : {}),
    ...(raw.snapshotCopy === true ? { snapshotCopy: true } : {}),
    ...(typeof raw.jianyingExportDir === "string" && path.isAbsolute(raw.jianyingExportDir) ? { jianyingExportDir: raw.jianyingExportDir } : {}),
  };
}

/** 渲染/ingest 侧的直读口（不经 IPC）。缺文件 = 全默认，不是错误 */
export async function getVideoSettingsRaw(dataDir?: string): Promise<VideoSettings> {
  return normalizeVideo(await readVideoJson(dataDir));
}

/** 设置页读：V0a 无秘钥，原样透出（字段语义见 VideoSettings） */
export async function getVideoSettings(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  try {
    const cfg = normalizeVideo(await readVideoJson((payload._dataDir as string) || undefined));
    return {
      ok: true,
      data: {
        renderConcurrency: cfg.renderConcurrency ?? null,
        snapshotCopy: cfg.snapshotCopy === true,
        jianyingExportDir: cfg.jianyingExportDir ?? null,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 剪映导出目录：完整路径、存在、是目录（不是链接到别处的假目录也行——比较时一律 realpath） */
async function exportDirError(v: unknown): Promise<string | null> {
  if (typeof v !== "string" || !path.isAbsolute(v.trim())) return "jianying_export_dir 必须是完整的绝对路径（清空传 null）";
  const st = await fs.stat(v.trim()).catch(() => null);
  return st?.isDirectory() ? null : `剪映导出目录不存在或不是文件夹：${v.trim()}`;
}

/** 增量应用到 next（就地改），返回错误串或 null。清空 = 传 null / 0 / 空串 */
async function applyVideoUpdates(next: VideoSettings, payload: Record<string, unknown>): Promise<string | null> {
  const dir = payload.jianying_export_dir;
  if (dir !== undefined) {
    if (dir === null || dir === "") delete next.jianyingExportDir;
    else {
      const bad = await exportDirError(dir);
      if (bad) return bad;
      next.jianyingExportDir = String(dir).trim();
    }
  }
  if (payload.render_concurrency !== undefined) {
    const v = payload.render_concurrency;
    if (v === null || v === "" || v === 0) delete next.renderConcurrency;
    else if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_RENDER_CONCURRENCY) {
      return `render_concurrency 必须是 1~${MAX_RENDER_CONCURRENCY} 的整数（清空传 null）`;
    } else next.renderConcurrency = v;
  }
  if (payload.snapshot_copy !== undefined) {
    const v = payload.snapshot_copy;
    if (typeof v !== "boolean") return "snapshot_copy 必须是布尔值";
    if (v) next.snapshotCopy = true;
    else delete next.snapshotCopy;
  }
  return null;
}

/** 设置页写：落工作区 video.json（600 权限），成功且有实变更才广播 */
export async function setVideoSettings(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  if (!VIDEO_FIELDS.some((k) => payload[k] !== undefined)) {
    return { ok: false, error: `没有可写入的字段（${VIDEO_FIELDS.join(" / ")}）` };
  }
  const dataDir = (payload._dataDir as string) || undefined;
  try {
    const raw = await readVideoJson(dataDir);
    const next = normalizeVideo(raw);
    const before = JSON.stringify(next);
    const error = await applyVideoUpdates(next, payload);
    if (error) return { ok: false, error };

    const filePath = videoFilePath(dataDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // 同一个文件里还有别的模块的键（交接白名单 project_roots）：原样保留，只改自己的字段
    const others = Object.fromEntries(Object.entries(raw).filter(([k]) => !KNOWN_KEYS.includes(k)));
    await fs.writeFile(filePath, JSON.stringify({ ...others, ...next }, null, 2) + "\n", { mode: 0o600 });
    await fs.chmod(filePath, 0o600); // 已存在的松权限文件也要收紧
    if (JSON.stringify(next) !== before) notifyVideoSettingsChanged(next);
    return getVideoSettings({ _dataDir: dataDir });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const videoListeners: Array<(settings: VideoSettings) => void> = [];

/**
 * 订阅视频配置变更（预留：渲染并发热生效 / 快照开关）。返回退订函数。
 * V0a 还没有订阅方——先把变更事件的出口留在这里，等 runner 需要热生效时接上，
 * 免得那时又去改一遍写入路径。
 */
export function onVideoSettingsChanged(cb: (settings: VideoSettings) => void): () => void {
  videoListeners.push(cb);
  return () => {
    const i = videoListeners.indexOf(cb);
    if (i >= 0) videoListeners.splice(i, 1);
  };
}

function notifyVideoSettingsChanged(settings: VideoSettings): void {
  for (const cb of [...videoListeners]) {
    try {
      cb(settings);
    } catch (err) {
      // 订阅方抛错不许把已落盘的保存拖成失败
      console.error("[video] settings listener failed:", err);
    }
  }
}
