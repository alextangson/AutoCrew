/** content summary 的制作段字段与翻页（1b §8，§14-16/17，B20 / B35） */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeContentSave } from "./content-save.js";
import { withFileOwnership } from "../modules/production/mutex.js";
import { mutateProduction } from "../modules/production/service.js";
import { setMatchDeps } from "../modules/production/match/deps.js";
import { matchWorkerIdle } from "../modules/production/match/queue.js";
import { synth } from "../modules/production/match/synth-fixture.js";
import { founderApprove, makeEnv, projectRoot, put, record, videoContent, type Env } from "../modules/production/testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await matchWorkerIdle(env.dir); await env.cleanup(); });

const summary = (id: string, since_seq?: unknown) =>
  executeContentSave({ _dataDir: env.dir, _host: "codex", action: "summary", id, ...(since_seq !== undefined ? { since_seq } : {}) }) as Promise<Record<string, unknown>>;
const bytes = (r: unknown) => Buffer.byteLength(JSON.stringify(r));

async function addEvents(id: string, n: number): Promise<void> {
  await withFileOwnership(() => mutateProduction(id, env.dir, () => ({
    value: null, events: Array.from({ length: n }, (_, i) => ({ type: "fact_imported", detail: { fact_id: `fact-synthetic-${i}-${"x".repeat(20)}`, state: "candidate" } })),
  })));
}

describe("summary 的制作段字段", () => {
  it("制作段：missing / badges / aroll[]（项目内绝对路径）/ changes / latest_seq / next_since_seq / has_more", async () => {
    const c = await videoContent(env, "摘要测试用的一条稿");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "摘要测试用的一条稿-原片.mov"), "bytes"), request_id: "r1" });
    const r = await summary(c.id);
    expect(r).toMatchObject({ ok: true, stage: "剪辑中", has_more: false });
    expect(r.aroll).toEqual([expect.objectContaining({ state: "accepted", round: 1, path: path.join(projectRoot(env, c.id), "02-aroll/摘要测试用的一条稿-原片.mov") })]);
    expect((r.changes as unknown[]).length).toBeGreaterThan(0);
    expect(r.next_since_seq).toBe(r.latest_seq);
    expect(bytes(r)).toBeLessThanOrEqual(1536);
  });

  it("写稿段稿件有 pending_match 也给 pending[] 与 aroll[]（§14-16）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setMatchDeps({ transcriber: { notReady: async () => null, transcribe: async () => { await gate; return { ok: false, unavailable: false, reason: "测试" }; } } });
    const c = await videoContent(env, "还在写的稿");
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "IMG_1.mov"), "b"), request_id: "r1" });
    const r = await summary(c.id);
    expect(r.pending).toEqual([expect.objectContaining({ fact_id: expect.any(String), started_at: expect.any(String) })]);
    expect(r.aroll).toEqual([expect.objectContaining({ state: "pending_match" })]);
    expect(r.badges).toContain("正在核对原片");
    release();
  });

  it("写稿段唯一的核对转成候选后，摘要仍给终态与原因，并翻得到落定事件（Codex 审 segA P2）", async () => {
    setMatchDeps({ transcriber: { notReady: async () => null, transcribe: async () => ({ ok: false, unavailable: false, reason: "假失败" }) } });
    const c = await videoContent(env, "还在写的另一条稿");
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "IMG_2.mov"), "b2"), request_id: "r1" });
    const before = await summary(c.id);
    await matchWorkerIdle(env.dir);
    const r = await summary(c.id, before.next_since_seq);
    expect(r.aroll).toEqual([expect.objectContaining({ state: "candidate", reason: expect.stringContaining("假失败") })]);
    expect((r.changes as Array<{ type: string }>).map((x) => x.type)).toContain("aroll_match_candidate");
  });

  it("本轮原片超过 5 条：较早的 pending 落定后，翻到那条变化时一定带上它的新路径（Codex 审 segA P2）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const title = "很多原片的一条测试稿";
    const c = await videoContent(env, title, "draft_ready", synth(7, 400));
    setMatchDeps({ thresholds: { calibrated: true, floor: 0.3, margin: 0.2 }, transcriber: { notReady: async () => null, transcribe: async () => { await gate; return { ok: true, text: synth(7, 400).slice(10, 150) }; } } });
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "IMG_old.mov"), "old"), request_id: "old" });
    for (let i = 0; i < 6; i++) await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${title}-${i}.mov`), `t${i}`), request_id: `n${i}` });
    const since = (await summary(c.id)).latest_seq as number;
    release();
    await matchWorkerIdle(env.dir);
    const r = await summary(c.id, since);
    const done = (r.changes as Array<{ type: string; fact_id?: string }>).find((x) => x.type === "aroll_match_accepted");
    expect(done).toBeTruthy();
    expect(r.aroll).toEqual(expect.arrayContaining([expect.objectContaining({ fact_id: done!.fact_id, state: "accepted", path: expect.stringContaining("02-aroll") })]));
  });

  it("本轮原片很多、路径很长：摘要仍 ≤ 1.5KB（extra 缩到 0 时不能回成全部；Codex 审 segB P2）", async () => {
    const c = await videoContent(env, "很多长路径原片的稿");
    await founderApprove(env, c.id);
    for (let i = 0; i < 9; i++) {
      await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.outside, `${"很长很长的原片文件名".repeat(4)}-${i}.mov`), `x${i}`), request_id: `r${i}` });
    }
    const r = await summary(c.id);
    expect(bytes(r)).toBeLessThanOrEqual(1536);
  });

  it("很多条 pending、路径很长：每页都 ≤ 1.5KB，按 aroll_next_offset 翻页能拿到每一条（Codex 审 segB7 P2）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setMatchDeps({ transcriber: { notReady: async () => null, transcribe: async () => { await gate; return { ok: false, unavailable: false, reason: "测试结束" }; } } });
    try { await manyPending(); } finally { release(); }
  });

  async function manyPending(): Promise<void> {
    const c = await videoContent(env, "很多核对中原片的稿");
    const ids = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const r = await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${"很长很长的收件箱原片文件名".repeat(3)}-${i}.mov`), `p${i}`), request_id: `r${i}` });
      ids.add(String(r.fact_id));
    }
    const seen = new Set<string>();
    let offset: unknown = undefined;
    for (let page = 0; page < 20; page++) {
      const r = await executeContentSave({ _dataDir: env.dir, _host: "codex", action: "summary", id: c.id, ...(offset !== undefined ? { aroll_offset: offset } : {}) }) as Record<string, unknown>;
      expect(bytes(r)).toBeLessThanOrEqual(1536);
      for (const a of r.aroll as Array<{ fact_id: string }>) seen.add(a.fact_id);
      for (const p of r.pending as Array<{ fact_id: string }>) expect(ids.has(p.fact_id)).toBe(true);
      if (r.aroll_next_offset === undefined) break;
      offset = r.aroll_next_offset;
    }
    expect([...ids].every((id) => seen.has(id))).toBe(true);
  }

  it("原片按 (at, id) 稳定集合只用 aroll_offset 翻：每条恰好出现一次，中途落定的那条不丢（Codex 审 segB8 P2）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setMatchDeps({ transcriber: { notReady: async () => null, transcribe: async () => { await gate; return { ok: false, unavailable: false, reason: "中途落定" }; } } });
    try {
      const c = await videoContent(env, "原片稳定翻页的稿");
      const ids: string[] = [];
      const first = await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "IMG_pending.mov"), "p"), request_id: "rp" });
      ids.push(String(first.fact_id));
      for (let i = 0; i < 8; i++) {
        const r = await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.outside, `${"很长很长的原片文件名字".repeat(3)}-${i}.mov`), `x${i}`), request_id: `r${i}` });
        ids.push(String(r.fact_id));
      }
      const seen: string[] = [];
      let offset: unknown = undefined;
      for (let page = 0; page < 30; page++) {
        const r = await executeContentSave({ _dataDir: env.dir, _host: "codex", action: "summary", id: c.id, ...(offset !== undefined ? { aroll_offset: offset } : {}) }) as Record<string, unknown>;
        expect(bytes(r)).toBeLessThanOrEqual(1536);
        seen.push(...(r.aroll as Array<{ fact_id: string }>).map((a) => a.fact_id));
        if (page === 0) { release(); await matchWorkerIdle(env.dir); }
        if (r.aroll_next_offset === undefined) break;
        offset = r.aroll_next_offset;
      }
      expect([...seen].sort()).toEqual([...ids].sort());
    } finally { release(); }
  });

  it("没有制作事实的写稿段稿件不带这些字段", async () => {
    const c = await videoContent(env, "干净的稿");
    const r = await summary(c.id);
    expect(r).not.toHaveProperty("changes");
  });
});

