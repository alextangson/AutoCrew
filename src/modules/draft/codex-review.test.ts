/** Codex 审稿：运行器结果分类、严格 JSON 校验、重试一次、合并、排队上限、重启恢复。不跑真 codex。 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyRun, parseReview, type CodexRunOutput } from "./codex-review.js";
import { enqueueReview, MAX_RUNNING, MAX_WAITING, recoverReviews, resetReviewQueue, reviewsIdle, reviewView, setCodexRunner } from "./codex-review-queue.js";
import { saveContent, updateContent } from "../../storage/local-store.js";
import { HUMAN_WRITE } from "../../storage/first-body-guard.js";
import { contentFile } from "../../storage/content-project.js";
import { activeWorkCount, resetActiveWork } from "../update/active-work.js";

const BODY = "你是不是也觉得用了 AI 以后反而更忙了？省下来的时间，被你自己又填满了。今天就试一件事：把省下来的半小时写进日历。";
const ok = (extra: Record<string, unknown> = {}) => JSON.stringify({
  main_line: { verdict: "pass", reason: "清楚", quotes: [] },
  payoff: { verdict: "fail", reason: "做法太虚", quotes: ["今天就试一件事"] },
  opening: { verdict: "pass", reason: "抓人", quotes: [] },
  advisories: [{ text: "把日历那步说具体", quote: "把省下来的半小时写进日历" }],
  ...extra,
});
const out = (stdout: string, more: Partial<CodexRunOutput> = {}): CodexRunOutput => ({ code: 0, stdout, stderr: "", timedOut: false, ...more });

let dir: string;
async function draft(): Promise<string> {
  const c = await saveContent({ title: "t", body: BODY, platform: "douyin", status: "drafting", tags: [], draftPath: { kind: "thin", startedAt: "2026-10-04T00:00:00Z" }, _provenance: HUMAN_WRITE }, dir);
  return c.id;
}
async function settle(id: string, want = ["done", "failed"]): Promise<Record<string, unknown>> {
  for (let i = 0; i < 100; i++) {
    const v = await reviewView(id, dir);
    if (want.includes(String(v.status))) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("审稿没结束");
}

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "draft-review-")); resetReviewQueue(); resetActiveWork(); });
afterEach(async () => {
  await reviewsIdle(); setCodexRunner(null); await fs.rm(dir, { recursive: true, force: true }); });

describe("parseReview", () => {
  it("合法输出：三项结论 + 建议", () => {
    const r = parseReview(`前面的话\n${ok()}\n`, BODY);
    expect(r.ok && r.result.payoff.verdict).toBe("fail");
  });
  it.each([
    ["不是 JSON", "随便说说"],
    ["判不过没引文", ok({ opening: { verdict: "fail", reason: "弱", quotes: [] } })],
    ["引文不在稿里", ok({ main_line: { verdict: "fail", reason: "散", quotes: ["稿里没有这句"] } })],
    ["verdict 写错", ok({ main_line: { verdict: "maybe", reason: "?", quotes: [] } })],
    ["建议超过 8 条", ok({ advisories: Array.from({ length: 9 }, () => ({ text: "x" })) })],
  ])("非法：%s", (_label, stdout) => {
    expect(parseReview(stdout, BODY).ok).toBe(false);
  });
});

describe("classifyRun", () => {
  it.each([
    [{ spawnError: "ENOENT" }, "codex_missing"],
    [{ timedOut: true, code: null }, "codex_timeout"],
    [{ code: 1, stderr: "Error: Not logged in. Run codex login" }, "codex_not_logged_in"],
    [{ code: 2, stderr: "boom" }, "codex_failed"],
  ] as const)("%o → %s", (more, code) => {
    expect(classifyRun(out("", more as Partial<CodexRunOutput>))?.code).toBe(code);
  });
});

describe("审稿任务", () => {
  it("合法输出 → done，结果绑定版本；trackWork 计入忙碌直到结束", async () => {
    let release!: () => void;
    setCodexRunner(() => new Promise((r) => { release = () => r(out(ok())); }));
    const id = await draft();
    await enqueueReview(id, dir);
    expect(activeWorkCount()).toBeGreaterThan(0);
    await settle(id, ["running"]);
    release();
    const v = await settle(id);
    expect(v).toMatchObject({ status: "done", version: 1, current: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(activeWorkCount()).toBe(0);
  });

  it("非法输出重试一次；仍非法 → failed 带原因原文", async () => {
    let calls = 0;
    setCodexRunner(async () => { calls++; return out("不是 JSON"); });
    const id = await draft();
    await enqueueReview(id, dir);
    const v = await settle(id);
    expect(calls).toBe(2);
    expect(v).toMatchObject({ status: "failed", error: { code: "codex_invalid_output" } });
  });

  it("第一次非法、重试合法 → done", async () => {
    const answers = ["坏的", ok()];
    setCodexRunner(async () => out(answers.shift()!));
    const id = await draft();
    await enqueueReview(id, dir);
    expect(await settle(id)).toMatchObject({ status: "done" });
  });

  it.each([
    ["超时", out("", { timedOut: true, code: null }), "codex_timeout"],
    ["没装", out("", { spawnError: "ENOENT", code: null }), "codex_missing"],
  ])("%s → failed，可见原因", async (_l, result, code) => {
    setCodexRunner(async () => result);
    const id = await draft();
    await enqueueReview(id, dir);
    expect(await settle(id)).toMatchObject({ status: "failed", error: { code } });
  });

  it("同篇同指纹在排或在跑 → 合并成一次；改稿后是新的一次，旧结果标「审的是第 N 版」", async () => {
    let release!: () => void;
    setCodexRunner(() => new Promise((r) => { release = () => r(out(ok())); }));
    const id = await draft();
    const a = await enqueueReview(id, dir);
    const b = await enqueueReview(id, dir);
    expect(b).toMatchObject({ coalesced: true, attempt: { attempt: a.attempt.attempt } });
    await settle(id, ["running"]);
    release();
    await settle(id);
    await updateContent(id, { body: `${BODY}补一句。`, _provenance: HUMAN_WRITE }, dir);
    expect(await reviewView(id, dir)).toMatchObject({ status: "done", current: false, note: expect.stringContaining("第 1 版") });
  });

  it(`同时最多跑 ${MAX_RUNNING} 个，排队满 ${MAX_WAITING} 个后新请求记失败`, async () => {
    const releases: Array<() => void> = [];
    let peak = 0, live = 0;
    setCodexRunner(() => new Promise((r) => { live++; peak = Math.max(peak, live); releases.push(() => { live--; r(out(ok())); }); }));
    const ids: string[] = [];
    for (let i = 0; i < MAX_RUNNING + MAX_WAITING + 1; i++) ids.push(await draft());
    for (const id of ids) await enqueueReview(id, dir);
    expect(await reviewView(ids.at(-1)!, dir)).toMatchObject({ status: "failed", error: { code: "queue_full" } });
    while (releases.length || live) { releases.shift()?.(); await new Promise((r) => setTimeout(r, 5)); }
    expect(peak).toBe(MAX_RUNNING);
  });

  it("重启恢复：跑着的标失败可重审，排着的按当前正文恢复，排队后改过稿的标失败", async () => {
    const [running, queued, changed] = [await draft(), await draft(), await draft()];
    const write = (id: string, status: string, hash: string) => fs.writeFile(contentFile(id, dir, "draft-review.json"), JSON.stringify({ attempts: [{ attempt: 1, draft_hash: hash, version: 1, status, queued_at: "2026-10-04T00:00:00Z" }] }));
    const { draftHash } = await import("../../storage/draft-hash.js");
    const { getContent } = await import("../../storage/local-store.js");
    await write(running, "running", draftHash((await getContent(running, dir))!));
    await write(queued, "queued", draftHash((await getContent(queued, dir))!));
    await write(changed, "queued", "old-hash");
    setCodexRunner(async () => out(ok()));
    expect(await recoverReviews(dir)).toEqual({ failed: 2, requeued: 1 });
    expect(await reviewView(running, dir)).toMatchObject({ status: "failed", error: { code: "interrupted" } });
    expect(await reviewView(changed, dir)).toMatchObject({ status: "failed", error: { code: "stale_in_queue" } });
    expect(await settle(queued)).toMatchObject({ status: "done" });
  });
});
