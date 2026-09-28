/**
 * 字号尺子守门（组件样张 F-system）：frontend/src 下的 CSS 只能用 6 个字号。
 * 豁免 views/platform-mock.css——它照抄第三方 App 的真实字号，用来模拟平台预览。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname);
const EXEMPT = new Set(["views/platform-mock.css"]);
const ALLOWED_PX = new Set([12, 13, 14, 16, 22, 28]);
const ALLOWED_VARS = new Set(["--fs-xs", "--fs-sm", "--fs-md", "--fs-lg", "--fs-xl", "--fs-2xl"]);

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return name.endsWith(".css") ? [full] : [];
  });
}

/** 取出每条 font-size / font 简写里的字号记号。 */
export function fontSizeTokens(css: string): string[] {
  const out: string[] = [];
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of noComments.matchAll(/(?<![\w-])font-size\s*:\s*([^;}]+)/g)) out.push(m[1].trim());
  for (const m of noComments.matchAll(/(?<![\w-])font\s*:\s*([^;}]+)/g)) {
    const size = m[1].trim().match(/(?:^|\s)((?:var\([^)]*\))|[\d.]+[a-z%]+)(?=\/|\s|$)/);
    if (size && m[1].trim() !== "inherit") out.push(size[1]);
  }
  return out;
}

export function isAllowedSize(token: string): boolean {
  const v = token.match(/^var\((--[\w-]+)\)$/);
  if (v) return ALLOWED_VARS.has(v[1]);
  if (token === "inherit") return true;
  const px = token.match(/^(\d+)px$/);
  return px !== null && ALLOWED_PX.has(Number(px[1]));
}

describe("frontend type scale", () => {
  it("flags sizes outside the scale", () => {
    expect(fontSizeTokens(".a { font-size: 15px } .b { font: 11px/1.2 var(--mono) }")).toEqual(["15px", "11px"]);
    expect(isAllowedSize("15px")).toBe(false);
    expect(isAllowedSize("1.2em")).toBe(false);
    expect(isAllowedSize("var(--fs-md)")).toBe(true);
    expect(isAllowedSize("14px")).toBe(true);
  });

  it("every CSS file in frontend/src uses only the six sizes", () => {
    const bad: string[] = [];
    for (const file of cssFiles(ROOT)) {
      const rel = relative(ROOT, file);
      if (EXEMPT.has(rel)) continue;
      for (const token of fontSizeTokens(readFileSync(file, "utf8"))) {
        if (!isAllowedSize(token)) bad.push(`${rel}: ${token}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