describe("changes 翻页：按 seq 升序，截尾不跳事件（B20 / B35）", () => {
  it("从 since_seq=0 一页页翻，拿到的 seq 连续不缺，每页 ≤ 1.5KB", async () => {
    const c = await videoContent(env, "翻页测试用的一条稿");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "翻页测试用的一条稿-原片.mov"), "b"), request_id: "r1" });
    await addEvents(c.id, 40);
    const seen: number[] = [];
    let since = 0;
    let latest = 0;
    for (let page = 0; page < 50; page++) {
      const r = await summary(c.id, since);
      expect(bytes(r)).toBeLessThanOrEqual(1536);
      const seqs = (r.changes as Array<{ seq: number }>).map((x) => x.seq);
      seen.push(...seqs);
      latest = r.latest_seq as number;
      expect(r.next_since_seq).toBe(seqs.at(-1) ?? since);
      since = r.next_since_seq as number;
      if (!r.has_more) break;
    }
    expect(seen).toEqual(Array.from({ length: latest }, (_, i) => i + 1));
  });

  it("不传 since_seq 给最近 10 条（放不下就截，has_more 说明）", async () => {
    const c = await videoContent(env, "最近变化测试用的稿");
    await founderApprove(env, c.id);
    await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "最近变化测试用的稿-原片.mov"), "b"), request_id: "r1" });
    await addEvents(c.id, 25);
    const r = await summary(c.id);
    const seqs = (r.changes as Array<{ seq: number }>).map((x) => x.seq);
    expect(seqs[0]).toBe((r.latest_seq as number) - 9);
    expect(bytes(r)).toBeLessThanOrEqual(1536);
  });

  it("since_seq 当字符串传来照收；不是非负整数就明确拒", async () => {
    const c = await videoContent(env, "参数稿");
    expect(await summary(c.id, "3")).toMatchObject({ ok: true });
    expect(await summary(c.id, "abc")).toMatchObject({ ok: false, code: "bad_param" });
    expect(await summary(c.id, -1)).toMatchObject({ ok: false, code: "bad_param" });
  });
});
