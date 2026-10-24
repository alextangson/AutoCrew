/**
 * en_edition 里管媒体的几个 op：dub（配音 + 排时清单）、captions（字幕分条）、chapters（YouTube 章节）、set_thumbnail，
 * 以及 status 里的媒体那一块。全部只认批过、指纹对得上、源没过期的那份脚本。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadProfile } from "../modules/profile/creator-profile.js";
import { enKitPlatforms } from "../modules/profile/platform-lines.js";
import { enReviewState, type EnReviewState } from "../modules/en-edition/review.js";
import { dubApprovedScript, dubDir, readDubManifest, type DubManifest } from "../modules/en-edition/dub.js";
import { buildCues } from "../modules/en-edition/captions.js";
import { readEnThumbnail, setEnThumbnail, thumbnailProblem } from "../modules/en-edition/thumbnail.js";
import { chaptersFromManifest, EN_PUBLISH_WINDOW } from "../modules/publish/en-kit.js";
import { REPO_ROOT } from "../modules/video/proc.js";

type Result = Record<string, unknown>;
const fail = (code: string, error: string): Result => ({ ok: false, code, error });

/** 批过、没过期的脚本状态；不行交拒绝 */
async function approvedState(id: string, dataDir: string): Promise<{ s: EnReviewState } | { no: Result }> {
  const s = await enReviewState(id, dataDir, { fresh: true });
  if ("error" in s) return { no: fail(s.code, s.error) };
  if (s.stale) return { no: fail("derived_stale", `这条英文版过期了：${s.stale}`) };
  if (!s.approval.ok) return { no: fail("script_not_approved", `英文脚本${s.script.approval ? `的批准已失效：${s.approval.reason}` : "还没批"}：先在「等你拍板」里请创始人批`) };
  return { s };
}

/** 清单要和现在批过的脚本是同一份 */
async function currentManifest(id: string, s: EnReviewState, dataDir: string): Promise<{ m: DubManifest } | { no: Result }> {
  const m = await readDubManifest(id, dataDir);
  if (!m) return { no: fail("no_dub", "还没配音：先 op:\"dub\"") };
  if (m.scriptHash !== s.hash) return { no: fail("dub_stale", "配音是按旧脚本做的（脚本批准后改过）：重新 op:\"dub\"") };
  if (m.refused) return { no: fail("overrun_too_long", m.refused) };
  return { m };
}

export async function dubOp(id: string, dataDir: string): Promise<Result> {
  const a = await approvedState(id, dataDir);
  if ("no" in a) return a.no;
  const s = a.s;
  const r = await dubApprovedScript(id, s.script, s.hash, dataDir);
  if (!r.ok) return { ok: false, code: r.code, error: r.error, ...(r.path ? { manifest_path: r.path } : {}) };
  const m = r.manifest;
  return { ok: true, manifest_path: r.path, lines: m.lines.length, dub_end_s: m.dubEndS, source_end_s: m.sourceEndS, overrun_s: m.overrunS, tail_slowdown: m.tailSlowdown, slow_from_s: m.slowFromS,
    next_action: "前台会话按 video-session 的英文版做法：按清单摆音轨、从 slow_from_s 起把画面放慢 tail_slowdown 倍、做口型对齐参考视频，再 op:\"captions\"" };
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
    burn_command: `uv run --project ${path.dirname(script)} ${script} --cues ${file} --input <口型对齐后的成片.mp4> --output <英文成片.mp4>` };
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
  const dub = !m ? "还没配音" : m.scriptHash !== s.hash ? "配音是按旧脚本做的，要重配" : m.refused ? `配音超时被拒：${m.refused}` : `已配音：${m.lines.length} 条，尾段放慢 ${m.tailSlowdown}×`;
  const thumb = await readEnThumbnail(id, dataDir);
  return { dub, thumbnail: thumb?.path ?? null, thumbnail_problem: await thumbnailProblem(thumb), kit_platforms: enKitPlatforms(await loadProfile(dataDir)), publish_window: EN_PUBLISH_WINDOW };
}
