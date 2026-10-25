/**
 * 无字幕母版（record kind=clean_master，2026-10-25）：审过的那版成片同剪辑、同 B-roll 和配乐、关掉字幕轨导出的 1920×1080。
 * 英文版的画面来源——在带字幕的成片上换配音会把中文字幕一起带过去。
 *
 * 核验：绑当前有效的成片批准；ffprobe 核 1920×1080、有音轨、时长和所绑成片差不过 TOLERANCE_MS；
 * 画面里有没有烧进去的字幕自动查不出来，只靠剪辑方的 captions_off=true 声明。
 */
import type { Fact, ProductionDoc } from "../../storage/production-types.js";
import { validCutApproval } from "./derive.js";
import type { Probe } from "./files.js";
import type { Parsed } from "./record-args.js";

export const MASTER_WIDTH = 1920;
export const MASTER_HEIGHT = 1080;
/** 同一条时间线关掉字幕再导出，时长应当一样；留半秒给编码器首尾帧取整 */
export const MASTER_TOLERANCE_MS = 500;

const deny = <T>(code: string, error: string): Parsed<T> => ({ ok: false, code, error });

/** 母版绑的成片：必须是当前审过的那版；for_cut 给了就要和它一致（fact id 或 sha） */
export function masterCut(doc: ProductionDoc, body: string, forCut: string | undefined): Parsed<Fact> {
  const approval = validCutApproval(doc, body);
  const cut = approval ? doc.facts.find((f) => f.kind === "cut" && f.sha256 === approval.sha256 && f.round === doc.round && !f.replaced_at) : undefined;
  if (!cut) return deny("cut_not_approved", "这条现在没有审过的成片：无字幕母版要绑审过的那版，等创始人在「等你拍板」里通过成片再报");
  if (forCut && forCut !== cut.id && forCut !== cut.sha256) return deny("cut_not_approved", `for_cut 不是审过的那版成片（审过的是 ${cut.id}）：从审过的那条时间线关掉字幕重新导出`);
  return { ok: true, value: cut };
}

/** ffprobe 核尺寸、音轨、时长；cut 有时长时再比时长 */
export async function checkMaster(file: string, probe: Probe, cut: Fact): Promise<Parsed<number>> {
  const r = await probe(file);
  if ("error" in r || !(r.durationMs > 0)) return deny("file_unstable", "读不出这个视频的时长：多半还在导出 / 拷贝，或者文件坏了；等它写完再报，这次什么都没写");
  if (r.width !== MASTER_WIDTH || r.height !== MASTER_HEIGHT) {
    return deny("master_invalid", `无字幕母版要 ${MASTER_WIDTH}×${MASTER_HEIGHT}，这个是 ${r.width ?? "?"}×${r.height ?? "?"}：按 1920×1080 重新导出`);
  }
  if (r.audio !== true) return deny("master_invalid", "无字幕母版里没有音轨：要和成片一样带人声、配乐和混音，重新导出");
  if (!cut.duration_ms) return deny("master_invalid", "审过的成片没记时长，核不了母版是不是同一版剪辑：重新 record 这版成片后再报母版");
  const diff = Math.abs(r.durationMs - cut.duration_ms);
  if (diff > MASTER_TOLERANCE_MS) {
    return deny("master_invalid", `无字幕母版 ${(r.durationMs / 1000).toFixed(2)} 秒，审过的成片 ${(cut.duration_ms / 1000).toFixed(2)} 秒，差了 ${(diff / 1000).toFixed(2)} 秒：要同一条时间线只关字幕导出`);
  }
  return { ok: true, value: r.durationMs };
}

/** 某版成片的无字幕母版：for_cut = 成片 sha 的最近一条 accepted、没被覆盖的 */
export function cleanMasterFor(doc: ProductionDoc, cutSha: string | undefined): Fact | null {
  if (!cutSha) return null;
  return doc.facts.filter((f) => f.kind === "clean_master" && f.state === "accepted" && f.for_cut === cutSha && !f.replaced_at)
    .sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}
