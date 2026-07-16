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
  /** 公众号凭证(设置页可视化绑定;经 env 传给发布脚本,脚本自身 config.json 退居兜底) */
  wechatAppId?: string;
  wechatAppSecret?: string;
  /** 推草稿时默认打开留言(need_open_comment=1) */
  openComment?: boolean;
  imageApiKey?: string;
  /** 生图端点(OpenAI 兼容中转,如 xiaojiu)。缺省=脚本默认(火山 ARK 直连) */
  imageBaseUrl?: string;
  /** 生图模型 id(如 gpt-image-2)。缺省=脚本默认(doubao-seedream) */
  imageModel?: string;
  author?: string;
  theme?: string;
  /** 公众号 API 走的 HTTP 代理(固定出口 IP 用);经 HTTPS_PROXY 传给 publish.py。含账密,不回显。 */
  apiProxy?: string;
  /** 选题雷达 X 源的 twitterapi.io key(自带 key,不回显)。放这里复用既有第三方 key 存储袋。 */
  xApiKey?: string;
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
