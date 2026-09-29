/**
 * 「我的内容/⚠️ 同步出错.txt」：对账和 NAS 归档共用这一个文件。
 * 各自的问题记在隐藏的 .autocrew-errors.json 里分栏保存，谁更新谁那一栏；两栏都空时删掉文本文件。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isMissing } from "./content-project.js";

export const ERROR_FILE = "⚠️ 同步出错.txt";
const ERROR_STATE = ".autocrew-errors.json";
export type ErrorSection = "sync" | "backup" | "archive";
type ErrorState = Partial<Record<ErrorSection, string[]>>;

const HEADINGS: Record<ErrorSection, string> = {
  sync: "「我的内容」上一次对账",
  backup: "NAS 备份",
  archive: "NAS 归档",
};

async function readState(root: string): Promise<ErrorState> {
  try { return JSON.parse(await fs.readFile(path.join(root, ERROR_STATE), "utf8")) as ErrorState; }
  catch (e) { if (isMissing(e)) return {}; throw e; }
}

function render(state: ErrorState): string {
  const parts: string[] = [];
  for (const section of ["sync", "backup", "archive"] as const) {
    const errors = state[section] ?? [];
    if (!errors.length) continue;
    parts.push(`${HEADINGS[section]}有 ${errors.length} 处问题（其它条目照常处理）：\n\n${errors.map((e) => `- ${e}`).join("\n")}\n`);
  }
  return `${parts.join("\n")}\n问题解决、下一次全部成功后这个文件会自动消失。\n`;
}

/** 替换某一栏的问题列表，并重写（或删掉）⚠️ 同步出错.txt */
export async function writeErrorSection(root: string, section: ErrorSection, errors: string[]): Promise<void> {
  const state = await readState(root);
  state[section] = errors;
  const stateFile = path.join(root, ERROR_STATE), file = path.join(root, ERROR_FILE);
  if (!Object.values(state).some((list) => list?.length)) {
    await fs.rm(file, { force: true });
    await fs.rm(stateFile, { force: true });
    return;
  }
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
  await fs.writeFile(file, render(state));
}
