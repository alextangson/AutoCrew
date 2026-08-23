/**
 * broll-catalog.test.ts —— 剪辑师目录（lifecycle spec §1 + §4 边界 #1–#5）。
 *
 * 目录构成是本刀的第一件事，也是最容易悄悄错的一件：去重错了会让同一条素材出现两次、
 * 截断错了会让本稿专门准备的素材被常备池挤掉、指纹漏了会让「同名换内容」永远看不见。
 * 所以这一层全部用确定性用例锁死，一条都不靠观察。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LibraryAsset } from "../../storage/library-store.js";
import { addAssets, getAsset, listReusableAssets, updateAsset } from "../../storage/library-store.js";
import type { Asset } from "../../storage/local-store.js";
import {
  buildBrollCatalog,
  catalogDigest,
  mergeCandidates,
  scanBrollCandidates,
  scanPoolCandidates,
  trimCandidates,
  type EditorCandidate,
} from "./broll-catalog.js";
import { setLibraryReusable } from "./library-pool.js";
import { ensureArollFixture, seedBrollAsset, seedVideoContent } from "./testkit.js";

const asset = (over: Partial<Asset>): Asset => ({
  filename: "x.mp4",
  type: "video",
  addedAt: "2026-08-22T00:00:00.000Z",
  role: "broll",
  description: "屏录：一段演示",
  media: { durationMs: 8_000 },
  ...over,
});

const libAsset = (over: Partial<LibraryAsset>): LibraryAsset => ({
  id: "asset-1-aaa",
  name: "logo.png",
  path: "/tmp/logo.png",
  type: "image",
  ext: "png",
  size: 100,
  folderId: null,
  tags: ["品牌"],
  description: "品牌 logo 定版",
  reusable: true,
  addedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

describe("本稿素材清单（§2.6 兜底规则）", () => {
  it("只收 role=broll 且有说明的；编号从 b1 起", () => {
    const scan = scanBrollCandidates([
      asset({ filename: "a.mp4" }),
      asset({ filename: "b.png", type: "image", media: undefined }),
      asset({ filename: "aroll.mp4", role: "aroll" }),
    ]);
    expect(scan.candidates.map((c) => [c.assetId, c.filename, c.kind, c.origin])).toEqual([
      ["b1", "a.mp4", "screen", "content"],
      ["b2", "b.png", "image", "content"],
    ]);
    expect(scan.excluded).toEqual([]);
  });

  it("没写说明 / 读不出时长 / 不是视听素材 → 排除且点名（面板要说清楚）", () => {
    const scan = scanBrollCandidates([
      asset({ filename: "nodesc.mp4", description: "  " }),
      asset({ filename: "nodur.mp4", media: undefined }),
      asset({ filename: "note.txt", type: "other" }),
    ]);
    expect(scan.candidates).toEqual([]);
    expect(scan.excluded.join()).toContain("nodesc.mp4（没写说明）");
    expect(scan.excluded.join()).toContain("nodur.mp4（读不出时长");
    expect(scan.excluded.join()).toContain("note.txt（不是视频或图片");
  });

  it("素材过多 → 按预算截断，被截的进 excluded（边界 #9）", () => {
    const many = Array.from({ length: 20 }, (_, i) => asset({ filename: `s${i}.mp4`, description: "屏".repeat(80) }));
    const trimmed = trimCandidates(scanBrollCandidates(many), 500);
    expect(trimmed.candidates.length).toBeGreaterThan(0);
    expect(trimmed.candidates.length).toBeLessThan(20);
    expect(trimmed.excluded.join()).toContain("超出本次上下文预算");
  });
});

describe("常备池候选（§1）", () => {
  it("视频要有 media.durationMs 才进得来，进不来的点名（边界 #2）", () => {
    const scan = scanPoolCandidates([
      libAsset({ id: "asset-1-aaa" }),
      libAsset({ id: "asset-2-bbb", name: "clip.mp4", type: "video", ext: "mp4" }),
      libAsset({ id: "asset-3-ccc", name: "ok.mp4", type: "video", ext: "mp4", media: { durationMs: 12_000 } }),
      libAsset({ id: "asset-4-ddd", name: "bgm.wav", type: "audio", ext: "wav" }),
    ]);
    expect(scan.candidates.map((c) => c.filename)).toEqual(["logo.png", "ok.mp4"]);
    expect(scan.candidates.every((c) => c.origin === "pool")).toBe(true);
    expect(scan.candidates[0]!.ref).toEqual({ kind: "library", id: "asset-1-aaa" });
    expect(scan.excluded.join()).toContain("clip.mp4（常备素材读不出时长");
    expect(scan.excluded.join()).toContain("bgm.wav（常备素材不是视频或图片");
  });

  // 边界 #4
  it("同一库素材既挂本稿又在常备池 → 按 sourceLibraryId 去重，本稿副本优先", () => {
    const content = scanBrollCandidates([
      asset({ filename: "logo.png", type: "image", media: undefined, sourceLibraryId: "asset-1-aaa", description: "本稿版说明" }),
    ]);
    const merged = mergeCandidates(content, scanPoolCandidates([libAsset({})]));
    expect(merged.candidates).toHaveLength(1);
    expect(merged.candidates[0]).toMatchObject({ assetId: "b1", label: "本稿版说明", origin: "content" });
  });

  // 边界 #3
  it("超预算时先保本稿挂接，被截的常备素材点名", () => {
    const content = scanBrollCandidates([asset({ filename: "mine.mp4", description: "屏".repeat(200) })]);
    const pool = scanPoolCandidates([
      libAsset({ id: "asset-9-zzz", name: "pool.png", description: "常".repeat(200) }),
    ]);
    const trimmed = trimCandidates(mergeCandidates(content, pool), 300);
    expect(trimmed.candidates.map((c) => c.filename)).toEqual(["mine.mp4"]);
    expect(trimmed.excluded.join()).toContain("pool.png（常备素材太多");
  });
});

describe("目录指纹（§1：ref + fingerprint + tags + media 全都算进去）", () => {
  const base = (over: Partial<EditorCandidate> = {}): EditorCandidate => ({
    assetId: "b1",
    kind: "image",
    label: "品牌 logo 定版",
    filename: "logo.png",
    tags: ["品牌"],
    ref: { kind: "library", id: "asset-1-aaa" },
    origin: "pool",
    fingerprint: { size: 10, mtimeMs: 1, quickHash: "hash-a" },
    ...over,
  });

  it("同样的输入 → 同样的指纹（runner 与 phase 必须算出同一份）", () => {
    expect(catalogDigest([base()], ["x"])).toBe(catalogDigest([base()], ["x"]));
  });

  it("文件内容换了（同名同说明）→ 指纹变，plan 会被重算", () => {
    const changed = base({ fingerprint: { size: 10, mtimeMs: 1, quickHash: "hash-b" } });
    expect(catalogDigest([changed], [])).not.toBe(catalogDigest([base()], []));
  });

  it("标签、时长、ref 任一变化都算换输入", () => {
    const digest = catalogDigest([base()], []);
    expect(catalogDigest([base({ tags: ["品牌", "新"] })], [])).not.toBe(digest);
    expect(catalogDigest([base({ durationMs: 3_000 })], [])).not.toBe(digest);
    expect(catalogDigest([base({ ref: { kind: "library", id: "asset-2-bbb" } })], [])).not.toBe(digest);
  });

  it("标签顺序不算变化（同一组标签换个次序不该触发重跑）", () => {
    expect(catalogDigest([base({ tags: ["b", "a"] })], [])).toBe(catalogDigest([base({ tags: ["a", "b"] })], []));
  });
});

describe("常备池开关（§1 前置 + §4 #1）", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-pool-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const importOne = async (): Promise<LibraryAsset> => {
    const { added } = await addAssets([await ensureArollFixture()], null, dir);
    return added[0]!;
  };

  // 边界 #1
  it("说明为空 → 拒绝开启，提示先写说明", async () => {
    const a = await importOne();
    const result = await setLibraryReusable(a.id, true, dir);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("先给");
    expect(await listReusableAssets(dir)).toEqual([]);
  });

  it("有说明 → 开启成功，并补探 media（存量素材纳池时补探）", async () => {
    const a = await importOne();
    await updateAsset(a.id, { description: "屏录：口播底轨夹具" }, dir);
    const result = await setLibraryReusable(a.id, true, dir);
    expect(result.ok).toBe(true);
    const stored = (await getAsset(a.id, dir))!;
    expect(stored.reusable).toBe(true);
    expect(stored.media?.durationMs).toBeGreaterThan(0);
    expect((await listReusableAssets(dir)).map((x) => x.id)).toEqual([a.id]);
  });

  it("开了之后把说明清空 → 不再算常备池成员（不留「有 reusable 没说明」的空壳）", async () => {
    const a = await importOne();
    await updateAsset(a.id, { description: "屏录：口播底轨夹具" }, dir);
    await setLibraryReusable(a.id, true, dir);
    await updateAsset(a.id, { description: "   " }, dir);
    expect(await listReusableAssets(dir)).toEqual([]);
  });

  it("历史上带「常备」字样标签的素材不自动升格（保留字标签的语义从未被承诺）", async () => {
    const a = await importOne();
    await updateAsset(a.id, { tags: ["常备", "屏录"], description: "有说明的" }, dir);
    expect(await listReusableAssets(dir)).toEqual([]);
  });
});

describe("buildBrollCatalog（runner 与 phase 的唯一入口）", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-catalog-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("本稿 broll + 常备池合成一份，指纹进目录指纹；重复调用结果一致", async () => {
    const { contentId } = await seedVideoContent(dir);
    await seedBrollAsset(dir, contentId, { filename: "screen.mp4", description: "屏录：产品界面" });
    const { added } = await addAssets([await ensureArollFixture()], null, dir);
    await updateAsset(added[0]!.id, { description: "常备：品牌片头" }, dir);
    await setLibraryReusable(added[0]!.id, true, dir);

    const { getContent } = await import("../../storage/local-store.js");
    const content = await getContent(contentId, dir);
    const first = await buildBrollCatalog(dir, contentId, content!.assets);
    expect(first.candidates.map((c) => c.origin)).toEqual(["content", "pool"]);
    expect(first.candidates.every((c) => c.fingerprint.quickHash.length > 0)).toBe(true);

    const second = await buildBrollCatalog(dir, contentId, content!.assets);
    expect(second.digest).toBe(first.digest);
  });

  // 边界 #2：常备素材文件被删 → 存在性拦截并点名，不是静默少一条
  it("常备素材原文件不见了 → 剔除并点名，目录指纹随之改变", async () => {
    const { contentId } = await seedVideoContent(dir);
    const copy = path.join(dir, "pool-clip.mp4");
    await fs.copyFile(await ensureArollFixture(), copy);
    const { added } = await addAssets([copy], null, dir);
    await updateAsset(added[0]!.id, { description: "常备：片头" }, dir);
    await setLibraryReusable(added[0]!.id, true, dir);

    const { getContent } = await import("../../storage/local-store.js");
    const content = await getContent(contentId, dir);
    const before = await buildBrollCatalog(dir, contentId, content!.assets);
    expect(before.candidates).toHaveLength(1);

    await fs.rm(copy);
    const after = await buildBrollCatalog(dir, contentId, content!.assets);
    expect(after.candidates).toHaveLength(0);
    expect(after.excluded.join()).toContain("pool-clip.mp4（常备素材读不到文件");
    expect(after.digest).not.toBe(before.digest);
  });
});
