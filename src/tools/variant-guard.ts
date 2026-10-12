/**
 * create_variant 的「同一条视频」闸口（spec 2026-10-12 A / 吸收 7）：同一条视频发多平台不新建稿。
 * 按制作认，不按选题认：只有同选题里已有视频稿带了制作记录（原片 / 成片事实或已登记成片）时，
 * 才拒绝再建视频平台变体；同选题另做一条不同的视频带 distinct_video=true 放行。文字平台不受影响。
 */
import { listContents } from "../storage/local-store.js";
import { readProductionDoc } from "../storage/production-store.js";
import { isVideoPlatform } from "../storage/stage-guard.js";

const PRODUCED = new Set(["aroll", "cut"]);

export async function sameVideoRefusal(topicId: string, platform: string, distinctVideo: unknown, dataDir?: string): Promise<Record<string, unknown> | null> {
  if (!isVideoPlatform(platform) || distinctVideo === true || distinctVideo === "true") return null;
  const siblings = (await listContents(dataDir)).filter((c) => c.topicId === topicId && !c.deletedAt && isVideoPlatform(c.platform));
  for (const c of siblings) {
    const doc = await readProductionDoc(c.id, dataDir).catch(() => null);
    const produced = Boolean(c.video?.final) || Boolean(doc?.facts.some((f) => PRODUCED.has(f.kind) && f.state === "accepted"));
    if (!produced) continue;
    return {
      ok: false, code: "same_video_variant", content_id: c.id,
      error: `同一条视频发多平台不用新建稿：这条视频已经在《${c.title || c.id}》（${c.id}）里做了，在发布计划里加 ${platform} 这个平台，四个平台共用这条 content_id。要为同一选题另做一条不同的视频，再带 distinct_video=true。`,
      next_action: { tool: "autocrew_pre_publish", params: { action: "video_kit", content_id: c.id, platform }, message: "给这个平台交一份发布包，再把平台加进 06-publish/publish-plan.json" },
    };
  }
  return null;
}
