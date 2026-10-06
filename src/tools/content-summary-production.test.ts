/** content summary 的制作段字段与翻页（1b §8，§14-16/17，B20 / B35） */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeContentSave } from "./content-save.js";
import { withFileOwnership } from "../modules/production/mutex.js";
import { mutateProduction } from "../modules/production/service.js";
import { founderDecision } from "../modules/production/decisions.js";
import { readProductionDocOrEmpty } from "../storage/production-store.js";
import { founderApprove, makeEnv, projectRoot, put, record, videoContent, type Env } from "../modules/production/testkit.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const summary = (id: string, since_seq?: unknown) =>
  executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: env.dir, _host: "codex", action: "summary", id, ...(since_seq !== undefined ? { since_seq } : {}) }) as Promise<Record<string, unknown>>;
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

  it("本轮原片很多、路径很长：摘要仍 ≤ 1.5KB（extra 缩到 0 时不能回成全部；Codex 审 segB P2）", async () => {
    const c = await videoContent(env, "很多长路径原片的稿");
    await founderApprove(env, c.id);
    for (let i = 0; i < 9; i++) {
      await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.outside, `${"很长很长的原片文件名".repeat(4)}-${i}.mov`), `x${i}`), request_id: `r${i}` });
    }
    const r = await summary(c.id);
    expect(bytes(r)).toBeLessThanOrEqual(1536);
  });

  it("很多条候选、路径很长：每页都 ≤ 1.5KB，按 aroll_next_offset 翻页能拿到每一条（Codex 审 segB7 P2）", async () => {
    const c = await videoContent(env, "很多候选原片的稿");
    await founderApprove(env, c.id);
    const ids = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const r = await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, `${"很长很长的收件箱原片文件名".repeat(3)}-${i}.mov`), `p${i}`), request_id: `r${i}` });
      ids.add(String(r.fact_id));
    }
    const seen = new Set<string>();
    let offset: unknown = undefined;
    for (let page = 0; page < 20; page++) {
      const r = await executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: env.dir, _host: "codex", action: "summary", id: c.id, ...(offset !== undefined ? { aroll_offset: offset } : {}) }) as Record<string, unknown>;
      expect(bytes(r)).toBeLessThanOrEqual(1536);
      for (const a of r.aroll as Array<{ fact_id: string }>) seen.add(a.fact_id);
      expect(r.pending).toEqual([]);
      if (r.aroll_next_offset === undefined) break;
      offset = r.aroll_next_offset;
    }
    expect([...ids].every((id) => seen.has(id))).toBe(true);
  });

  it("原片按 (at, id) 稳定集合只用 aroll_offset 翻：每条恰好出现一次，中途定掉的那条不丢（Codex 审 segB8 P2）", async () => {
    {
      const c = await videoContent(env, "原片稳定翻页的稿");
      await founderApprove(env, c.id);
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
        const r = await executeContentSave({ _provenance: HUMAN_WRITE, _dataDir: env.dir, _host: "codex", action: "summary", id: c.id, ...(offset !== undefined ? { aroll_offset: offset } : {}) }) as Record<string, unknown>;
        expect(bytes(r)).toBeLessThanOrEqual(1536);
        seen.push(...(r.aroll as Array<{ fact_id: string }>).map((a) => a.fact_id));
        if (page === 0) await founderDecision(c.id, "reject_candidate", { fact_id: ids[0], sha256: (await readProductionDocOrEmpty(c.id, env.dir)).facts.find((f) => f.id === ids[0])!.sha256 }, env.dir);
        if (r.aroll_next_offset === undefined) break;
        offset = r.aroll_next_offset;
      }
      expect([...seen].sort()).toEqual([...ids].sort());
    }
  });

  it("原片路径很长（中文目录名）：缩到最小形状仍给全路径，总长 ≤ 1.5KB（Codex 审 segB11 P2）", async () => {
    const c = await videoContent(env, "长路径最小形状的稿");
    await founderApprove(env, c.id);
    let dir = env.outside;
    for (let i = 0; i < 25; i++) dir = path.join(dir, `很长的中文目录名字第${i}层`);
    const file = await put(path.join(dir, "原片.mov"), "long");
    await record(env, { content_id: c.id, kind: "aroll", path: file, request_id: "r1" });
    const r = await summary(c.id);
    expect(bytes(r)).toBeLessThanOrEqual(1536);
    expect(r).toMatchObject({ ok: true, id: c.id });
    expect((r.aroll as Array<{ path: string }>)[0].path).toBe(file);
    expect(r.oversize).toBeUndefined();
  });

  it("单条必需路径本身就超预算：给最小形状并标 oversize，不截路径", async () => {
    const { fitBudget } = await import("./content-summary.js");
    const huge = `/x/${"很长".repeat(400)}.mov`;
    const part = { fields: { aroll: [{ fact_id: "f1", state: "pending_match", round: 1, path: huge }], changes: [], has_more: false, aroll_has_more: false, next_since_seq: 3, latest_seq: 3, candidates: [] }, shrink: () => false };
    const r = fitBudget({ ok: true, id: "content-1-a", stage: "写稿中", blockers: ["x"], next: "y" }, part);
    expect(r).toMatchObject({ ok: true, id: "content-1-a", stage: "写稿中", oversize: true, aroll: [{ fact_id: "f1", path: huge }] });
    expect(r).not.toHaveProperty("blockers");
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
