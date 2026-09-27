/**
 * 原片输入先行（P6 §12.4-B）：存在、可读、不是符号链接、两次 stat 一致（防还在拷贝）、全文件 sha256。
 * 认稿、弹窗确认、交接三处都过这一道，拒绝码统一 `aroll_invalid`，原因写人话。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expandHome } from "./roots.js";
import { sha256File } from "./manifest.js";

export interface ArollInput {
  path: string;
  sha256: string;
  size: number;
  mtimeMs: number;
}

export type ArollInputResult = { ok: true; value: ArollInput } | { ok: false; reason: string };

/** 两次 stat 之间的间隔：拷贝中的文件在这段时间里会长大或改修改时间 */
export const STABLE_GAP_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function readArollInput(raw: string, gapMs = STABLE_GAP_MS): Promise<ArollInputResult> {
  const file = path.resolve(expandHome(raw.trim()));
  let first;
  try {
    first = await fs.lstat(file);
  } catch {
    return { ok: false, reason: `找不到原片：${file}` };
  }
  if (first.isSymbolicLink()) return { ok: false, reason: `原片是符号链接，不接受：${file}` };
  if (!first.isFile()) return { ok: false, reason: `不是文件：${file}` };
  try {
    await fs.access(file, fs.constants.R_OK);
  } catch {
    return { ok: false, reason: `原片读不了（权限）：${file}` };
  }
  await sleep(gapMs);
  const sha256 = await sha256File(file);
  const second = await fs.lstat(file).catch(() => null);
  if (!second || second.size !== first.size || second.mtimeMs !== first.mtimeMs) {
    return { ok: false, reason: `原片还在变化（可能还在拷贝），等拷完再试：${file}` };
  }
  return { ok: true, value: { path: file, sha256, size: first.size, mtimeMs: first.mtimeMs } };
}
