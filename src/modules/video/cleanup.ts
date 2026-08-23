/**
 * 成片收尾清理（lifecycle spec §3.2 / §3.3）——审片通过之后，把测试产物删掉。
 *
 * 两条不能商量的纪律：
 * 1. **按已知命名解析 + 核对，未知文件一律不动**。不做宽泛 glob：`video/` 目录里将来会长出
 *    什么没人保证得了，而清理是自动动作，误删不可撤销。认不出来的文件原样留着并报出来。
 * 2. **成片反登记走所有权，绝不按文件名删**（§3.1）：人手挂接的同名 `final-v1.mp4`
 *    没有 `managedBy` 标记，一律不碰（§4 #11）。
 *
 * 判定是纯函数（`planVideoCleanup`），执行是薄薄一层 IO。这样「该删什么」可以被确定性用例
 * 锁死，而不用靠造一堆真文件去推断。
 */
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { removeManagedFinalAsset } from "../../storage/local-store.js";
import { readVersioned, videoDir } from "./video-store.js";
import type { RenderManifest } from "./types.js";

/** 决策 JSON 是重剪的依据（KB 级），一律留 */
const KEEP_JSON_BASES = [
  "transcript",
  "cut",
  "edit-units",
  "editor-plan",
  "editor-decision",
  "timeline",
  "render-manifest",
  "cut-preview-request",
  "review-decision",
];

/** 不带版本号但必须留的常驻文件 */
const KEEP_PLAIN = new Set(["state.json", "assets.json", "asr-out.json"]);

export interface CleanupContext {
  /** 通过版；只有它的成片、它引用的音轨会被留下 */
  approvedRevision: number;
  /**
   * 通过版 manifest 实际引用的音轨文件名（basename）。
   * null = manifest 读不到，此时**所有 wav 保守全留**——宁可占盘，不可删掉还在用的音轨。
   */
  keepAudioFile: string | null;
}

export interface CleanupPlan {
  remove: string[];
  /** 要反登记的非通过版成片 revision（按所有权删，删不掉就是历史产物，不动） */
  unregister: number[];
  keep: string[];
  /** 认不出来的文件：一律不动，但要说出来 */
  untouched: string[];
}

function versionOf(name: string, re: RegExp): number | null {
  const m = re.exec(name);
  return m ? Number(m[1]) : null;
}

/** 一个文件的归宿。返回 null = 认不出来 */
function classify(name: string, ctx: CleanupContext): "remove" | "keep" | { unregister: number } | null {
  if (KEEP_PLAIN.has(name)) return "keep";
  // 各形态临时/残留：原子写残留、staging 半成品、中断的 wav/mp4
  if (name.endsWith(".staging.json") || /\.json\.tmp-/.test(name)) return "remove";
  if (name.endsWith(".wav.tmp") || name.endsWith(".tmp.mp4")) return "remove";
  // 预览全是测试产物：门内看一眼用的，通过之后一条都不留
  if (/^preview(?:-anchor|-manifest)?\.v\d+\.(?:mp4|wav|json)$/.test(name)) return "remove";
  if (name === "asr-input.wav") return "remove"; // transcribe 可重抽
  if (/\.failed\.mp4$/.test(name)) return "remove";
  const final = versionOf(name, /^final\.v(\d+)\.mp4$/);
  if (final !== null) return final === ctx.approvedRevision ? "keep" : { unregister: final };
  const wav = versionOf(name, /^(?:anchor|master-audio)\.v(\d+)\.wav$/);
  if (wav !== null) {
    // WAV 才是最大的可再生重产物；但删掉通过版正在引用的那一条 = 成片再也重建不出来
    if (ctx.keepAudioFile === null) return "keep";
    return name === ctx.keepAudioFile ? "keep" : "remove";
  }
  const json = /^([a-z-]+)\.v\d+\.json$/.exec(name);
  if (json && KEEP_JSON_BASES.includes(json[1])) return "keep";
  return null;
}

export function planVideoCleanup(names: readonly string[], ctx: CleanupContext): CleanupPlan {
  const plan: CleanupPlan = { remove: [], unregister: [], keep: [], untouched: [] };
  for (const name of [...names].sort()) {
    const verdict = classify(name, ctx);
    if (verdict === null) plan.untouched.push(name);
    else if (verdict === "keep") plan.keep.push(name);
    else if (verdict === "remove") plan.remove.push(name);
    else {
      plan.remove.push(name);
      plan.unregister.push(verdict.unregister);
    }
  }
  return plan;
}

export interface CleanupOutcome {
  freedBytes: number;
  removed: string[];
  /** 非空 = 清了但有清不掉的，状态落 warning——不装作清干净了 */
  warnings: string[];
}

/** 通过版 manifest 引用的音轨；读不到就返回 null（调用方据此保守全留 + 告警） */
async function keepAudioOf(dataDir: string, contentId: string, revision: number): Promise<string | null> {
  const manifest = await readVersioned<RenderManifest>(videoDir(dataDir, contentId), "render-manifest", revision);
  const file = manifest?.anchorAudio?.file;
  return typeof file === "string" && file ? path.basename(file) : null;
}

/**
 * 跑一次清理。**幂等**：第二次跑什么都没得删，返回 0 字节、无告警（§4 #10）。
 * 目录不存在（旧稿、被人删了）也不是故障——没东西可清就是清干净了。
 */
export async function runVideoCleanup(
  dataDir: string,
  contentId: string,
  approvedRevision: number,
): Promise<CleanupOutcome> {
  const dir = videoDir(dataDir, contentId);
  const warnings: string[] = [];
  const keepAudioFile = await keepAudioOf(dataDir, contentId, approvedRevision);
  if (keepAudioFile === null) {
    warnings.push(`读不到通过版 render-manifest.v${approvedRevision}，音轨一律保留（宁可占盘也不删还在用的）`);
  }
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { freedBytes: 0, removed: [], warnings };
  }
  // 子目录（assets/ 里的生成物）不在清理范围：那是素材不是测试产物
  const plan = planVideoCleanup(entries.filter((e) => e.isFile()).map((e) => e.name), {
    approvedRevision,
    keepAudioFile,
  });

  let freedBytes = 0;
  const removed: string[] = [];
  for (const name of plan.remove) {
    const file = path.join(dir, name);
    try {
      const stat = await fs.stat(file);
      await fs.rm(file, { force: true });
      freedBytes += stat.size;
      removed.push(name);
    } catch (err) {
      warnings.push(`删不掉 ${name}：${(err as Error).message}`);
    }
  }
  for (const revision of plan.unregister) {
    // 返回 false = 这一版没有受管登记（历史成片 / 人手挂接的同名文件）：不动它的登记
    await removeManagedFinalAsset(contentId, revision, dataDir).catch((err: unknown) => {
      warnings.push(`反登记成片 v${revision} 失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    });
  }
  return { freedBytes, removed, warnings };
}
