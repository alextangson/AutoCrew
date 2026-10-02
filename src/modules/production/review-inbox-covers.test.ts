/**
 * 等你拍板 §6 封面、§7-1/§7-2 成片：显式成对、成员关系、有效组、统一准入迁移、「可以审了」、挑任一版。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { readProductionDoc, writeProductionDoc } from "../../storage/production-store.js";
import { executeContentSave } from "../../tools/content-save.js";
import { validCoverGroups } from "./cover-groups.js";
import { founderDecision } from "./decisions.js";
import { explainContent } from "./read.js";
import { getContent } from "../../storage/local-store.js";
import { reconcileAll } from "./reconcile.js";
import { exists, founderApprove, makeEnv, png, projectRoot, put, record, SRT, videoContent, waiveSliverCheck, type Env } from "./testkit.js";

let env: Env;
beforeEach(async () => { env = await makeEnv({ enabled: true }); });
afterEach(async () => { await env.cleanup(); });

const TITLE = "封面成对测试";
async function approved() {
  const c = await videoContent(env, TITLE);
  await founderApprove(env, c.id);
  await record(env, { content_id: c.id, kind: "aroll", path: await put(path.join(env.inbox, "封面成对测试-原片.mov"), "raw"), request_id: "a" });
  return c;
}
const doc = async (id: string) => (await readProductionDoc(id, env.dir))!;
const cover = async (name: string, w: number, h: number, seed = name) => put(path.join(env.chatcut, name), png(w, h, seed));
const decide = (id: string, action: string, p: Record<string, unknown> = {}) => founderDecision(id, action, p, env.dir);

describe("R10 封面只按显式成对，不猜", () => {
  it("两张单独记、不带版本 → 各自成组，缺一个比例，不出「封面待你选」", async () => {
    const c = await approved();
    await record(env, { content_id: c.id, kind: "cover", path: await cover("a.png", 900, 1200), request_id: "p1" });
    await record(env, { content_id: c.id, kind: "cover", path: await cover("b.png", 1200, 900), request_id: "p2" });
    const groups = validCoverGroups(await doc(c.id));
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.complete)).toBe(true);
    const exp = await explainContent((await getContent(c.id, env.dir))!, env.dir);
    expect(exp.missing).not.toContain("封面待你选");
  });

  it("paths 一次记一组 → 一个完整组；pair_with 进那一组；同比例再挤进来 → 拒", async () => {
    const c = await approved();
    const pair = await record(env, { content_id: c.id, kind: "cover", paths: [await cover("a.png", 900, 1200), await cover("b.png", 1200, 900)], cover_text: "字", request_id: "pp" });
    expect(pair).toMatchObject({ ok: true, facts: [{ ratio: "3:4" }, { ratio: "4:3" }] });
    expect(validCoverGroups(await doc(c.id)).filter((g) => g.complete)).toHaveLength(1);
    expect(await record(env, { content_id: c.id, kind: "cover", paths: [await cover("a.png", 900, 1200), await cover("b.png", 1200, 900)], request_id: "pp" })).toMatchObject({ replayed: true });
    const first = await record(env, { content_id: c.id, kind: "cover", path: await cover("c.png", 900, 1200), request_id: "p3" });
    const second = await record(env, { content_id: c.id, kind: "cover", path: await cover("d.png", 1200, 900), pair_with: first.fact_id, request_id: "p4" });
    expect(second).toMatchObject({ ok: true, group_id: first.group_id });
    expect(await record(env, { content_id: c.id, kind: "cover", path: await cover("e.png", 900, 1200), pair_with: first.fact_id, request_id: "p5" })).toMatchObject({ ok: false, code: "cover_slot_taken" });
    expect(await record(env, { content_id: c.id, kind: "cover", paths: [await cover("f.png", 900, 1200), await cover("g.png", 900, 1200)], request_id: "p6" })).toMatchObject({ ok: false, code: "both_ratios_required" });
  });

  it("同一 sha 用进新组 = 新增成员关系，旧组不动", async () => {
    const c = await approved();
    const a = await cover("a.png", 900, 1200, "same");
    await record(env, { content_id: c.id, kind: "cover", paths: [a, await cover("b.png", 1200, 900)], request_id: "g1" });
    await record(env, { content_id: c.id, kind: "cover", paths: [a, await cover("c.png", 1200, 900)], request_id: "g2" });
    const d = await doc(c.id);
    const groups = validCoverGroups(d);
    expect(groups.filter((g) => g.complete)).toHaveLength(2);
    expect(groups[0].slots["3:4"][0].id).toBe(groups[1].slots["3:4"][0].id);
    expect(d.facts.filter((f) => f.kind === "cover" && f.ratio === "3:4")).toHaveLength(1);
  });

  it("「用这组」服务端校验：两张不是同一组 → 拒；按 group_id 选成功", async () => {
    const c = await approved();
    const g1 = await record(env, { content_id: c.id, kind: "cover", paths: [await cover("a.png", 900, 1200), await cover("b.png", 1200, 900)], cover_text: "字", request_id: "g1" });
    const g2 = await record(env, { content_id: c.id, kind: "cover", paths: [await cover("c.png", 900, 1200), await cover("d.png", 1200, 900)], cover_text: "字", request_id: "g2" });
    const d = await doc(c.id);
    const sha = (id: unknown) => d.facts.find((f) => f.id === id)!.sha256;
    const f1 = g1.facts as Array<{ fact_id: string }>, f2 = g2.facts as Array<{ fact_id: string }>;
    expect(await decide(c.id, "pick_cover", { cover_3x4_fact_id: f1[0].fact_id, cover_3x4_sha: sha(f1[0].fact_id), cover_4x3_fact_id: f2[1].fact_id, cover_4x3_sha: sha(f2[1].fact_id) }))
      .toMatchObject({ ok: false, code: "not_same_group" });
    expect(await decide(c.id, "pick_cover", { group_id: g2.group_id })).toMatchObject({ ok: true, group_id: g2.group_id });
  });
});

describe("R11 这组不要了", () => {
  it("作废已批的组 → 拒；作废别的组 → 有效组里不再有它，文件不删", async () => {
    const c = await approved();
    const g1 = await record(env, { content_id: c.id, kind: "cover", paths: [await cover("a.png", 900, 1200), await cover("b.png", 1200, 900)], cover_text: "字", request_id: "g1" });
    const g2 = await record(env, { content_id: c.id, kind: "cover", paths: [await cover("c.png", 900, 1200), await cover("d.png", 1200, 900)], cover_text: "字", request_id: "g2" });
    await decide(c.id, "pick_cover", { group_id: g1.group_id });
    expect(await decide(c.id, "retire_cover_group", { group_id: g1.group_id })).toMatchObject({ ok: false, code: "cover_group_approved" });
    expect(await decide(c.id, "retire_cover_group", { group_id: g2.group_id })).toMatchObject({ ok: true });
    expect(await decide(c.id, "retire_cover_group", { group_id: g2.group_id })).toMatchObject({ ok: true });
    expect(validCoverGroups(await doc(c.id)).map((g) => g.group.id)).toEqual([g1.group_id]);
    for (const f of g2.facts as Array<{ path: string }>) expect(await exists(path.join(projectRoot(env, c.id), f.path))).toBe(true);
    expect(await decide(c.id, "pick_cover", { group_id: g2.group_id })).toMatchObject({ ok: false, code: "stale" });
  });
});

describe("§6.2 统一准入与迁移", () => {
  it("清单坏了 → 报错、不退回扫全目录；exports/ 里的图只做候选", async () => {
    const c = await approved();
    const root = projectRoot(env, c.id);
    await put(path.join(root, "05-cover/v007/a.png"), png(900, 1200, "x"));
    await fs.writeFile(path.join(root, "05-cover/v007/cover-manifest.json"), "{ broken");
    await put(path.join(root, "05-cover/exports/b.png"), png(1200, 900, "y"));
    const report = await reconcileAll(env.dir);
    expect(report.warnings.join("\n")).toContain("cover-manifest.json 读不懂");
    const covers = (await doc(c.id)).facts.filter((f) => f.kind === "cover");
    expect(covers).toMatchObject([{ state: "candidate", path: "05-cover/exports/b.png" }]);
  });

  it("迁移：其他目录收成 accepted、不属于有效批准的 → 转候选并写原因，文件不动；属于有效批准的不动", async () => {
    const c = await approved();
    const root = projectRoot(env, c.id);
    const a = await put(path.join(root, "05-cover/exports/a.png"), png(900, 1200, "a"));
    const b = await put(path.join(root, "05-cover/exports/b.png"), png(1200, 900, "b"));
    const stray = await put(path.join(root, "05-cover/review-1/c.png"), png(900, 1200, "c"));
    const d = await doc(c.id);
    const mk = (id: string, p: string, ratio: "3:4" | "4:3", sha: string) => ({ id, kind: "cover" as const, round: d.round, state: "accepted" as const, availability: "present" as const, source: "reconcile" as const, at: new Date().toISOString(), path: path.relative(root, p), ratio, sha256: sha, size: 1, mtime_ms: 1 });
    const { sha256File } = await import("../video/handoff/manifest.js");
    const [sa, sb, sc] = [await sha256File(a), await sha256File(b), await sha256File(stray)];
    const { bodyHash } = await import("../../storage/production-store.js");
    const body = (await getContent(c.id, env.dir))!.body;
    const legacy = { ...d, cover_schema: undefined, facts: [...d.facts, mk("fa", a, "3:4", sa), mk("fb", b, "4:3", sb), mk("fc", stray, "3:4", sc)],
      decisions: [...d.decisions, { id: "dcov", type: "cover_approval" as const, round: d.round, at: new Date().toISOString(), source: "founder" as const, cover_3x4_sha: sa, cover_4x3_sha: sb, cover_text: "字", body_hash: bodyHash(body) }] };
    delete (legacy as { cover_schema?: 1 }).cover_schema;
    await writeProductionDoc(c.id, env.dir, legacy, d.revision);
    await reconcileAll(env.dir);
    const after = await doc(c.id);
    expect(after.cover_schema).toBe(1);
    expect(after.facts.find((f) => f.id === "fc")).toMatchObject({ state: "candidate", source: "migration", evidence: "在『审阅』文件夹里找到的，不在正式封面文件夹" });
    expect(after.facts.find((f) => f.id === "fa")!.state).toBe("accepted");
    expect(after.facts.find((f) => f.id === "fb")!.state).toBe("accepted");
    expect(await exists(stray)).toBe(true);
  });
});

describe("R12 「可以审了」只能 agent 标，创始人可挑任一版", () => {
  async function twoCuts() {
    const c = await approved();
    const v1 = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "封面成对测试-1.mp4"), "cut-1"), request_id: "c1" });
    const v2 = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.chatcut, "封面成对测试-2.mp4"), "cut-2"), request_id: "c2" });
    return { c, v1, v2 };
  }

  it("没标的成片不算待你审；mark_ready 后才算；重复标幂等；候选不能标", async () => {
    const { c, v2 } = await twoCuts();
    const miss = async () => (await explainContent((await getContent(c.id, env.dir))!, env.dir)).missing;
    expect(await miss()).not.toContain("成片待你审");
    const mark = (p: Record<string, unknown>) => executeContentSave({ _dataDir: env.dir, _host: "codex", action: "mark_ready", content_id: c.id, ...p }) as Promise<Record<string, unknown>>;
    expect(await mark({ fact_id: v2.fact_id })).toMatchObject({ ok: true, marked: true });
    expect(await mark({ fact_id: v2.fact_id })).toMatchObject({ ok: true, note: expect.stringContaining("标过") });
    expect((await doc(c.id)).ready_marks).toHaveLength(1);
    expect(await miss()).toContain("成片待你审");
    const cand = await record(env, { content_id: c.id, kind: "cut", path: await put(path.join(env.outside, "别的.mp4"), "cut-x"), request_id: "cx" });
    expect(await mark({ fact_id: cand.fact_id })).toMatchObject({ ok: false, code: "not_accepted" });
  });

  it("挑旧版通过：批准绑所选 sha，登记只取 for_cut=所选 sha 的字幕", async () => {
    const { c, v1, v2 } = await twoCuts();
    const d = await doc(c.id);
    const sha = (id: unknown) => d.facts.find((f) => f.id === id)!.sha256!;
    await record(env, { content_id: c.id, kind: "srt", path: await put(path.join(env.chatcut, "v2.srt"), SRT), for_cut: v2.fact_id, request_id: "s2" });
    await record(env, { content_id: c.id, kind: "cover", paths: [await cover("a.png", 900, 1200), await cover("b.png", 1200, 900)], cover_text: "字", request_id: "g" });
    await waiveSliverCheck(env, c.id, sha(v1.fact_id));
    const ok = await decide(c.id, "approve_cut", { fact_id: v1.fact_id, sha256: sha(v1.fact_id) });
    expect(ok).toMatchObject({ ok: true, decision: { sha256: sha(v1.fact_id) } });
    const g = validCoverGroups(await doc(c.id))[0];
    const r = await decide(c.id, "pick_cover", { group_id: g.group.id });
    expect(r).toMatchObject({ ok: true, registration_failed: expect.stringContaining("字幕") });
    await record(env, { content_id: c.id, kind: "srt", path: await put(path.join(env.chatcut, "v1.srt"), `${SRT}\n`), for_cut: v1.fact_id, request_id: "s1" });
    const after = await doc(c.id);
    expect(after.registrations.at(-1)).toMatchObject({ cut_sha: sha(v1.fact_id), srt_for_cut: sha(v1.fact_id) });
  });
});
