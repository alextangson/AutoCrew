/**
 * 公众号文章在看板上的列：发布落在它自己的 article-publish.json（record_scheduled），不在视频发布记录里。
 * 只认 record_scheduled 记下的回执：phase=published（带 published:true 的回执）= 已发布；
 * phase=scheduled = 待发布，原因照实说定时在什么时候、过点了没核到；failed / unknown 照实标出来（不当成还在正常等）。
 * 其他阶段不改列（返回 null）。纯函数。
 */
import type { ArticlePublishState } from "./publish-state.js";
import type { Column } from "../production/explain.js";

export interface ArticleBoardStage { column: Column; reason: string; badge: string }

const shanghai = (iso: string) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

export function articleBoardStage(s: ArticlePublishState, now = new Date()): ArticleBoardStage | null {
  const r = s.receipt;
  if (s.phase === "published" && r?.published) return { column: "已发布", badge: "公众号 已发表", reason: `公众号已发表（${shanghai(r.scheduledAt)}，创始人说「${r.founderWords}」）` };
  if (s.phase === "scheduled" && r) {
    const past = Date.parse(r.scheduledAt) <= now.getTime();
    return past
      ? { column: "待发布", badge: "公众号 应已发表", reason: `公众号定时 ${shanghai(r.scheduledAt)} 已过，还没核到已发表：去发表记录核一下再记` }
      : { column: "待发布", badge: "公众号 已定时", reason: `公众号已定时 ${shanghai(r.scheduledAt)}，到点发出后记已发表` };
  }
  if (s.phase === "scheduled_waiting_scan") return { column: "待发布", badge: "公众号 等你扫码", reason: "公众号定时已设好，等你扫码确认" };
  if (s.phase === "failed") {
    const last = [...s.attempts].reverse().find((a) => !a.ok);
    return { column: "待发布", badge: "公众号 没发成", reason: `公众号推送失败${last?.raw ? `：${last.raw.split("\n")[0].slice(0, 120)}` : ""}，可以重推` };
  }
  if (s.phase === "unknown") return { column: "待发布", badge: "公众号 结果不明", reason: "公众号上一步结果不明：先去公众号后台核对再记，不要重推" };
  return null;
}
