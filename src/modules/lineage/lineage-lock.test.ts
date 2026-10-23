/** 跨进程：只有持有资料库写入占用的服务能建派生稿；没占用就拒，说清原因（Codex 审 Phase 1 P2-3） */
import { afterEach, describe, expect, it, vi } from "vitest";

const writable = vi.hoisted(() => ({ fail: false }));
vi.mock("../../storage/storage-roots.js", async (orig) => {
  const real = await orig<typeof import("../../storage/storage-roots.js")>();
  return { ...real, assertDataDirWritable: (d?: string) => { if (writable.fail) throw new Error("library_writer_lost: 当前服务已失去资料库写入权；不会自动抢占。"); return real.assertDataDirWritable(d); } };
});

import { listContents } from "../../storage/local-store.js";
import { makeEnv, setContent, videoContent, type Env } from "../production/testkit.js";
import { initProfile, updateProfile } from "../profile/creator-profile.js";
import { deriveSibling } from "./lineage.js";

let env: Env;
afterEach(async () => { writable.fail = false; await env.cleanup(); });

describe("资料库写入占用", () => {
  it("当前进程不是写入方：拒绝派生，不落盘", async () => {
    env = await makeEnv();
    await initProfile(env.dir);
    await updateProfile({ platforms: ["douyin", "wechat_mp"] }, env.dir);
    const c = await videoContent(env, "源");
    await setContent(env, c.id, { videoDone: { renderedRevision: 1, at: new Date().toISOString() } });
    writable.fail = true;
    const r = await deriveSibling(c.id, "wechat_article", env.dir);
    expect(r).toMatchObject({ ok: false, code: "library_not_writable" });
    expect(!r.ok && r.error).toMatch(/写入权/);
    expect((await listContents(env.dir)).filter((x) => x.derivedFrom)).toHaveLength(0);
  });
});
