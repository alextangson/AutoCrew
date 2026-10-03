/**
 * 数据回流只读试跑：四个平台依次旁听一次，只打印结果摘要。
 * 不写 outcomes、不读写 metrics-pull.json、不碰 :4317——只调抓取器本身（抓取器不落盘）。
 * 用法：npx tsx scripts/metrics-pull-dry-run.mts [douyin|wechat_video|xiaohongshu|wechat_mp ...]
 */
import { pullDouyinStats } from "../src/adapters/browser/douyin-stats.js";
import { pullWechatVideoStats } from "../src/adapters/browser/wechat-video-stats.js";
import { pullXhsStats } from "../src/adapters/browser/xhs-stats.js";
import { pullWechatMpStats } from "../src/adapters/browser/wechat-mp-stats.js";
import type { PullResult } from "../src/adapters/browser/pull-types.js";

const PULLERS: Record<string, () => Promise<PullResult>> = {
  douyin: () => pullDouyinStats(),
  wechat_video: () => pullWechatVideoStats(),
  xiaohongshu: () => pullXhsStats(),
  wechat_mp: () => pullWechatMpStats(),
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PULLERS);
for (const name of wanted) {
  const started = Date.now();
  const r = await PULLERS[name]();
  console.log(
    JSON.stringify({
      platform: name,
      status: r.status,
      rows: r.rows.length,
      pages: r.pages ?? 0,
      hasMore: r.hasMore ?? false,
      errorCode: r.errorCode ?? null,
      seconds: Math.round((Date.now() - started) / 1000),
      sample: r.rows.slice(0, 3).map((x) => ({ publishedAt: x.publishedAt, id: x.platformItemId ? "yes" : "no", metrics: x.metrics })),
    }),
  );
}
