/**
 * 审阅页正文 = 推送用的排版脚本 + 主题排出来的（所见即所推）；排版失败明写，不拿未排版正文冒充。
 * 真排版那几条要本机有 uv（CI 没装就跳过）；其余用桩。
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { formatArticleBody, formatArticleBodyCached, formatKey } from "./preview-format.js";
import { pathToFileURL } from "node:url";
import { renderArticlePreview, type PreviewInput } from "./preview.js";
import type { ArticleImageEntry } from "../publish/article-images.js";

const hasUv = !spawnSync("uv", ["--version"], { stdio: "ignore" }).error;
let dirs: string[] = [];
const tmp = async () => { const d = await fs.mkdtemp(path.join(os.tmpdir(), "acfmt-")); dirs.push(d); return d; };
afterEach(async () => { await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true }))); dirs = []; });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
async function input(theme: string) {
  const root = await tmp();
  const imagePath = path.join(root, "a.png");
  await fs.writeFile(imagePath, PNG);
  const entries = [{ index: 0, status: "ready", imagePath, kind: "gen", prompt: "示意" } as unknown as ArticleImageEntry];
  return { title: "标题二", body: "## 开头\n第一段正文\n\n[IMAGE: gen: 示意]\n\n第二段", entries, theme, dir: path.join(root, "fmt") };
}

describe("排版脚本跑审阅页正文", () => {
  it.runIf(hasUv)("用推送的同一个脚本 + 主题排：内联样式、配图指向排版产出的本地文件", async () => {
    const r = await formatArticleBody(await input("claude-scroll"));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain("第一段正文");
    expect(r.html).toMatch(/style="/);
    expect(r.html).toMatch(/src="file:\/\/[^"]+\/out\/article\/images\/img-01\.png"/);
  }, 120_000);

  it.runIf(hasUv)("主题不存在 → 失败并带脚本原话，不出正文", async () => {
    const r = await formatArticleBody(await input("no-such-theme-xyz"));
    expect(r).toMatchObject({ ok: false, theme: "no-such-theme-xyz" });
    if (!r.ok) expect(r.error).toMatch(/no-such-theme-xyz/);
  }, 120_000);

  it("uv 没装 → 失败说 uv 没装；缓存不记失败", async () => {
    const i = await input("claude-scroll");
    const r = await formatArticleBodyCached(i, { uv: "autocrew-no-such-uv" });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/uv 没装/);
    await expect(fs.access(`${i.dir}.json`)).rejects.toThrow();
  });
});

describe("审阅页", () => {
  const base = (formatted: PreviewInput["formatted"]): PreviewInput => ({
    contentId: "x", title: "工作标题", body: "原始正文不该出现", pkg: { titleOptions: ["标题一", "标题二"], chosenTitle: "标题二" }, entries: [],
    chars: 2513, problems: [], suggestedSource: null, approval: "还没批", formatted,
  });

  it("排版成功：嵌入排版产出；标题候选不再双编号", () => {
    const html = renderArticlePreview(base({ ok: true, theme: "claude-scroll", html: "<section style=\"x\">排好的</section>" }));
    expect(html).toContain("<section style=\"x\">排好的</section>");
    expect(html).toContain("主题 claude-scroll");
    expect(html).not.toMatch(/<li[^>]*>\d+\. /);
    expect(html).not.toContain("原始正文不该出现");
  });

  it("排版失败：明写失败和原因，不给未排版的正文", () => {
    const html = renderArticlePreview(base({ ok: false, theme: "claude-scroll", error: "uv 没装" }));
    expect(html).toContain("正文排版没出来（主题 claude-scroll）");
    expect(html).toContain("uv 没装");
    expect(html).not.toContain("原始正文不该出现");
  });
});

describe("Codex 审 P2：缓存", () => {
  /** 一套假的推送脚本目录：scripts/publish.py + format.py + themes/t.json */
  async function vendor() {
    const root = await tmp();
    await fs.mkdir(path.join(root, "scripts"), { recursive: true });
    await fs.mkdir(path.join(root, "themes"), { recursive: true });
    await fs.writeFile(path.join(root, "scripts", "publish.py"), "");
    await fs.writeFile(path.join(root, "scripts", "format.py"), "v1");
    await fs.writeFile(path.join(root, "themes", "t.json"), "{\"a\":1}");
    return root;
  }

  it("同名主题文件或排版脚本改了 → 缓存键变", async () => {
    const root = await vendor();
    const i = { ...(await input("t")), publishScript: path.join(root, "scripts", "publish.py") };
    const k1 = await formatKey(i);
    await fs.writeFile(path.join(root, "themes", "t.json"), "{\"a\":2}");
    const k2 = await formatKey(i);
    await fs.writeFile(path.join(root, "scripts", "format.py"), "v2");
    const k3 = await formatKey(i);
    expect(new Set([k1, k2, k3]).size).toBe(3);
  });

  it("缓存命中但引用的图没了 / 不在本文排版目录里 → 重排（这里 uv 不在，重排即失败）；图都在 → 用缓存", async () => {
    const i = await input("claude-scroll");
    await fs.mkdir(path.join(i.dir, "out", "article", "images"), { recursive: true });
    const inside = path.join(i.dir, "out", "article", "images", "img-01.png");
    await fs.writeFile(inside, PNG);
    const stamp = `${i.dir}.json`;
    const key = await formatKey(i);
    const put = (html: string) => fs.writeFile(stamp, JSON.stringify({ key, html }));
    const noUv = { uv: "autocrew-no-such-uv" };

    await put(`<img src="${pathToFileURL(inside).href}">`);
    expect(await formatArticleBodyCached(i, noUv)).toMatchObject({ ok: true });

    await put(`<img src="${pathToFileURL(i.entries[0]!.imagePath!).href}">`);
    expect(await formatArticleBodyCached(i, noUv)).toMatchObject({ ok: false });

    await put(`<img src="${pathToFileURL(inside).href}">`);
    await fs.rm(inside);
    expect(await formatArticleBodyCached(i, noUv)).toMatchObject({ ok: false });
  });
});
