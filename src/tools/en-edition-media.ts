/**
 * en_edition 里管媒体的几个 op：dub（配音 + 排时清单）、captions（字幕分条）、chapters（YouTube 章节）、set_thumbnail，
 * 以及 status 里的媒体那一块。全部只认批过、指纹对得上、源没过期的那份脚本。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadProfile } from "../modules/profile/creator-profile.js";
import { enKitPlatforms } from "../modules/profile/platform-lines.js";
import type { EnReviewState } from "../modules/en-edition/review.js";
import { approvedEnState, currentEnManifest } from "../modules/en-edition/approved.js";
import { dubApprovedScript, dubDir, readDubManifest } from "../modules/en-edition/dub.js";
import { readDubFailure, recordDubFailure } from "../modules/en-edition/dub-failure.js";
import { buildCues } from "../modules/en-edition/captions.js";
import { enPicture } from "../modules/en-edition/source.js";
import { getContent } from "../storage/local-store.js";
import { readEnThumbnail, setEnThumbnail, thumbnailProblem } from "../modules/en-edition/thumbnail.js";
import { chaptersFromManifest, EN_PUBLISH_WINDOW } from "../modules/publish/en-kit.js";
import { REPO_ROOT } from "../modules/video/proc.js";
import { enPackageState } from "../modules/en-edition/package.js";
import { enPackageApprovalText, writeEnPackagePreview } from "../modules/en-edition/package-preview.js";

type Result = Record<string, unknown>;
const fail = (code: string, error: string): Result => ({ ok: false, code, error });

/** 单引号包住整段路径（空格、中文、$ 都原样），内部单引号按 '\'' 转义 */
export const shellQuote = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`;

const approvedState = approvedEnState;
const currentManifest = currentEnManifest;

export async function dubOp(id: string, dataDir: string): Promise<Result> {
  const a = await approvedState(id, dataDir);
  if ("no" in a) return a.no;
  const s = a.s;
  // 画面来源先核（2026-10-25）：没有无字幕母版，配出来的音也没处放，先别花配音的钱
  const pic = await enPicture((await getContent(id, dataDir))!, dataDir);
  if (!pic.ok) return pic;
  const r = await dubApprovedScript(id, s.script, s.hash, dataDir);
  if (!r.ok) {
    await recordDubFailure(id, dataDir, { reason: r.error, code: r.code, at: new Date().toISOString(), scriptHash: s.hash });
    return { ok: false, code: r.code, error: r.error, ...(r.path ? { manifest_path: r.path } : {}) };
  }
  await recordDubFailure(id, dataDir, null);
  const m = r.manifest;
  return { ok: true, manifest_path: r.path, picture_source: pic.picture, lines: m.lines.length, dub_end_s: m.dubEndS, source_end_s: m.sourceEndS, overrun_s: m.overrunS, tail_slowdown: Math.round(m.tailSlowdown * 1000) / 1000, slow_from_s: m.slowFromS,
    next_action: "前台会话按 video-session 的英文版做法：画面用 picture_source（源视频的无字幕母版），按清单摆音轨、从 slow_from_s 起把画面放慢 tail_slowdown 倍、做口型对齐参考视频，再 op:\"captions\"" };
}

export async function captionsOp(id: string, dataDir: string): Promise<Result> {
  const a = await approvedState(id, dataDir);
  if ("no" in a) return a.no;
  const s = a.s;
  const cm = await currentManifest(id, s, dataDir);
  if ("no" in cm) return cm.no;
  const m = cm.m;
  const cues = buildCues(m, s.script);
  if (!cues.ok) return fail("captions_failed", cues.error);
  const file = path.join(dubDir(id, dataDir), "captions.json");
  await fs.writeFile(file, JSON.stringify({ scriptHash: s.hash, cues: cues.cues }, null, 2));
  const script = path.join(REPO_ROOT, "sidecars", "captions", "burn_captions.py");
  return { ok: true, captions_path: file, cues: cues.cues.length,
    burn_command: `uv run --project ${shellQuote(path.dirname(script))} ${shellQuote(script)} --cues ${shellQuote(file)} --input <口型对齐后的成片.mp4> --output <英文成片.mp4>`,
    note: "<…> 两处换成真实路径时也要加单引号（项目路径里有空格和中文）" };
}

export async function chaptersOp(id: string, dataDir: string): Promise<Result> {
  const a = await approvedState(id, dataDir);
  if ("no" in a) return a.no;
  const s = a.s;
  const cm = await currentManifest(id, s, dataDir);
  if ("no" in cm) return cm.no;
  const m = cm.m;
  return { ok: true, segment_starts: chaptersFromManifest(m, s.script),
    note: "YouTube 章节：从这些段起点里挑 3 个以上（第一个必须 0:00，每章 ≥10 秒），给每章写英文标题，放进 youtube 发布包的 chapters" };
}

export async function thumbnailOp(id: string, file: string, dataDir: string): Promise<Result> {
  if (!file) return fail("invalid_params", "set_thumbnail 要 path（16:9 缩略图的本机绝对路径）");
  const r = await setEnThumbnail(id, file, dataDir);
  return r.ok ? { ok: true, thumbnail: { path: r.thumbnail.path, width: r.thumbnail.width, height: r.thumbnail.height } } : { ...r };
}

/** status 里的媒体部分：配音清单、缩略图、要出包的平台、默认发布时段 */
export async function mediaStatus(id: string, s: EnReviewState, dataDir: string): Promise<Result> {
  const m = await readDubManifest(id, dataDir).catch(() => null);
  const failed = await readDubFailure(id, dataDir);
  const dub = failed ? `配音失败：${failed.reason}（${failed.at}）` : !m ? "还没配音" : m.scriptHash !== s.hash ? "配音是按旧脚本做的，要重配" : m.refused ? `配音超时被拒：${m.refused}` : `已配音：${m.lines.length} 条，尾段放慢 ${m.tailSlowdown.toFixed(3)}×`;
  const thumb = await readEnThumbnail(id, dataDir);
  const pic = await enPicture((await getContent(id, dataDir))!, dataDir);
  return { dub, picture_source: pic.ok ? pic.picture.path : null, ...(pic.ok ? {} : { picture_problem: pic.error, picture_next_action: pic.next_action }), thumbnail: thumb?.path ?? null, thumbnail_problem: await thumbnailProblem(thumb), kit_platforms: enKitPlatforms(await loadProfile(dataDir)), publish_window: EN_PUBLISH_WINDOW };
}

/** 英文发布包：审阅页 + 还差什么 + 批准状态（批在「等你拍板」的「英文发布包」那件） */
export async function packageStatusOp(id: string, dataDir: string): Promise<Result> {
  const s = await enPackageState(id, dataDir);
  if ("error" in s) return fail(s.code, s.error);
  const page = await writeEnPackagePreview(s, enPackageApprovalText(s), dataDir);
  return { ok: true, review_page: page, problems: s.problems, ready_to_approve: s.problems.length === 0, approval: enPackageApprovalText(s), package_hash: s.hash, platforms: s.platforms,
    next_action: s.problems.length ? "按 problems 补齐" : "autocrew_review_inbox list 把「英文发布包」那件给创始人看，他说没问题再 decide approve_en_package" };
}
