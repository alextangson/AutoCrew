/** Codex 审 segB4 + 隐式 ChatCut 引用守卫：终态失败落到事实、导出目录与监视文件夹重叠、rejected 重放、ChatCut 在用的原片不挪 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { Fact } from "../../storage/production-types.js";
import { founderDecision } from "./decisions.js";
import { setMatchDeps } from "./match/deps.js";
import { kickMatchWorker, matchWorkerIdle, MAX_RETRIES, RETRY_DELAY_MS } from "./match/queue.js";
import { synth } from "./match/synth-fixture.js";
import { reconcileAll } from "./reconcile.js";
import { setProductionDeps } from "./roots.js";
import { setChatcutDeps } from "./sliver/chatcut-read.js";
import { exists, founderApprove, makeEnv, projectRoot, put, record, videoContent, type Env } from "./testkit.js";

let env: Env;
let clock: number;
let cc: string;
beforeEach(async () => {
  env = await makeEnv({ enabled: true });
  clock = Date.now();
  cc = path.join(path.dirname(env.dir), "chatcut-projects");
  setChatcutDeps({ projectsRoot: () => cc });
});
afterEach(async () => { await matchWorkerIdle(env.dir); setChatcutDeps(null); await env.cleanup(); });

const A = synth(41, 500);
async function aroll(id: string): Promise<Fact | undefined> {
  const d = await readProductionDocOrEmpty(id, env.dir);
  return d.facts.find((f) => f.kind === "aroll" && f.round === d.round);
}
async function ccProject(name: string, files: string[]): Promise<void> {
  const dir = path.join(cc, `p-${name.length}`, "project.chatcutproject");
  await fs.mkdir(path.join(dir, "assets", "video"), { recursive: true });
  await fs.writeFile(path.join(dir, "project.json"), JSON.stringify({ name, projectId: "p1", schemaVersion: 4 }));
  for (const [i, f] of files.entries()) await fs.writeFile(path.join(dir, "assets", "video", `a${i}.json`), JSON.stringify({ id: `a${i}`, type: "video", path: f }));
}

describe("[P2] 终态失败要落到事实上", () => {
  it("record 的核对作业重试到头还失败 → pending_match 转候选并写原因，不再永远「正在核对」", async () => {
    setMatchDeps({ now: () => clock, thresholds: { calibrated: true, floor: 0.3, margin: 0.2 },
      transcriber: { notReady: async () => null, transcribe: async () => ({ ok: true, text: A.slice(10, 150) }) } });
    const cache = path.join(env.dir, "cache", "aroll-transcripts");
    await fs.mkdir(cache, { recursive: true });
    await fs.chmod(cache, 0o555); // 转写缓存写不了：作业抛错 → 退避重试 → 到头
    try {
      const a = await videoContent(env, "终态失败测试稿", "draft_ready", A);
      await record(env, { content_id: a.id, kind: "aroll", path: await put(path.join(env.inbox, "IMG_z.mov"), "z"), request_id: "r1" });
      await matchWorkerIdle(env.dir);
      for (let i = 0; i < MAX_RETRIES; i++) { clock += RETRY_DELAY_MS; kickMatchWorker(env.dir); await matchWorkerIdle(env.dir); }
      const f = await aroll(a.id);
      expect(f?.state).toBe("candidate");
      expect(f?.evidence).toContain("核对没做成");
    } finally { await fs.chmod(cache, 0o755); }
  });

  it("卡片挂载核对重试到头还失败 → 核对状态转 failed 并写原因", async () => {
    setMatchDeps({ now: () => clock, transcriber: { notReady: async () => null, transcribe: async () => ({ ok: true, text: A.slice(10, 150) }) } });
    const cache = path.join(env.dir, "cache", "aroll-transcripts");
    await fs.mkdir(cache, { recursive: true });
    await fs.chmod(cache, 0o555);
    try {
      const a = await videoContent(env, "挂载失败测试稿", "draft_ready", A);
      await founderApprove(env, a.id);
      await founderDecision(a.id, "attach_aroll", { path: await put(path.join(env.outside, "m.mov"), "m") }, env.dir);
      await matchWorkerIdle(env.dir);
      for (let i = 0; i < MAX_RETRIES; i++) { clock += RETRY_DELAY_MS; kickMatchWorker(env.dir); await matchWorkerIdle(env.dir); }
      expect((await aroll(a.id))?.attach_check).toMatchObject({ status: "failed", reason: expect.stringContaining("核对没做成") });
    } finally { await fs.chmod(cache, 0o755); }
  });
});

describe("[P2] 导出目录同时是监视文件夹：权限取并集", () => {
  it("成片仍按导出目录克隆收下，不降成候选", async () => {
    setProductionDeps({ roots: async () => ({ inbox: env.inbox, chatcut: env.chatcut, jianying: env.jianying, watch: [env.chatcut] }) });
    const c = await videoContent(env, "重叠目录测试稿");
    const r = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "重叠目录测试稿.mp4"), "cut"), request_id: "r1" });
    expect(r).toMatchObject({ ok: true, state: "accepted" });
  });
});

describe("[P2] rejected 的重放不再说「导入 ChatCut」", () => {
  it("核对期间文件变了 → rejected；同一 request_id 重放给原因和「换一个文件重新 record」", async () => {
    const src = await put(path.join(env.inbox, "IMG_r.mov"), "r");
    setMatchDeps({ thresholds: { calibrated: true, floor: 0.3, margin: 0.2 }, transcriber: { notReady: async () => null, transcribe: async () => {
      await fs.writeFile(src, "changed"); const t = new Date(Date.now() - 60_000); await fs.utimes(src, t, t); return { ok: true, text: A.slice(10, 150) }; } } });
    const a = await videoContent(env, "重放测试稿", "draft_ready", A);
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    await matchWorkerIdle(env.dir);
    const r = await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    expect(r).toMatchObject({ state: "rejected" });
    expect(String(r.next_action)).toContain("换一个文件重新 record");
    expect(String(r.next_action)).not.toContain("导入 ChatCut");
  });
});

describe("守卫：本机 ChatCut 工程按绝对路径在用的原片不挪（§13-A）", () => {
  const TITLE = "ChatCut在用的原片稿";
  it("record：收件箱里名字对上，但 ChatCut 工程在用 → accepted 留在原处，依据写出工程名", async () => {
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.inbox, `${TITLE}-原片.mov`), "in-use");
    await ccProject("旧剪辑工程", [src]);
    const r = await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" });
    expect(r).toMatchObject({ ok: true, state: "accepted", path: src });
    expect(await exists(src)).toBe(true);
    expect((await aroll(c.id))?.evidence).toContain("ChatCut 工程《旧剪辑工程》在用这个文件，留在原处不挪");
  });

  it("卡片挂载 / 确认候选：同样留原处", async () => {
    const c = await videoContent(env, TITLE);
    await founderApprove(env, c.id);
    const src = await put(path.join(env.outside, "downloads-take.mov"), "dl");
    await ccProject("下载里那条", [src]);
    expect(await founderDecision(c.id, "attach_aroll", { path: src }, env.dir)).toMatchObject({ ok: true, state: "accepted" });
    expect(await exists(src)).toBe(true);
  });

  it("收件箱自动挪：ChatCut 在用 → 不挪，原地收下", async () => {
    setMatchDeps({ transcriber: { notReady: async () => "测试", transcribe: async () => ({ ok: true, text: "" }) } });
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.inbox, `${TITLE}-原片.mov`), "auto");
    await ccProject("自动挪工程", [src]);
    await reconcileAll(env.dir);
    expect(await exists(src)).toBe(true);
    expect(await aroll(c.id)).toMatchObject({ state: "accepted", path: src });
  });

  it("ChatCut 工程目录读不了 → 不挡搬运，照常挪，但依据里写出没读到", async () => {
    await fs.mkdir(cc, { recursive: true });
    await fs.chmod(cc, 0o000);
    try {
      const c = await videoContent(env, TITLE);
      const src = await put(path.join(env.inbox, `${TITLE}-原片.mov`), "move-me");
      const r = await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" });
      expect(r).toMatchObject({ ok: true, state: "accepted", path: `02-aroll/${TITLE}-原片.mov` });
      expect((await aroll(c.id))?.evidence).toContain("没读到 ChatCut 工程目录");
    } finally { await fs.chmod(cc, 0o755); }
  });

  it("没装 ChatCut（目录不存在）是正常情况：照常挪，不提示", async () => {
    const c = await videoContent(env, TITLE);
    const src = await put(path.join(env.inbox, `${TITLE}-原片.mov`), "x");
    expect(await record(env, { content_id: c.id, kind: "aroll", path: src, request_id: "r1" })).toMatchObject({ state: "accepted", path: `02-aroll/${TITLE}-原片.mov` });
    expect((await aroll(c.id))?.evidence).not.toContain("ChatCut");
    expect(await exists(path.join(projectRoot(env, c.id), `02-aroll/${TITLE}-原片.mov`))).toBe(true);
  });
});
