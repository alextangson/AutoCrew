import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { makeFixture, handedOff } from "./handoff-testkit.js";
import { initializeProjectLayout } from "../../../storage/content-project.js";
import { founderProjectReview } from "./founder-review.js";
import { coverRole, scanCoverFolder } from "./cover-scan.js";
import { sha256File } from "./manifest.js";

/** 只要文件头对：PNG 签名 + IHDR 宽高，后面带一段区分内容的字节 */
async function png(file: string, width: number, height: number, tag: string): Promise<string> {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8); head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16); head.writeUInt32BE(height, 20);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.concat([head, Buffer.from(tag)]));
  return file;
}

let env: Awaited<ReturnType<typeof makeFixture>>;
beforeEach(async () => { env = await makeFixture(); await fs.unlink(path.join(env.dir, "video.json")); await initializeProjectLayout(env.dir, "lib-deadbeef", "default"); });
afterEach(async () => { await env.cleanup(); });

it("按像素认比例，不信文件名", () => {
  expect(coverRole(1086, 1448)).toBe("cover:3:4");
  expect(coverRole(1448, 1086)).toBe("cover:4:3");
  expect(coverRole(1920, 1080)).toBeNull();
  expect(coverRole(0, 10)).toBeNull();
});

it("有清单的版本只认清单里的图，参考照片按比例筛掉；没清单的版本扫全部；版本号取文件夹名", async () => {
  // 2026-09-27：Codex 出了 v001、v002 两批只写了自己的 cover-manifest.json，从没 report
  const v = await handedOff(env.dir, env.aroll);
  const v1 = path.join(v.root, "05-cover/v001");
  await png(path.join(v1, "深度思考-封面-3x4-待审核.png"), 1086, 1448, "a");
  await png(path.join(v1, "深度思考-封面-4x3-待审核.png"), 1448, 1086, "b");
  await png(path.join(v1, "草稿-没进清单.png"), 1086, 1448, "c");
  await png(path.join(v1, "identity-current-aroll.png"), 1080, 1920, "d");
  await fs.writeFile(path.join(v1, "cover-manifest.json"), JSON.stringify({ outputs: [
    { path: path.join(v1, "深度思考-封面-3x4-待审核.png") }, { path: path.join(v1, "深度思考-封面-4x3-待审核.png") }, { path: "../../outside.png" },
  ] }));
  await png(path.join(v.root, "05-cover/v002/横版-文件名写错成3x4.png"), 1448, 1086, "e");
  await png(path.join(v.root, "05-cover/refs/不是版本文件夹.png"), 1086, 1448, "f");
  const covers = await scanCoverFolder(v.root, 1);
  expect(covers.map((c) => [path.basename(c.path), c.role, c.version])).toEqual([
    ["深度思考-封面-3x4-待审核.png", "cover:3:4", 1],
    ["深度思考-封面-4x3-待审核.png", "cover:4:3", 1],
    ["横版-文件名写错成3x4.png", "cover:4:3", 2],
  ]);
});

it("Codex 一次没 report，文件夹里的封面照样能选、能批准；report 过的同一张不重复", async () => {
  const v = await handedOff(env.dir, env.aroll);
  const c34 = await png(path.join(v.root, "05-cover/v001/3x4.png"), 1086, 1448, "x");
  const c43 = await png(path.join(v.root, "05-cover/v001/4x3.png"), 1448, 1086, "y");
  const before = await founderProjectReview(v.id, env.dir);
  const arts = (before.execution as { artifacts: Array<{ role: string }> }).artifacts;
  expect(arts.map((a) => a.role).sort()).toEqual(["cover:3:4", "cover:4:3"]);
  expect((before.execution as { heartbeat: { reported_at: string } }).heartbeat.reported_at).toBe("");
  expect((await v.report([{ file: c34, role: "cover:3:4", version: 1 }])).ok).toBe(true);
  const after = await founderProjectReview(v.id, env.dir);
  expect((after.execution as { artifacts: unknown[] }).artifacts).toHaveLength(2);
  const r = await founderProjectReview(v.id, env.dir, { action: "select_cover", ratio: "4:3", sha256: await sha256File(c43) });
  expect((r.cover_selection as Record<string, { version: number }>)["4:3"].version).toBe(1);
});
