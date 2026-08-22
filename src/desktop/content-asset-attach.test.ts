/**
 * content-asset-attach.test.ts —— 挂接管道（横屏 spec §2.6）。
 *
 * 这一层要证的是「挂接时把哪些事实钉住了」：素材库元数据快照、role、一行说明、ffprobe 事实。
 * ffprobe 走真的——「读不出时长要带 warning」这条只有真读一次才算数。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addAssets as addLibraryAssets, updateAsset as updateLibraryAsset } from "../storage/library-store.js";
import { getContent, saveContent } from "../storage/local-store.js";
import { ensureArollFixture } from "../modules/video/testkit.js";
import { attachLibraryAsset } from "./content-asset-attach.js";

let dir: string;
let contentId: string;

/**
 * 往素材库塞一个文件（默认是 3 秒 640×360 的真 mp4），返回它的 library id。
 * `folder` 用来造「不同目录下的同名文件」——素材库按绝对路径去重，同路径不会入库第二次。
 */
async function seedLibrary(filename: string, source?: string, folder = "library-src"): Promise<string> {
  const abs = path.join(dir, folder, filename);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.copyFile(source ?? (await ensureArollFixture()), abs);
  const { added } = await addLibraryAssets([abs], null, dir);
  return added[0]!.id;
}

