/**
 * cleanup.test.ts —— 成片收尾清理（lifecycle spec §3.2 / §3.3 + §4 边界 #10/#11/#13/#14）。
 *
 * 清理是**自动的删文件动作**，误删不可撤销，所以判定这一层逐条锁死：
 * 每一类文件的归宿都写成用例，认不出来的一律留在 untouched。
 * 「未知文件不动」不是注释里的承诺，是这里的一条断言。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addAsset, listAssets, removeManagedFinalAsset, upsertAsset } from "../../storage/local-store.js";
import { planVideoCleanup, runVideoCleanup } from "./cleanup.js";
import { registerFinalAsset } from "./render-exec.js";
import { seedVideoContent } from "./testkit.js";
import { videoDir, writeVersioned } from "./video-store.js";

const NAMES = [
  "state.json",
  "assets.json",
  "asr-out.json",
  "asr-input.wav",
  "transcript.v1.json",
  "cut.v1.json",
  "cut.v2.json",
  "edit-units.v2.json",
  "editor-plan.v3.json",
  "editor-decision.v3.json",
  "timeline.v2.json",
  "render-manifest.v2.json",
  "cut-preview-request.v4.json",
  "review-decision.v2.json",
  "anchor.v1.wav",
  "anchor.v2.wav",
  "master-audio.v2.wav",
  "final.v1.mp4",
  "final.v2.mp4",
  "final.v2.tmp.mp4",
  "final.v1.failed.mp4",
  "preview.v3.mp4",
  "preview-anchor.v3.wav",
  "preview-manifest.v3.json",
  "cut.vjob-1.staging.json",
  "timeline.json.tmp-123-456-ab",
  "anchor.v2.wav.tmp",
  "创始人自己放的笔记.txt",
];

describe("planVideoCleanup（§3.2 清单）", () => {
  const plan = planVideoCleanup(NAMES, { approvedRevision: 2, keepAudioFile: "master-audio.v2.wav" });

  it("删：全部预览、临时/残留、失败留档、asr-input；成片先走所有权核对", () => {
    expect(plan.remove).toEqual([
      "anchor.v1.wav",
      // 通过版引用的是 master-audio.v2.wav，anchor.v2 只是它的输入，可再生 → 也删
      "anchor.v2.wav",
      "anchor.v2.wav.tmp",
      "asr-input.wav",
      "cut.vjob-1.staging.json",
      "final.v1.failed.mp4",
      "final.v2.tmp.mp4",
      "preview-anchor.v3.wav",
      "preview-manifest.v3.json",
      "preview.v3.mp4",
      "timeline.json.tmp-123-456-ab",
    ]);
  });

  it("留：通过版成片、通过版引用的音轨、全部决策 JSON 与常驻文件", () => {
    expect(plan.keep).toEqual([
      "asr-out.json",
      "assets.json",
      "cut-preview-request.v4.json",
      "cut.v1.json",
      "cut.v2.json",
      "edit-units.v2.json",
      "editor-decision.v3.json",
      "editor-plan.v3.json",
      "final.v2.mp4",
      "master-audio.v2.wav",
      "render-manifest.v2.json",
      "review-decision.v2.json",
      "state.json",
      "timeline.v2.json",
      "transcript.v1.json",
    ]);
  });

  it("非通过版成片要反登记（按所有权删，不是按文件名）", () => {
    expect(plan.unregister).toEqual([1]);
  });

  it("认不出来的文件一律不动，但要报出来（不做宽泛 glob）", () => {
    expect(plan.untouched).toEqual(["创始人自己放的笔记.txt"]);
  });

  it("manifest 读不到（keepAudioFile=null）→ 所有 wav 保守全留", () => {
    const conservative = planVideoCleanup(NAMES, { approvedRevision: 2, keepAudioFile: null });
    expect(conservative.remove).not.toContain("anchor.v1.wav");
    expect(conservative.remove).not.toContain("master-audio.v2.wav");
    expect(conservative.keep).toContain("anchor.v1.wav");
  });

  it("通过版换了 → 留的那份也跟着换（判定只对着 approvedRevision）", () => {
    const other = planVideoCleanup(NAMES, { approvedRevision: 1, keepAudioFile: "anchor.v1.wav" });
    expect(other.keep).toContain("final.v1.mp4");
    expect(other.remove).not.toContain("final.v2.mp4");
    expect(other.unregister).toEqual([2]);
  });
});

describe("runVideoCleanup（执行层）", () => {
  let dir: string;
  let contentId: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-cleanup-"));
    contentId = (await seedVideoContent(dir)).contentId;
    const vdir = videoDir(dir, contentId);
    await fs.mkdir(path.join(vdir, "assets"), { recursive: true });
    await writeVersioned(vdir, "render-manifest", 2, { anchorAudio: { file: path.join(vdir, "anchor.v2.wav") } });
    for (const name of ["anchor.v1.wav", "anchor.v2.wav", "preview.v3.mp4", "asr-input.wav", "final.v1.mp4", "final.v2.mp4"]) {
      await fs.writeFile(path.join(vdir, name), "x".repeat(1024));
    }
    await registerFinalAsset(dir, contentId, path.join(vdir, "final.v1.mp4"), 1);
    await registerFinalAsset(dir, contentId, path.join(vdir, "final.v2.mp4"), 2);
    await fs.writeFile(path.join(vdir, "assets", "gen-01.png"), "keep-me");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("删掉测试产物、留下通过版与它引用的音轨；assets/ 子目录不碰", async () => {
    const r = await runVideoCleanup(dir, contentId, 2);
    expect(r.warnings).toEqual([]);
    expect(r.freedBytes).toBeGreaterThan(0);
    const left = await fs.readdir(videoDir(dir, contentId));
    expect(left).toContain("final.v2.mp4");
    expect(left).toContain("anchor.v2.wav");
    expect(left).not.toContain("final.v1.mp4");
    expect(left).not.toContain("anchor.v1.wav");
    expect(left).not.toContain("preview.v3.mp4");
    expect(left).not.toContain("asr-input.wav");
    // A-roll 与生成素材永不触碰
    await fs.access(path.join(videoDir(dir, contentId), "assets", "gen-01.png"));
    await fs.access(path.join(dir, "contents", contentId, "assets", "aroll.mp4"));
  });

  // 边界 #10
  it("再跑一次 → 幂等：没得删，0 字节、无告警", async () => {
    await runVideoCleanup(dir, contentId, 2);
    const again = await runVideoCleanup(dir, contentId, 2);
    expect(again.removed).toEqual([]);
    expect(again.freedBytes).toBe(0);
    expect(again.warnings).toEqual([]);
  });

  // 边界 #11：人手挂接的同名文件没有所有权标记，一律不碰
  it("非通过版成片：受管登记被反登记并删文件；同名手挂件无所有权 → 一个字不动", async () => {
    await registerFinalAsset(dir, contentId, path.join(videoDir(dir, contentId), "final.v1.mp4"), 1);
    expect((await listAssets(contentId, dir)).some((a) => a.filename === "final-v1.mp4")).toBe(true);
    await runVideoCleanup(dir, contentId, 2);
    expect((await listAssets(contentId, dir)).some((a) => a.filename === "final-v1.mp4")).toBe(false);

    // 换一种局面：同名素材是人手挂的（没有 managedBy）
    const mine0 = path.join(videoDir(dir, contentId), "final.v1.mp4");
    await fs.writeFile(mine0, "again");
    await addAsset(
      contentId,
      { filename: "final-v1.mp4", type: "video", description: "我自己拖进来的", sourcePath: mine0 },
      dir,
    );
    await runVideoCleanup(dir, contentId, 2);
    const mine = (await listAssets(contentId, dir)).find((a) => a.filename === "final-v1.mp4");
    expect(mine).toMatchObject({ description: "我自己拖进来的" });
    await fs.access(mine0);
    await fs.access(path.join(dir, "contents", contentId, "assets", "final-v1.mp4"));
  });

  // 边界 #13：通过版被人手删了也不算数据丢失——决策 JSON 全在，链路可重建
  it("通过版 manifest 读不到 → 音轨保守全留并告警（不删还可能在用的东西）", async () => {
    await fs.rm(path.join(videoDir(dir, contentId), "render-manifest.v2.json"));
    const r = await runVideoCleanup(dir, contentId, 2);
    expect(r.warnings.join()).toContain("音轨一律保留");
    const left = await fs.readdir(videoDir(dir, contentId));
    expect(left).toContain("anchor.v1.wav");
    expect(left).toContain("anchor.v2.wav");
    // 测试产物照删不误
    expect(left).not.toContain("preview.v3.mp4");
  });

  it("video 目录不存在（旧稿）→ 什么都不做，也不报错", async () => {
    await fs.rm(videoDir(dir, contentId), { recursive: true, force: true });
    const r = await runVideoCleanup(dir, contentId, 2);
    expect(r).toMatchObject({ freedBytes: 0, removed: [] });
  });
});

describe("受管成片的登记与反登记（§3.1）", () => {
  let dir: string;
  let contentId: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-own-"));
    contentId = (await seedVideoContent(dir)).contentId;
    await fs.mkdir(videoDir(dir, contentId), { recursive: true });
    await fs.writeFile(path.join(videoDir(dir, contentId), "final.v1.mp4"), "video-bytes");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("registerFinalAsset 幂等：同一版登记两次只留一条，且带所有权标记", async () => {
    const file = path.join(videoDir(dir, contentId), "final.v1.mp4");
    await registerFinalAsset(dir, contentId, file, 1);
    await registerFinalAsset(dir, contentId, file, 1);
    const finals = (await listAssets(contentId, dir)).filter((a) => a.filename === "final-v1.mp4");
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ managedBy: "video-pipeline", renderedRevision: 1 });
  });

  // 边界 #14：历史成片没有所有权字段，不回溯清理
  it("removeManagedFinalAsset 只删所有权与版本都对得上的那一条", async () => {
    await upsertAsset(contentId, { filename: "legacy.mp4", type: "video", description: "老成片" }, dir);
    await registerFinalAsset(dir, contentId, path.join(videoDir(dir, contentId), "final.v1.mp4"), 1);

    expect(await removeManagedFinalAsset(contentId, 2, dir)).toBe(false); // 版本对不上
    expect((await listAssets(contentId, dir))).toHaveLength(3); // aroll + legacy + final-v1

    expect(await removeManagedFinalAsset(contentId, 1, dir)).toBe(true);
    const left = (await listAssets(contentId, dir)).map((a) => a.filename);
    expect(left).toContain("legacy.mp4");
    expect(left).not.toContain("final-v1.mp4");
  });
});
