/**
 * 主题上的两个创始人决定（管线重规划 §8-4、§8-6）。看板（浏览器会话）和对话（MCP）都走这里，都要原话。
 *
 * - 标「这条不出 XX」/ 恢复要发：只改这个主题的去向计划，记谁定的、原话。已发的不撤、照样显示。
 * - 重拍：结束本轮（复用重开文稿：本轮原片转入作废、批准转入历史），新一轮沿用原稿直接认稿 → 卡回「录制」；
 *   派生去向暂停显示「等新成片」；已发的保留；已定时还没公开的列出来让创始人自己去撤，从不自动撤。
 */
import { getContent, listContents } from "../../storage/local-store.js";
import { bodyHash, newId, scriptApprovalFor } from "../../storage/production-store.js";
import { boardData } from "../../desktop/board-data.js";
import { loadProfile } from "../profile/creator-profile.js";
import { reopenScript } from "../production/reopen.js";
import { mutateProduction } from "../production/service.js";
import { withFileOwnership } from "../production/mutex.js";
import { DEST_LABEL, isDestination } from "./destinations.js";
import { isThemeRoot, mutatePlan, type ReshootRecord } from "./plan.js";
import { themesOf } from "./pipeline-data.js";

export interface Who { via: "board" | "chat"; host?: string }
type Fail = { ok: false; code: string; error: string };
const fail = (code: string, error: string): Fail => ({ ok: false, code, error });
const words = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 500) : "");

async function rootOf(contentId: string, dataDir: string) {
  const c = await getContent(contentId, dataDir).catch(() => null);
  if (!c || c.deletedAt) return { error: fail("not_found", "找不到这条稿") };
  if (!isThemeRoot(c)) return { error: fail("not_theme_root", c.derivedFrom ? "这是派生稿：去向计划挂在源视频那张卡上，用源视频的 id" : "只有中文视频稿的主题有去向计划") };
  return { content: c };
}

/** 标不出（skip=true）或恢复要发（skip=false） */
export async function setDestination(contentId: string, platformRaw: unknown, skip: boolean, founderWords: unknown, who: Who, dataDir: string): Promise<{ ok: true; platform: string; required: boolean } | Fail> {
  const fw = words(founderWords);
  if (!fw) return fail("founder_words_required", "要带创始人的原话（为什么不出 / 为什么又要发）");
  const platform = String(platformRaw ?? "");
  if (!isDestination(platform)) return fail("bad_platform", `去向只能是 ${Object.keys(DEST_LABEL).join(" / ")}`);
  const r = await rootOf(contentId, dataDir);
  if ("error" in r) return r.error!;
  const profile = await loadProfile(dataDir);
  await mutatePlan(contentId, dataDir, profile, (plan) => {
    plan.destinations[platform] = { required: !skip, by: "founder", via: who.via, ...(who.host ? { host: who.host } : {}), founder_words: fw, at: new Date().toISOString() };
  });
  return { ok: true, platform, required: !skip };
}

export interface ReshootResult {
  ok: true; round: number; moved: string[]; warning?: string;
  published: ReshootRecord["published"]; to_cancel: ReshootRecord["to_cancel"];
}

/** 重拍：expectedRound = 创始人看到的那一轮（防旧页面、双击） */
export async function reshoot(contentId: string, founderWords: unknown, expectedRound: unknown, who: Who, dataDir: string): Promise<ReshootResult | Fail> {
  const fw = words(founderWords);
  if (!fw) return fail("founder_words_required", "重拍要带创始人的原话");
  const round = Number(expectedRound);
  if (!Number.isInteger(round) || round < 1) return fail("bad_request", "要带你看到的轮次（round），刷新后再点");
  const r = await rootOf(contentId, dataDir);
  if ("error" in r) return r.error!;
  // 重拍那一刻的去向：已发的保留、已定时的列出来要你去撤
  const contents = await listContents(dataDir);
  const { themes } = await themesOf(await boardData(dataDir), contents, dataDir);
  const theme = themes.find((t) => t.id === contentId);
  if (!theme) return fail("not_on_board", "这条不在管线上");
  if (theme.item.round !== null && theme.item.round !== round) {
    const done = theme.reshoot?.round_ended === round;
    if (!done) return fail("stale", "这条的轮次和你看到的不一样，刷新后再看");
  }
  if (!["剪辑中", "待发布", "已发布"].includes(theme.item.column) && theme.reshoot?.round_ended !== round) {
    return fail("not_shot_yet", "这条还没开拍（还在写稿 / 等录制），用不着重拍");
  }
  const published = theme.destinations.filter((d) => d.state === "已发").map((d) => ({ platform: d.platform, content_id: d.content_id }));
  const toCancel = theme.destinations.filter((d) => d.state === "已定时").map((d) => ({ platform: d.platform, content_id: d.content_id, ...(d.at ? { at: d.at } : {}) }));
  const reopened = await reopenScript(contentId, dataDir, `重拍：${fw}`.slice(0, 200), round);
  if (!reopened.ok) return fail(reopened.code ?? "reopen_failed", reopened.error ?? "重开没成");
  const newRound = reopened.round!;
  // 新一轮沿用原稿：直接认稿（同一句原话），卡回「录制」
  try {
    await withFileOwnership(() => mutateProduction(contentId, dataDir, (doc, content) => {
      if (doc.round !== newRound || scriptApprovalFor(doc, content.body)) return { value: null, events: [] };
      doc.decisions.push({ id: newId("dec"), type: "script_approval", round: doc.round, at: new Date().toISOString(), source: who.via === "chat" ? "chat" : "founder", founder_words: fw, ...(who.host ? { requested_by: who.host } : {}), body_hash: bodyHash(content.body), note: "重拍：沿用原稿" });
      return { value: null, events: [{ type: "reshoot_started", detail: { round: doc.round } }] };
    }));
  } catch (e) {
    return fail("reshoot_partial", `已结束上一轮，但新一轮没能沿用原稿认稿（卡会在写稿列，重新认稿即可）：${e instanceof Error ? e.message : String(e)}`);
  }
  const profile = await loadProfile(dataDir);
  // 重放（同一轮已经重拍过）不再追加；回执照样给当时记下的清单
  const record = (await mutatePlan(contentId, dataDir, profile, (plan) => {
    const had = plan.reshoots.find((x) => x.round_ended === round);
    if (had) return had;
    const rec: ReshootRecord = { round_ended: round, round: newRound, at: new Date().toISOString(), founder_words: fw, via: who.via, ...(who.host ? { host: who.host } : {}), published, to_cancel: toCancel };
    plan.reshoots.push(rec);
    return rec;
  })).value;
  return { ok: true, round: newRound, moved: reopened.moved ?? [], ...(reopened.warning ? { warning: reopened.warning } : {}), published: record.published, to_cancel: record.to_cancel };
}
