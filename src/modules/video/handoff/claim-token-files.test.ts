/**
 * 共享项目文件夹里没有明文认领令牌（§12.4-D；3a 评审）：Codex 读得到整个项目文件夹，
 * meta.json / 项目信息.md / workflow-state.json / AGENTS.md / 交接包里都只能是哈希或什么都没有。
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { callVideo, makeFixture, handedOff, seedAccepted, writePng } from "./handoff-testkit.js";
import { contentFile, initializeProjectLayout, resolveContentProject } from "../../../storage/content-project.js";
import { getContent } from "../../../storage/local-store.js";
import { assertClaimToken, claimContent, ensureClaim, migratePlaintextClaims } from "../../../storage/claims.js";
import { hashClaimToken } from "../../../storage/claim-token.js";

let env: Awaited<ReturnType<typeof makeFixture>>;
beforeEach(async () => { env = await makeFixture(); await fs.unlink(path.join(env.dir, "video.json")); await initializeProjectLayout(env.dir, "lib-deadbeef", "default"); });
afterEach(async () => { await env.cleanup(); });

async function filesContaining(root: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const rel of await fs.readdir(root, { recursive: true })) {
    const file = path.join(root, String(rel));
    if (!(await fs.stat(file)).isFile()) continue;
    if ((await fs.readFile(file)).includes(Buffer.from(needle))) hits.push(String(rel));
  }
  return hits;
}

it("写手令牌和交接签给 Codex 的令牌都不出现在项目文件夹的任何文件里；持有者照样能写", async () => {
  const seeded = await seedAccepted(env.dir);
  const writer = await claimContent(seeded.id, "writer", "claude-code", env.dir);
  if (!writer.ok) throw new Error(writer.error);
  const root = resolveContentProject(seeded.id, env.dir)!.project_root;
  expect(await filesContaining(root, writer.claim.token)).toEqual([]);
  expect((await getContent(seeded.id, env.dir))?.claim?.token).toBe(hashClaimToken(writer.claim.token));

  const v = await handedOff(env.dir, env.aroll);
  const cover = await writePng(path.join(v.root, "05-cover/v01/3x4.png"), "c");
  expect((await v.report([{ file: cover, role: "cover:3:4", version: 1 }])).ok).toBe(true);
  expect(await filesContaining(v.root, v.token)).toEqual([]);
  expect(await fs.readFile(contentFile(v.id, env.dir, "meta.json"), "utf8")).toContain("sha256:");
  // 别人拿记录里的哈希当令牌过不了门
  const hashed = (await getContent(v.id, env.dir))!.claim!.token;
  expect(await callVideo(env.dir, { action: "report", content_id: v.id, claim_token: hashed, _session: "x", report: {} }, "codex")).toMatchObject({ ok: false });
});

it("旧格式记录（明文令牌）照样认；启动迁移后文件里只剩哈希，持有者还能写", async () => {
  const seeded = await seedAccepted(env.dir);
  const writer = await claimContent(seeded.id, "writer", "claude-code", env.dir);
  if (!writer.ok) throw new Error(writer.error);
  const meta = contentFile(seeded.id, env.dir, "meta.json");
  const raw = JSON.parse(await fs.readFile(meta, "utf8"));
  const legacy = "clm-1700000000000-legacy01";
  raw.claim.token = legacy;
  await fs.writeFile(meta, JSON.stringify(raw));

  // 迁移前：明文记录照样认（比较层兼容旧格式）
  expect(assertClaimToken({ claim: raw.claim }, "claude-code", legacy)).toEqual({ ok: true });
  expect(await migratePlaintextClaims(env.dir)).toBe(1);
  expect(await fs.readFile(meta, "utf8")).not.toContain(legacy);
  expect(await migratePlaintextClaims(env.dir)).toBe(0);
  const write = await ensureClaim(seeded.id, { host: "claude-code", token: legacy }, env.dir);
  expect(write.ok).toBe(true);
  if (write.ok) expect(write.claim.token).toBe(legacy);
  expect(await ensureClaim(seeded.id, { host: "claude-code" }, env.dir)).toMatchObject({ ok: false, code: "claim_held" });
});
