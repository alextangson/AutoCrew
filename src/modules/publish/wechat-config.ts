/**
 * 公众号发布链本地配置（P0 阶段 2 去桥化）：<dataDir>/publish.json 的 wechatMp 段
 * 覆盖外部脚本路径 / 生图 key / 排版偏好。解析优先级由 publish.ts 组装：
 * 调用参数 > publish.json > 内置默认；env 兜底仍在 wechat-mp.ts 的 resolve 链里。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "../../storage/local-store.js";

export interface WechatMpPublishConfig {
  imageGeneratorScript?: string;
  wechatPublishScript?: string;
  imageApiKey?: string;
  /** 生图端点(OpenAI 兼容中转,如 xiaojiu)。缺省=脚本默认(火山 ARK 直连) */
  imageBaseUrl?: string;
  /** 生图模型 id(如 gpt-image-2)。缺省=脚本默认(doubao-seedream) */
  imageModel?: string;
  author?: string;
  theme?: string;
}

export async function loadWechatMpConfig(dataDir?: string): Promise<WechatMpPublishConfig> {
  const filePath = path.join(getDataDir(dataDir), "publish.json");
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`publish.json 解析失败（${filePath}）：${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`publish.json 解析失败（${filePath}）：不是 JSON 对象`);
  }
  return (parsed as { wechatMp?: WechatMpPublishConfig }).wechatMp ?? {};
}
