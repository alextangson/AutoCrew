/**
 * agent 报原片的后台核对（1b §3，B1–B6、B25–B28、§3-9 锁上下文）。注入假转写器；正文是合成的无意义字串。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProductionDocOrEmpty } from "../../storage/production-store.js";
import type { Fact } from "../../storage/production-types.js";
import { holdsFileOwnership, withFileOwnership } from "./mutex.js";
import { founderDecision } from "./decisions.js";
import { reopenScript } from "./reopen.js";
import { ensureProductionReady, resetProductionReady } from "./service.js";
import { setMatchDeps } from "./match/deps.js";
import { listMatchJobs, matchWorkerIdle, resetMatchQueue } from "./match/queue.js";
import type { TranscribeOutcome } from "./match/transcribe.js";
import { synth } from "./match/synth-fixture.js";
import { exists, founderApprove, makeEnv, projectRoot, put, record, setContent, videoContent, type Env } from "./testkit.js";
import { softDeleteContent } from "../../storage/local-store.js";

let env: Env;
let calls: string[];
beforeEach(async () => { env = await makeEnv({ enabled: true }); calls = []; });
afterEach(async () => { await matchWorkerIdle(env.dir); await env.cleanup(); });

const CAL = { calibrated: true, floor: 0.5, margin: 0.15 };
const BODY_A = synth(1, 500), BODY_B = synth(2, 500);

function fakeAsr(answer: (file: string) => Promise<TranscribeOutcome> | TranscribeOutcome, opts: { calibrated?: boolean } = {}): void {
  setMatchDeps({
    thresholds: opts.calibrated === false ? { ...CAL, calibrated: false } : CAL,
    transcriber: { notReady: async () => null, transcribe: async (file) => { calls.push(file); return answer(file); } },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((r) => { resolve = r; }), resolve };
}

async function arollFact(id: string): Promise<Fact | undefined> {
  const doc = await readProductionDocOrEmpty(id, env.dir);
  return doc.facts.find((f) => f.kind === "aroll" && f.round === doc.round);
}

async function setup(): Promise<{ a: { id: string; title: string }; b: { id: string; title: string }; src: string }> {
  const a = await videoContent(env, "甲稿讲的是一件事", "draft_ready", BODY_A);
  const b = await videoContent(env, "乙稿讲的完全是另一件事", "draft_ready", BODY_B);
  const src = await put(path.join(env.inbox, "IMG_0042.mov"), "aroll-bytes-1");
  return { a, b, src };
}

describe("pending_match：agent 报名字对不上的收件箱原片（§3）", () => {
  it("开头转写对上目标稿 → 自动 accepted、挪进项目改名、标 auto_attached；回执先说正在核对", async () => {
    fakeAsr(() => ({ ok: true, text: BODY_A.slice(30, 160) }));
    const { a, src } = await setup();
    const r = await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    expect(r).toMatchObject({ ok: true, state: "pending_match" });
    expect(String(r.next_action)).toContain("正在核对这段原片是不是这条");
    await matchWorkerIdle(env.dir);
    const f = await arollFact(a.id);
    expect(f).toMatchObject({ state: "accepted", path: "02-aroll/甲稿讲的是一件事-原片.mov", auto_attached: true, source_path: src });
    expect(await exists(src)).toBe(false);
    expect(await exists(path.join(projectRoot(env, a.id), "02-aroll/甲稿讲的是一件事-原片.mov"))).toBe(true);
    // request_id 重放拿到的是落定后的状态
    expect(await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" })).toMatchObject({ ok: true, state: "accepted", replayed: true });
  });

  it("没校准（默认）→ 不自动认，转候选，依据写前三名（B17）", async () => {
    fakeAsr(() => ({ ok: true, text: BODY_A.slice(30, 160) }), { calibrated: false });
    const { a, src } = await setup();
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    await matchWorkerIdle(env.dir);
    const f = await arollFact(a.id);
    expect(f?.state).toBe("candidate");
    expect(f?.evidence).toContain("没校准");
    expect(f?.evidence).toContain("前三名");
    expect(f?.match?.top3[0].content_id).toBe(a.id);
    expect(await exists(src)).toBe(true);
  });

  it("转写更像别条 → 候选，不挪", async () => {
    fakeAsr(() => ({ ok: true, text: BODY_B.slice(30, 160) }));
    const { a, src } = await setup();
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    await matchWorkerIdle(env.dir);
    expect(await arollFact(a.id)).toMatchObject({ state: "candidate" });
    expect(await exists(src)).toBe(true);
  });

  it("转写没就绪 → 直接候选并写原因，不入队（B1）", async () => {
    setMatchDeps({ transcriber: { notReady: async () => "ASR 依赖环境还没装好", transcribe: async () => { throw new Error("不该调"); } } });
    const { a, src } = await setup();
    const r = await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    expect(r).toMatchObject({ ok: true, state: "candidate" });
    expect(String(r.reason)).toContain("转写环境没装好");
    expect(await listMatchJobs(env.dir)).toHaveLength(0);
  });

  it("转写失败 → 候选 + 原因，不静默（B2）", async () => {
    fakeAsr(() => ({ ok: false, unavailable: false, reason: "sidecar 退出码 1" }));
    const { a, src } = await setup();
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    await matchWorkerIdle(env.dir);
    const f = await arollFact(a.id);
    expect(f?.state).toBe("candidate");
    expect(f?.evidence).toContain("转写失败：sidecar 退出码 1");
  });

  it("核对期间文件变了 → rejected + 原因，不搬（B3）", async () => {
    const { a, src } = await setup();
    fakeAsr(async () => {
      await fs.writeFile(src, "changed-bytes!");
      const t = new Date(Date.now() - 60_000);
      await fs.utimes(src, t, t);
      return { ok: true, text: BODY_A.slice(30, 160) };
    });
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    await matchWorkerIdle(env.dir);
    expect(await arollFact(a.id)).toMatchObject({ state: "rejected", evidence: "核对期间文件变了，没挪" });
    expect(await exists(src)).toBe(true);
  });

  it("核对期间文件不见了 → rejected（B3）", async () => {
    const { a, src } = await setup();
    fakeAsr(async () => { await fs.rm(src); return { ok: true, text: BODY_A.slice(30, 160) }; });
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    await matchWorkerIdle(env.dir);
    expect(await arollFact(a.id)).toMatchObject({ state: "rejected", evidence: "核对期间文件不见了，没挪" });
  });

  it("同一文件同一条重复 record：返回当前状态，不另起作业；换个 request_id 也一样（§3-7）", async () => {
    const gate = deferred();
    fakeAsr(async () => { await gate.promise; return { ok: true, text: BODY_A.slice(30, 160) }; });
    const { a, src } = await setup();
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    expect(await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r2" })).toMatchObject({ ok: true, state: "pending_match" });
    gate.resolve();
    await matchWorkerIdle(env.dir);
    expect(calls).toHaveLength(1);
    expect((await listMatchJobs(env.dir)).length).toBe(1);
  });

  it("r1、r2 两个请求号报同一文件：核对落定后两个重放都回当前状态与新路径（Codex 审 segA P2）", async () => {
    const gate = deferred();
    fakeAsr(async () => { await gate.promise; return { ok: true, text: BODY_A.slice(30, 160) }; });
    const { a, src } = await setup();
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r2" });
    gate.resolve();
    await matchWorkerIdle(env.dir);
    for (const rid of ["r1", "r2"]) {
      expect(await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: rid })).toMatchObject({ ok: true, state: "accepted", replayed: true, path: "02-aroll/甲稿讲的是一件事-原片.mov" });
    }
  });

  it("转写按完整 sha 缓存：同一份字节只转写一次（B34）", async () => {
    fakeAsr(() => ({ ok: true, text: BODY_B.slice(30, 160) }));
    const { a, src } = await setup();
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    await matchWorkerIdle(env.dir);
    const other = await put(path.join(env.inbox, "copy.mov"), "aroll-bytes-1");
    await founderDecision(a.id, "reject_candidate", { fact_id: (await arollFact(a.id))!.id, sha256: (await arollFact(a.id))!.sha256 }, env.dir);
    const c = await videoContent(env, "丙稿", "draft_ready", synth(3, 500));
    await record(env, { content_id: c.id, kind: "aroll", path: other, request_id: "r2" });
    await matchWorkerIdle(env.dir);
    expect(calls).toHaveLength(1);
    expect(await arollFact(c.id)).toMatchObject({ state: "candidate" });
  });
});

describe("pending 预留与迟到结果（B5、B6、B25、B26、B27、B28）", () => {
  it("别条稿 record 同一文件 → 拒 aroll_pending_elsewhere，说是哪条（B6）", async () => {
    const gate = deferred();
    fakeAsr(async () => { await gate.promise; return { ok: true, text: BODY_A.slice(30, 160) }; });
    const { a, b, src } = await setup();
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    const r = await record(env, { content_id: b.id, kind: "aroll", path: src, request_id: "r2" });
    expect(r).toMatchObject({ ok: false, code: "aroll_pending_elsewhere" });
    expect(String(r.error)).toContain(a.title);
    gate.resolve();
  });

  it("创始人在别条卡片挂同一文件：先提示，确认后取消这边的核对再挂（B28）", async () => {
    const gate = deferred();
    fakeAsr(async () => { await gate.promise; return { ok: true, text: BODY_A.slice(30, 160) }; });
    const { a, b, src } = await setup();
    await founderApprove(env, b.id);
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    const first = await founderDecision(b.id, "attach_aroll", { path: src }, env.dir);
    expect(first).toMatchObject({ ok: false, code: "aroll_pending_elsewhere" });
    const second = await founderDecision(b.id, "attach_aroll", { path: src, cancel_pending: true }, env.dir);
    expect(second).toMatchObject({ ok: true, state: "accepted" });
    expect(await arollFact(a.id)).toMatchObject({ state: "rejected", evidence: `创始人挂到了《${b.title}》` });
    gate.resolve();
    await matchWorkerIdle(env.dir);
    expect(await arollFact(a.id)).toMatchObject({ state: "rejected" });
    expect(await arollFact(b.id)).toMatchObject({ state: "accepted" });
  });

  it("结果迟到、创始人已点过「不是这条」→ 作废无副作用（B25）", async () => {
    const gate = deferred();
    fakeAsr(async () => { await gate.promise; return { ok: true, text: BODY_A.slice(30, 160) }; });
    const { a, src } = await setup();
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    const f = (await arollFact(a.id))!;
    expect(await founderDecision(a.id, "reject_candidate", { fact_id: f.id, sha256: f.sha256 }, env.dir)).toMatchObject({ ok: true });
    gate.resolve();
    await matchWorkerIdle(env.dir);
    expect(await arollFact(a.id)).toMatchObject({ state: "rejected" });
    expect(await exists(src)).toBe(true);
    expect((await listMatchJobs(env.dir))[0].state).toBe("cancelled");
  });

  it("核对期间池变了（新来一条正文一样的稿）→ 用缓存转写重新打分，不用旧 winner（B26）", async () => {
    const gate = deferred();
    fakeAsr(async () => { await gate.promise; return { ok: true, text: BODY_A.slice(30, 160) }; });
    const { a, src } = await setup();
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    await videoContent(env, "甲稿的双胞胎", "draft_ready", BODY_A);
    gate.resolve();
    await matchWorkerIdle(env.dir);
    const f = await arollFact(a.id);
    expect(f?.state).toBe("candidate");
    expect(f?.evidence).toContain("分不开");
    expect(calls).toHaveLength(1);
  });

  it("核对期间原片被 ChatCut 工程引用 → 不搬，转候选并写原因（B27）", async () => {
    const gate = deferred();
    fakeAsr(async () => { await gate.promise; return { ok: true, text: BODY_A.slice(30, 160) }; });
    const { a, src } = await setup();
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    const f = (await arollFact(a.id))!;
    expect(await record(env, { content_id: a.id, kind: "chatcut_project", chatcut_project_id: "p1", uses_aroll: [f.id], request_id: "r2" })).toMatchObject({ ok: true });
    gate.resolve();
    await matchWorkerIdle(env.dir);
    expect(await arollFact(a.id)).toMatchObject({ state: "candidate" });
    expect((await arollFact(a.id))?.evidence).toContain("ChatCut");
    expect(await exists(src)).toBe(true);
  });

  it("核对中稿被重开文稿 → 丢弃作业、不搬，事实留在上一轮（B5）", async () => {
    const gate = deferred();
    fakeAsr(async () => { await gate.promise; return { ok: true, text: BODY_A.slice(30, 160) }; });
    const { a, src } = await setup();
    await founderApprove(env, a.id);
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    expect(await reopenScript(a.id, env.dir)).toMatchObject({ ok: true, round: 2 });
    gate.resolve();
    await matchWorkerIdle(env.dir);
    const doc = await readProductionDocOrEmpty(a.id, env.dir);
    expect(doc.facts.find((f) => f.kind === "aroll")).toMatchObject({ round: 1, state: "pending_match" });
    expect(await exists(src)).toBe(true);
    expect((await listMatchJobs(env.dir))[0]).toMatchObject({ state: "cancelled" });
  });
});

describe("工人不继承锁上下文，落结果与 record / 重开互斥（§3-9）", () => {
  async function pendingWithGate(): Promise<{ a: { id: string; title: string }; src: string; asrGate: ReturnType<typeof deferred>; asrStarted: ReturnType<typeof deferred>; held: () => boolean | null }> {
    const asrGate = deferred(), asrStarted = deferred();
    let heldDuringAsr: boolean | null = null;
    fakeAsr(async () => { heldDuringAsr = holdsFileOwnership(); asrStarted.resolve(); await asrGate.promise; return { ok: true, text: BODY_A.slice(30, 160) }; });
    const { a, src } = await setup();
    await founderApprove(env, a.id);
    // record 在归属锁里入队、叫醒工人：工人必须在干净的上下文里起
    expect(await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" })).toMatchObject({ state: "pending_match" });
    await asrStarted.promise;
    return { a, src, asrGate, asrStarted, held: () => heldDuringAsr };
  }

  it("转写不持锁；落结果排在别人持有的归属锁后面，不当成重入直接写", async () => {
    const { a, asrGate, held } = await pendingWithGate();
    expect(held()).toBe(false);
    await withFileOwnership(async () => {
      asrGate.resolve();
      await new Promise((r) => setTimeout(r, 50));
      expect(await arollFact(a.id)).toMatchObject({ state: "pending_match" });
    });
    await matchWorkerIdle(env.dir);
    expect(await arollFact(a.id)).toMatchObject({ state: "accepted" });
  });

  it("并发的 record 持锁时工人等它；并发的重开文稿先落 → 工人落结果时看到新一轮、作废不搬", async () => {
    const { a, src, asrGate } = await pendingWithGate();
    const other = await put(path.join(env.inbox, "甲稿讲的是一件事.mov"), "another-take");
    await withFileOwnership(async () => {
      asrGate.resolve();
      await new Promise((r) => setTimeout(r, 30));
      // 同一把锁里（可重入）先 record 另一段、再重开文稿：工人一直等着
      expect(await record(env, { content_id: a.id, kind: "aroll", path: other, request_id: "r2" })).toMatchObject({ ok: true, state: "accepted" });
      expect(await reopenScript(a.id, env.dir)).toMatchObject({ ok: true, round: 2 });
    });
    await matchWorkerIdle(env.dir);
    expect(await exists(src)).toBe(true);
    const doc = await readProductionDocOrEmpty(a.id, env.dir);
    expect(doc.facts.find((f) => f.request_id === "r1")).toMatchObject({ round: 1, state: "pending_match" });
  });
});

describe("服务重启：本轮 pending_match 重新入队（B4）", () => {
  it("内存队列丢了、盘上作业还在跑到一半 → 就绪时重新排上并跑完", async () => {
    const started = deferred();
    // 旧进程的转写永远回不来（进程被杀）
    fakeAsr(async () => { started.resolve(); return new Promise<TranscribeOutcome>(() => undefined); });
    const { a, src } = await setup();
    await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
    await started.promise;
    // 模拟重启：丢掉内存队列与「已就绪」，并把队列文件删掉（最坏情况：作业记录也没了）
    resetMatchQueue();
    resetProductionReady();
    await fs.rm(path.join(env.dir, "cache", "match-jobs.json"), { force: true });
    fakeAsr(() => ({ ok: true, text: BODY_A.slice(30, 160) }));
    await ensureProductionReady(env.dir);
    await matchWorkerIdle(env.dir);
    expect(await arollFact(a.id)).toMatchObject({ state: "accepted", auto_attached: true });
  });
});

describe("启动唤醒持久队列（Codex 审 segB P2）", () => {
  it("盘上排着的作业（没有新入队）在就绪时就被叫醒跑完", async () => {
    fakeAsr(() => ({ ok: true, text: "开头" }));
    const src = await put(path.join(env.outside, "q.mov"), "q");
    const st = await fs.stat(src);
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update("q").digest("hex");
    const file = path.join(env.dir, "cache", "match-jobs.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 1, jobs: [{ id: "mjob-boot", key: `${sha}|transcribe_head|head`, purpose: "transcribe_head", priority: "background", sha256: sha, path: src,
      size: st.size, mtime_ms: Math.trunc(st.mtimeMs), target: "head", payload: {}, state: "running", attempts: 0, next_at: 0, created_at: "t", updated_at: "t" }] }));
    await import("./match/background.js");
    resetMatchQueue();
    resetProductionReady();
    await ensureProductionReady(env.dir);
    await new Promise((r) => setTimeout(r, 20));
    await matchWorkerIdle(env.dir);
    expect((await listMatchJobs(env.dir)).find((j) => j.id === "mjob-boot")?.state).toBe("done");
  });
});

describe("核对中稿被归档 / 删除（Codex 审 segB8 P2）", () => {
  for (const [label, act, text] of [
    ["归档", async (id: string) => { await setContent(env, id, { status: "archived" }); }, "核对取消：稿已归档"],
    ["删除", async (id: string) => { await softDeleteContent(id, env.dir); }, "核对取消：稿已删除"],
  ] as const) {
    it(`${label}：事实转候选并写原因、记时间线、放掉预留；重放回当前状态`, async () => {
      const gate = deferred();
      fakeAsr(async () => { await gate.promise; return { ok: true, text: BODY_A.slice(30, 160) }; });
      const { a, b, src } = await setup();
      await record(env, { content_id: a.id, kind: "aroll", path: src, request_id: "r1" });
      await act(a.id);
      gate.resolve();
      await matchWorkerIdle(env.dir);
      const doc = await readProductionDocOrEmpty(a.id, env.dir);
      const f = doc.facts.find((x) => x.kind === "aroll")!;
      expect(f).toMatchObject({ state: "candidate", evidence: text });
      expect(doc.requests?.r1?.receipt).toMatchObject({ state: "candidate" });
      const { readTimeline } = await import("../../storage/production-store.js");
      expect((await readTimeline(a.id, env.dir)).some((e) => e.type === "aroll_match_candidate")).toBe(true);
      expect(await record(env, { content_id: b.id, kind: "aroll", path: src, request_id: "rb" })).not.toMatchObject({ code: "aroll_pending_elsewhere" });
    });
  }
});
