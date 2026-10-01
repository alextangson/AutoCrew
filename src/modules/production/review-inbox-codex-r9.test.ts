/**
 * 整分支审 9：转写缓存只认真算出来的 sha；一对封面第二张失败后，同一 request_id 重试接着补完同一组。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readProductionDoc } from "../../storage/production-store.js";
import { validCoverGroups } from "./cover-groups.js";
import { hear } from "./match/hear.js";
import { readTranscript } from "./match/cache.js";
import { setMatchDeps } from "./match/deps.js";
import type { MatchJob } from "./match/queue.js";
import { founderApprove, makeEnv, png, put, record, videoContent, type Env } from "./testkit.js";

const clone = vi.hoisted(() => ({ failOn: 0, calls: 0 }));
vi.mock("./files.js", async (orig) => {
  const m = await orig<typeof import("./files.js")>();
  return { ...m, cloneInto: async (...args: Parameters<typeof m.cloneInto>) => {
    clone.calls += 1;
    if (clone.calls === clone.failOn) throw new Error("注入：第二张拷贝失败");
    return m.cloneInto(...args);
  } };
});

describe("P2 转写缓存不能记在别的字节名下", () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "hear-r9-")); });
  afterEach(async () => { setMatchDeps(null); await fs.rm(dir, { recursive: true, force: true }); });

  it("转写期间被换成同样大、修改时间不变的另一份 → 不进缓存", async () => {
    const file = path.join(dir, "a.mov");
    await fs.writeFile(file, "AAAA");
    const st = await fs.stat(file);
    const sha = crypto.createHash("sha256").update("AAAA").digest("hex");
    setMatchDeps({ transcriber: { transcribe: async (p: string) => {
      await fs.writeFile(p, "BBBB");
      await fs.utimes(p, st.atime, st.mtime);
      return { ok: true as const, text: "别的字节的话" };
    } } as never });
    const job = { sha256: sha, path: file, size: st.size, mtime_ms: Math.trunc(st.mtimeMs) } as MatchJob;
    const out = await hear(dir, job, new AbortController().signal);
    expect(out.uncached).toBe(true);
    expect(await readTranscript(dir, sha)).toBeFalsy();
  });
});

describe("P2 一对封面只记上一半，同一 request_id 重试补完同一组", () => {
  let env: Env;
  beforeEach(async () => { env = await makeEnv({ enabled: true }); clone.calls = 0; clone.failOn = 0; });
  afterEach(async () => { await env.cleanup(); });

  for (const version of [undefined, 3]) {
    it(`第二张失败 → 重试成一个完整组（version=${version ?? "无"}）`, async () => {
      const c = await videoContent(env, "封面半组重试");
      await founderApprove(env, c.id);
      const a = await put(path.join(env.chatcut, "a.png"), png(900, 1200, "a"));
      const b = await put(path.join(env.chatcut, "b.png"), png(1200, 900, "b"));
      const args = { content_id: c.id, kind: "cover", paths: [a, b], cover_text: "字", request_id: "half", ...(version ? { version } : {}) };
      clone.failOn = 2;
      const first = await record(env, args);
      expect(first.ok).toBe(false);
      expect(clone.calls).toBe(2);
      clone.failOn = 0;
      const retry = await record(env, args);
      expect(retry).toMatchObject({ ok: true });
      expect(retry.group_id).toBeTruthy();
      const groups = validCoverGroups((await readProductionDoc(c.id, env.dir))!);
      expect(groups).toHaveLength(1);
      expect(groups[0].complete).toBe(true);
    });
  }
});
