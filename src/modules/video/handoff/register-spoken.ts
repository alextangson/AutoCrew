/**
 * 登记时的实拍版口播：视频平台必须带成片字幕，登记成功后把字幕还原成实拍口播，
 * 存进项目 `01-script/spoken/gNNNN-spoken.md`，并把「定稿 → 实拍」记成一条改稿差异喂给写手。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { safeProjectPath } from "../../../storage/content-project.js";
import { writeTextAtomic } from "../../../storage/json-atomic.js";
import type { Content } from "../../../storage/local-store.js";
import { recordDiff } from "../../learnings/diff-tracker.js";
import { SPOKEN_DIFF_NOTE, spokenFromSrt } from "./spoken.js";
import { handoffFail, type HandoffResult, type VideoHandoffRecord } from "./types.js";

const pad4 = (n: number) => String(n).padStart(4, "0");
export const spokenRel = (gen: number) => `01-script/spoken/g${pad4(gen)}-spoken.md`;
export const finalScriptRel = (gen: number) => `01-script/handoff/g${pad4(gen)}/final-script.md`;

export const SRT_REQUIRED = "视频稿登记必须带 srt_path：请把成片（最终剪辑版）的字幕文件导出到项目目录里，再带上它的绝对路径重新 register";

/** 读字幕并还原成实拍口播；读不了或格式不对 → 登记失败，原因写清 */
export async function readSpoken(srtFile: string): Promise<{ ok: true; text: string } | { ok: false; result: HandoffResult }> {
  try {
    return { ok: true, text: spokenFromSrt(await fs.readFile(srtFile, "utf-8")) };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, result: handoffFail("srt_invalid", `字幕文件不能用（${path.basename(srtFile)}）：${why}。请导出成片的标准 SRT 字幕再登记`, { which: "srt_path" }) };
  }
}

async function readOrNull(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf-8"); } catch { return null; }
}

/**
 * 登记已提交之后落实拍版：同一代次同一份口播已经在 → 不重复记差异。
 * 失败不回滚登记（成片已经落盘），而是把原因作为 warning 交回，让调用方看得见。
 */
export async function landSpoken(content: Content, record: VideoHandoffRecord, spoken: string, dataDir: string): Promise<string | undefined> {
  try {
    const file = safeProjectPath(record.project_root, spokenRel(record.generation));
    if ((await readOrNull(file)) === spoken) return undefined;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeTextAtomic(file, spoken);
    const finalScript = (await readOrNull(safeProjectPath(record.project_root, finalScriptRel(record.generation)))) ?? content.body;
    await recordDiff(content.id, "founder", "body", finalScript, spoken, dataDir, SPOKEN_DIFF_NOTE, content.platform);
    return undefined;
  } catch (e) {
    return `成片已登记，但实拍版口播没存上：${e instanceof Error ? e.message : String(e)}`;
  }
}
