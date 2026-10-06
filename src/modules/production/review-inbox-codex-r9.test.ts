/**
 * 整分支审 9：一对封面第二张失败后，同一 request_id 重试接着补完同一组。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { readProductionDoc, writeProductionDoc } from "../../storage/production-store.js";
import { validCoverGroups } from "./cover-groups.js";
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

describe("整分支审 14：半组续记的两个洞", () => {
  let env: Env;
  beforeEach(async () => { env = await makeEnv({ enabled: true }); clone.calls = 0; clone.failOn = 0; });
  afterEach(async () => { await env.cleanup(); });

  async function half(version?: number) {
    const c = await videoContent(env, "封面续记核参");
    await founderApprove(env, c.id);
    const a = await put(path.join(env.chatcut, "a.png"), png(900, 1200, "a"));
    const b = await put(path.join(env.chatcut, "b.png"), png(1200, 900, "b"));
    const args = { content_id: c.id, kind: "cover", paths: [a, b], cover_text: "字", request_id: "half", ...(version ? { version } : {}) };
    return { c, args };
  }

  it("同一 request_id 换了 version 重试 → request_conflict，不混组", async () => {
    const { c, args } = await half(3);
    clone.failOn = 2;
    expect((await record(env, args)).ok).toBe(false);
    clone.failOn = 0;
    expect(await record(env, { ...args, version: 4 })).toMatchObject({ ok: false, code: "request_conflict" });
    expect(validCoverGroups((await readProductionDoc(c.id, env.dir))!).filter((g) => g.complete)).toHaveLength(0);
  });

  it("两张都记上、整对回执没写上（中断）→ 重试回的是那一组，不是「只记成了候选」", async () => {
    const { c, args } = await half();
    expect(await record(env, args)).toMatchObject({ ok: true });
    const d = (await readProductionDoc(c.id, env.dir))!;
    delete d.requests!.half;
    await writeProductionDoc(c.id, env.dir, d, d.revision);
    const again = await record(env, args);
    expect(again.group_id).toBeTruthy();
    expect(String(again.next_action)).toContain("这一组封面已记下");
    expect(((await readProductionDoc(c.id, env.dir))!.requests!["half#1"].receipt as { group_id?: string }).group_id).toBeTruthy();
  });
});
