/**
 * `autocrew_content check_slivers`（spec §7）：agent 导出前自查。同一套判定，只返回结果——不写事实、不拍快照、不影响批准（E15）。
 * 读 ChatCut 当前的时间线（不是快照），不做时长对齐（成片可能还没导出）。帧率：本轮当前成片的帧率；
 * 还没有成片时用原片的帧率；都读不出 → 未检查。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { contentRoot } from "../../../storage/content-project.js";
import { getContent, getDataDir } from "../../../storage/local-store.js";
import { readProductionDocOrEmpty } from "../../../storage/production-store.js";
import type { Fact } from "../../../storage/production-types.js";
import { isVideoPlatform } from "../../../storage/stage-guard.js";
import { srtFor } from "../derive.js";
import { buildSnapshot, readTimeline, videoTiming } from "./chatcut-read.js";
import { arollIdentity, currentCut } from "./check.js";
import { detectSlivers } from "./detect.js";
import { withSuggestions } from "./suggest.js";

type R = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
const NEXT_CLEAN = "没有抽帧缝：可以导出，导出后照常 record kind=cut。";
const NEXT_SLIVERS = "按每处的 suggestion 修（定格补帧盖住，或剪掉气口让两段 B-roll 接上），修完再调 check_slivers，0 处再导出。";
const NEXT_UNCHECKED = "检查没跑成：按 reason 处理（例如报 chatcut_project、带 timeline_id）后再查；实在查不了就如实告诉创始人，由他决定放不放行。";

export async function checkSlivers(params: R): Promise<R> {
  const id = str(params.content_id) || str(params.id);
  if (!id) return { ok: false, code: "bad_param", error: "要带 content_id" };
  const dataDir = getDataDir(params._dataDir as string | undefined);
  const content = await getContent(id, dataDir);
  if (!content || content.deletedAt) return { ok: false, code: "not_found", error: `找不到这篇稿（${id}）` };
  if (!isVideoPlatform(content.platform)) return { ok: false, code: "not_video", error: "图文稿没有成片，不查抽帧缝" };
  const doc = await readProductionDocOrEmpty(id, dataDir);
  const root = contentRoot(id, dataDir);
  const facts = doc.facts.filter((f) => f.round === doc.round && f.state === "accepted");
  const cc = facts.filter((f) => f.kind === "chatcut_project").at(-1);
  const projectId = str(params.chatcut_project_id) || cc?.project_id || "";
  const timelineId = str(params.timeline_id) || (str(params.chatcut_project_id) ? "" : cc?.timeline_id ?? "");
  const out = (status: string, extra: R): R => ({ ok: true, content_id: id, status, written: false, ...extra,
    next_action: status === "clean" ? NEXT_CLEAN : status === "slivers" ? NEXT_SLIVERS : NEXT_UNCHECKED });
  if (!projectId) return out("unchecked", { reason: "不知道是哪个 ChatCut 工程：带 chatcut_project_id，或先 record kind=chatcut_project", slivers: [] });
  const live = await readTimeline(projectId, timelineId || undefined);
  if (!live.ok) return out("unchecked", { reason: live.reason, slivers: [] });
  const snap = await buildSnapshot(live.value, projectId);
  if (!snap.ok) return out("unchecked", { reason: snap.reason, slivers: [] });
  const arolls = facts.filter((f) => f.kind === "aroll" && !f.released_to && f.sha256);
  const cut = currentCut(doc);
  const abs = (f: Fact) => (path.isAbsolute(f.path!) ? f.path! : path.join(root, f.path!));
  const fpsFrom = cut?.path ? cut : arolls.find((f) => f.path);
  const timing = fpsFrom ? await videoTiming(abs(fpsFrom)) : null;
  const fps = timing?.ok ? timing.value.fps : null;
  const r = detectSlivers({ snap: snap.value, fps, aroll: await arollIdentity(root, arolls), cutFrames: null });
  const srt = cut ? srtFor(doc, cut.sha256) : null;
  const text = srt?.path ? await fs.readFile(abs(srt), "utf8").catch(() => null) : null;
  return out(r.status, { slivers: withSuggestions(r.slivers, fps, text), ...(r.reason ? { reason: r.reason } : {}), ...(fps ? { fps: `${fps.num}/${fps.den}` } : {}),
    ...(r.timeline_frames ? { timeline_frames: r.timeline_frames } : {}), timeline_id: live.value.timeline_id });
}
