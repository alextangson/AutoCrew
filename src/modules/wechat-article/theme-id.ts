/**
 * 排版主题的身份 = 名字 + 主题文件内容的指纹（Codex 审 P2）：同名主题文件改过，也算换了主题。
 * 解析规则与 format.py 的 load_theme 一致：themes/<名>.json；否则 <布局>-<色板> 组合（layouts/ + palettes/）。
 * 主题文件跟着推送脚本走：推送用哪个 publish.py，就看它旁边的 themes/。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadWechatMpConfig } from "../publish/wechat-config.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_PUBLISH_SCRIPT = path.join(REPO_ROOT, "vendor", "wechat-format", "scripts", "publish.py");

export interface ThemeId { name: string; sha: string }

/** format.py 和 publish.py 同目录：推送用哪个脚本，审阅页就用它旁边的排版脚本 */
export function formatScriptPath(publishScript?: string): string {
  return path.join(path.dirname(publishScript || process.env.AUTOCREW_WECHAT_PUBLISH_SCRIPT || DEFAULT_PUBLISH_SCRIPT), "format.py");
}

const read = (p: string) => fs.readFile(p).catch(() => null);

/** 主题文件内容指纹；找不到文件记 missing（排版会失败并明写，不在这里猜） */
export async function themeSha(name: string, formatScript: string): Promise<string> {
  const dir = path.join(path.dirname(path.dirname(formatScript)), "themes");
  const plain = await read(path.join(dir, `${name}.json`));
  if (plain) return createHash("sha256").update(plain).digest("hex");
  const dash = name.indexOf("-");
  if (dash > 0) {
    const [layout, palette] = await Promise.all([read(path.join(dir, "layouts", `${name.slice(0, dash)}.json`)), read(path.join(dir, "palettes", `${name.slice(dash + 1)}.json`))]);
    if (layout && palette) return createHash("sha256").update(layout).update("\0").update(palette).digest("hex");
  }
  return "missing";
}

/** 设置里现在的主题（没配 = newspaper）+ 它的文件指纹 */
export async function currentThemeId(dataDir?: string): Promise<ThemeId> {
  const cfg = await loadWechatMpConfig(dataDir);
  const name = cfg.theme?.trim() || "newspaper";
  return { name, sha: await themeSha(name, formatScriptPath(cfg.wechatPublishScript)) };
}

export const sameTheme = (a: ThemeId | undefined, b: ThemeId): boolean => !!a && typeof a === "object" && a.name === b.name && a.sha === b.sha;
