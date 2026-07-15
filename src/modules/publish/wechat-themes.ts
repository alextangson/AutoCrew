/**
 * 列出 vendored 公众号排版主题,给设置页的主题下拉用。
 * id = 文件名(publish.py --theme 认这个);name = 主题 JSON 里的中文名。
 */
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const THEMES_DIR = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  "vendor",
  "wechat-format",
  "themes",
);

export interface WechatTheme {
  id: string;
  name: string;
}

export async function listWechatThemes(): Promise<WechatTheme[]> {
  let files: string[];
  try {
    files = await fs.readdir(THEMES_DIR);
  } catch {
    return [];
  }
  const themes: WechatTheme[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -5);
    let name = id;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(THEMES_DIR, file), "utf-8")) as { name?: string };
      if (typeof parsed.name === "string" && parsed.name.trim()) name = parsed.name.trim();
    } catch {
      // 单个坏主题文件不该拖垮整张列表——用文件名兜底。
    }
    themes.push({ id, name });
  }
  themes.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return themes;
}
