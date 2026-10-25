/**
 * 推荐只活在前端触点里（spec 2026-10-25-tokencamel-touchpoint §2.3 / §8-6）：
 * 后端、引擎、提示词、写稿包、发布包、MCP 工具、templates/、skills/ 都不许出现推荐名与推荐文案。
 * 例外只有预设文件与 settings 的三条通道实现（它们要认这个地址，但不带任何推荐话术）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OFFER_COPY } from "../frontend/src/views/tokencamel-offer";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ALLOWED = new Set([
  "src/engine/presets/tokencamel.json",
  "src/desktop/settings-offer.ts",
  "src/desktop/settings-attach.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (!/\.test\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("推荐不外溢（§8-6）", () => {
  it("src/、mcp/、templates/、skills/ 里没有推荐名与推荐文案（预设文件与 settings 通道除外）", () => {
    const needles = [/tokencamel/i, /骆驼词元/, ...Object.values(OFFER_COPY).filter((s) => s.length >= 6).map((s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))];
    const hits: string[] = [];
    for (const top of ["src", "mcp", "templates", "skills"]) {
      for (const file of walk(path.join(ROOT, top))) {
        const rel = path.relative(ROOT, file).split(path.sep).join("/");
        if (ALLOWED.has(rel)) continue;
        const text = fs.readFileSync(file, "utf-8");
        for (const n of needles) if (n.test(text)) hits.push(`${rel} ~ ${n}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("settings 通道实现里也不带推荐话术（只认地址）", () => {
    const copy = Object.values(OFFER_COPY).filter((s) => s.length >= 6 && !/TokenCamel/.test(s));
    for (const rel of ["src/desktop/settings-offer.ts", "src/desktop/settings-attach.ts"]) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf-8");
      for (const s of copy) expect(text.includes(s), `${rel} 含「${s}」`).toBe(false);
    }
  });
});