async function assets() {
  return (await getContent(contentId, dir))?.assets ?? [];
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-attach-"));
  contentId = (
    await saveContent({ title: "t", body: "b", platform: "douyin", status: "approved", tags: [], hashtags: [] }, dir)
  ).id;
  await fs.mkdir(path.join(dir, "contents", contentId, "assets"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("素材库元数据快照", () => {
  it("sourceLibraryId + name/tags/description 一并存下来（之前 tags 全丢）", async () => {
    const id = await seedLibrary("talk.mp4");
    await updateLibraryAsset(id, { name: "口播原片", tags: ["口播", "FDE"], description: "第 3 条的完整口播" }, dir);

    const r = await attachLibraryAsset({ contentId, libraryId: id, dataDir: dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.asset).toMatchObject({
      filename: "talk.mp4",
      sourceLibraryId: id,
      sourceName: "口播原片",
      tags: ["口播", "FDE"],
      description: "第 3 条的完整口播",
    });
  });

  it("快照是快照：事后改素材库不会回头改稿件里的说明", async () => {
    const id = await seedLibrary("talk.mp4");
    await updateLibraryAsset(id, { name: "原名", tags: ["旧"] }, dir);
    await attachLibraryAsset({ contentId, libraryId: id, dataDir: dir });
    await updateLibraryAsset(id, { name: "改过的名", tags: ["新"] }, dir);

    expect((await assets())[0]).toMatchObject({ sourceName: "原名", tags: ["旧"] });
  });
});

describe("role", () => {
  it("第一条 video 默认 aroll，第二条默认 broll", async () => {
    await attachLibraryAsset({ contentId, libraryId: await seedLibrary("a.mp4"), dataDir: dir });
    await attachLibraryAsset({ contentId, libraryId: await seedLibrary("b.mp4"), dataDir: dir });
    expect((await assets()).map((a) => a.role)).toEqual(["aroll", "broll"]);
  });

  it("人选了什么就是什么（默认值只是预填）", async () => {
    const id = await seedLibrary("screen.mp4");
    const r = await attachLibraryAsset({ contentId, libraryId: id, dataDir: dir, role: "broll" });
    expect(r.ok && r.asset.role).toBe("broll");
  });

  it("非法 role 回落到按类型猜，而不是写进一个谁也不认识的角色", async () => {
    const id = await seedLibrary("a.mp4");
    const r = await attachLibraryAsset({ contentId, libraryId: id, dataDir: dir, role: "随便写的" });
    expect(r.ok && r.asset.role).toBe("aroll");
  });
});

describe("一行说明", () => {
  it("人写的优先", async () => {
    const id = await seedLibrary("a.mp4");
    await updateLibraryAsset(id, { description: "库里的说明" }, dir);
    const r = await attachLibraryAsset({ contentId, libraryId: id, dataDir: dir, description: "  这条讲安装流程  " });
    expect(r.ok && r.asset.description).toBe("这条讲安装流程");
  });

  it("没写就用素材库 description", async () => {
    const id = await seedLibrary("a.mp4");
    await updateLibraryAsset(id, { name: "名字", tags: ["标签"], description: "库里的说明" }, dir);
    const r = await attachLibraryAsset({ contentId, libraryId: id, dataDir: dir });
    expect(r.ok && r.asset.description).toBe("库里的说明");
  });

  it("库里也没有 description → 用「名 · 标签」兜底，不留空白说明", async () => {
    const id = await seedLibrary("a.mp4");
    await updateLibraryAsset(id, { name: "命令行屏录", tags: ["屏录", "演示"] }, dir);
    const r = await attachLibraryAsset({ contentId, libraryId: id, dataDir: dir });
    expect(r.ok && r.asset.description).toBe("命令行屏录 · 屏录、演示");
  });
});

describe("ffprobe 事实", () => {
  it("视频素材登记时长/分辨率/帧率（agent 排时长要用，指纹给不了）", async () => {
    const r = await attachLibraryAsset({ contentId, libraryId: await seedLibrary("a.mp4"), dataDir: dir });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.asset.media?.durationMs).toBeGreaterThan(2800);
    expect(r.asset.media).toMatchObject({ width: 640, height: 360 });
    expect(r.asset.media?.fps).toBeCloseTo(30, 1);
  });

  it("图片不探测（没有时长这回事）", async () => {
    const png = path.join(dir, "shot.png");
    await fs.writeFile(png, "not really a png");
    const r = await attachLibraryAsset({ contentId, libraryId: await seedLibrary("shot.png", png), dataDir: dir });
    expect(r.ok && r.asset.media).toBeUndefined();
    expect(r.ok && r.warning).toBeUndefined();
  });

  it("读不出来仍然挂接，但要带 warning——不静默吞掉", async () => {
    const junk = path.join(dir, "broken.mp4");
    await fs.writeFile(junk, "not a video at all");
    const r = await attachLibraryAsset({ contentId, libraryId: await seedLibrary("broken.mp4", junk), dataDir: dir });
    expect(r.ok).toBe(true);
    expect(r.ok && r.asset.media).toBeUndefined();
    expect(r.ok && r.warning).toContain("读不出时长");
  });
});

describe("拒绝路径", () => {
  it("同名素材已挂接 → 拒（重复挂接会覆盖字节并双登记）", async () => {
    await attachLibraryAsset({ contentId, libraryId: await seedLibrary("a.mp4"), dataDir: dir });
    const twin = await seedLibrary("a.mp4", undefined, "another-dir");
    const again = await attachLibraryAsset({ contentId, libraryId: twin, dataDir: dir });
    expect(again.ok === false && again.error).toContain("同名素材已挂接");
  });

  it("原文件已被移走 → 拒，并指路去素材库重新定位", async () => {
    const id = await seedLibrary("a.mp4");
    await fs.rm(path.join(dir, "library-src", "a.mp4"));
    const r = await attachLibraryAsset({ contentId, libraryId: id, dataDir: dir });
    expect(r.ok === false && r.error).toContain("重新定位");
  });

  it("素材库里没这条 → 拒", async () => {
    const r = await attachLibraryAsset({ contentId, libraryId: "asset-1-nope", dataDir: dir });
    expect(r.ok === false && r.error).toBe("素材不存在");
  });

  it("稿件不存在 → 拒", async () => {
    const r = await attachLibraryAsset({ contentId: "content-1-nope", libraryId: await seedLibrary("a.mp4"), dataDir: dir });
    expect(r.ok === false && r.error).toBe("稿件不存在");
  });
});
