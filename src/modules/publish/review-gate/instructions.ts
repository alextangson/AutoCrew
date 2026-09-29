/**
 * 网页「让 Codex 发布」的指令留底（发布前把关 spec §6，Codex P2-7）。
 *
 * 创始人点「只复制」或「复制并打开」时，服务端存下**编辑后的实际文本**，给一个 `ins-…` 编号，
 * 编号写进复制出去的文本末行。复制 / 打开不等于发送或授权——这里只留底，不改任何状态。
 * check 只读 agent 传来的那个编号；不传就没有网页指令，**不取「最近一份」**。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { contentRoot, isMissing, safeProjectPath } from "../../../storage/content-project.js";
import { writeJsonAtomicMkdir } from "../../../storage/json-atomic.js";
import { getContent } from "../../../storage/local-store.js";
import { missingAsNull } from "./plan.js";

export const INSTRUCTION_LINE_PREFIX = "指令编号：";
const ID_RE = /^ins-\d{14}-[a-f0-9]{6}$/;
const MAX_TEXT = 20_000;

export type InstructionVia = "copy" | "copy_open";
export interface StoredInstruction { id: string; content_id: string; text: string; via: InstructionVia; saved_at: string }

function instructionFile(contentId: string, id: string, dataDir?: string): string {
  return safeProjectPath(contentRoot(contentId, dataDir), path.join("06-publish", "instructions", `${id}.json`));
}

function newInstructionId(now = new Date()): string {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `ins-${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

/** 复制出去的文本 = 编辑后的文本 + 末行编号 */
export function withInstructionLine(text: string, id: string): string {
  return `${text.replace(/\s+$/, "")}\n${INSTRUCTION_LINE_PREFIX}${id}`;
}

export async function saveInstruction(contentId: string, text: unknown, via: unknown, dataDir?: string): Promise<{ ok: true; instruction: StoredInstruction; copy_text: string } | { ok: false; error: string }> {
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "指令是空的，没有可保存的文字" };
  if (text.length > MAX_TEXT) return { ok: false, error: `指令超过 ${MAX_TEXT} 字，存不下` };
  if (via !== "copy" && via !== "copy_open") return { ok: false, error: "via 只能是 copy 或 copy_open" };
  if (!/^content-\d+-[a-z0-9]+$/.test(contentId) || !(await getContent(contentId, dataDir).catch(missingAsNull))) return { ok: false, error: `稿件不存在：${contentId.slice(0, 60)}` };
  // 编辑框里若还留着上一次的编号行，去掉再存，免得一份指令带两个编号
  const clean = text.split("\n").filter((l) => !l.startsWith(INSTRUCTION_LINE_PREFIX)).join("\n").replace(/\s+$/, "");
  const instruction: StoredInstruction = { id: newInstructionId(), content_id: contentId, text: clean, via, saved_at: new Date().toISOString() };
  await writeJsonAtomicMkdir(instructionFile(contentId, instruction.id, dataDir), instruction);
  return { ok: true, instruction, copy_text: withInstructionLine(clean, instruction.id) };
}

export type ReadInstruction = { ok: true; instruction: StoredInstruction } | { ok: false; code: "bad_instruction_id" | "instruction_not_found"; error: string };

export async function readInstruction(contentId: string, id: string, dataDir?: string): Promise<ReadInstruction> {
  if (!ID_RE.test(id)) return { ok: false, code: "bad_instruction_id", error: `指令编号格式不对：${id.slice(0, 40)}（应形如 ins-20260929120000-a1b2c3）` };
  try {
    const raw = JSON.parse(await fs.readFile(instructionFile(contentId, id, dataDir), "utf8")) as StoredInstruction;
    if (raw.id !== id || raw.content_id !== contentId || typeof raw.text !== "string") return { ok: false, code: "instruction_not_found", error: `指令 ${id} 不属于这条内容` };
    return { ok: true, instruction: raw };
  } catch (e) {
    if (isMissing(e)) return { ok: false, code: "instruction_not_found", error: `这条内容下没有指令 ${id}：只认网页「让 Codex 发布」复制出去的编号` };
    throw e;
  }
}

/** 指令按句切（去掉编号行），供 Jev B 逐条编号 */
export function splitInstruction(text: string): string[] {
  return text.split("\n").filter((l) => !l.startsWith(INSTRUCTION_LINE_PREFIX))
    .flatMap((l) => l.split(/(?<=[。！？!?；;])/))
    .map((s) => s.trim()).filter((s) => s.length > 1);
}
