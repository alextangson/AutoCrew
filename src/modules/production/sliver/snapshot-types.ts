/**
 * ChatCut 时间线快照的形状（spec 2026-09-30 §3 / §12-2）：成片登记时把时间线和它引用的素材元数据冻结成 JSON，
 * 检查只针对快照。ChatCut 工程格式是内部格式（schemaVersion 4），不是公开接口：这里只声明检查要读的字段，
 * 其余原样保留，由 cover-rules 按白名单判断「认不认识」。
 */

export const SUPPORTED_SCHEMA = 4;
/** 判定规则一变就升版本：旧结果的指纹随之失效 */
export const CHECKER_VERSION = "sliver-v1";

export type Json = Record<string, unknown>;

/** 快照里的素材元数据：只存判定要用的字段，外加探针读出的像素格式（null = 读不出） */
export interface SnapshotAsset {
  id: string;
  type: string;
  name?: string;
  path?: string;
  contentSha256?: string;
  /** 微秒 */
  duration?: number;
  /** 动效：属性表（只留 key / defaultValue / type） */
  properties?: Array<{ key: string; defaultValue?: unknown; type?: string }>;
  /** 图片 / 视频：ffprobe 的 pix_fmt；null = 文件读不到或探针失败 */
  pix_fmt?: string | null;
}

export interface Snapshot {
  schemaVersion: number;
  project_id: string;
  timeline_id: string;
  timeline: Json;
  assets: Record<string, SnapshotAsset>;
}

export interface Fps { num: number; den: number }

/** 本条 accepted A-roll 事实的素材身份：sha、绝对路径、时长（微秒，按文件探出） */
export interface ArollIdentity { shas: string[]; paths: string[]; durationsUs: number[] }
