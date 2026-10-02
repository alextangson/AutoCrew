/**
 * 整分支审 16 P2：「等你拍板」故意不列的候选（发布后的新导出等）在卡片上能直接定；新鲜度照核。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import path from "node:path";
import type { Fact } from "../../storage/production-types.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { decide } from "./inbox-decide.js";
import { readInbox } from "./inbox-read.js";
import { mutateProduction } from "./service.js";
import { withFileOwnership } from "./mutex.js";
import { cardPanel } from "./panel.js";
import { exists, founderApprove, makeEnv, put, record, setContent, videoContent, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

let last = "";
async function postPublishCandidate() {
  const c = await videoContent(env, "发布后再导出");
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "发布后再导出-原片.mov"), "raw"), request_id: "a" });
  const file = await put(path.join(env.chatcut, "发布后再导出-重导.mp4"), "re-export");
  last = file;
  const sha = crypto.createHash("sha256").update("re-export").digest("hex");
  await withFileOwnership(() => mutateProduction(c.id, env.dir, (d) => {
    d.facts.push({ id: "fact-pp1", kind: "cut", round: d.round, state: "candidate", availability: "present", source: "reconcile", at: new Date().toISOString(), path: file, sha256: sha, size: 9, mtime_ms: 1, evidence: "x", post_publish: true } as Fact);
    return { value: null, events: [] };
  }));
  return { c, sha };
}

describe("列表不列的候选", () => {
  it("卡片标它不在列表里；按 fact + sha 能确认 / 否认，sha 不对照样拒", async () => {
    const { c, sha } = await postPublishCandidate();
    expect((await readInbox(env.dir, { contentId: c.id })).items.filter((i) => i.type === "candidate")).toEqual([]);
    const panel = await cardPanel(c.id, env.dir) as { candidate_rows: Array<{ fact_id: string; in_inbox?: boolean }> };
    expect(panel.candidate_rows.find((r) => r.fact_id === "fact-pp1")).toMatchObject({ in_inbox: false });
    expect(await decide(c.id, "reject_candidate", { fact_id: "fact-pp1", sha256: "0".repeat(64) }, env.dir)).toMatchObject({ ok: false, code: "stale" });
    expect(await decide(c.id, "reject_candidate", { fact_id: "fact-pp1", sha256: sha }, env.dir)).toMatchObject({ ok: true });
    expect((await readProductionDoc(c.id, env.dir))!.facts.find((f) => f.id === "fact-pp1")!.state).toBe("rejected");
  });
});

describe("整分支审 17：归档的稿不放行", () => {
  it("找到候选后稿被归档 → 确认回 stale，文件不动", async () => {
    const { c, sha } = await postPublishCandidate();
    await setContent(env, c.id, { status: "archived" });
    expect(await decide(c.id, "confirm_candidate", { fact_id: "fact-pp1", sha256: sha }, env.dir)).toMatchObject({ ok: false, code: "stale" });
    expect(await exists(last)).toBe(true);
    expect((await readProductionDoc(c.id, env.dir))!.facts.find((f) => f.id === "fact-pp1")!.state).toBe("candidate");
  });
});
