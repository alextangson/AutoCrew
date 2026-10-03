import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TitlePostSample } from "../writing/title-method-stats.js";

const posts = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));
vi.mock("../writing/title-method-stats.js", async (orig) => {
  const real = await orig<typeof import("../writing/title-method-stats.js")>();
  return {
    ...real,
    loadTitlePosts: async () => {
      const list = posts.list as unknown as TitlePostSample[];
      const n = list.filter((p) => p.method !== real.UNTAGGED && p.method !== "自拟").length;
      return { report: { publishedWithMethod: n, stage: real.trialStage(n), rows: [] }, posts: list };
    },
  };
});

const { titleLibraryAction } = await import("./title-bump.js");
const { activeTitleMethods } = await import("./title-library.js");
const { readObservations } = await import("./obs-store.js");
const { backtestSamples, eligiblePosts, findOutliers, methodScore, readComposition } = await import("./title-gate.js");
const { foldTitleLibrary } = await import("./title-library.js");
const { audit, engine } = await import("./test-fixtures.js");
const { executeCalibrationAction } = await import("../../tools/insights-calibration.js");

let dir: string;
let seq = 0;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "title-bump-")); posts.list = []; });

const P = (method: string, clickRate?: number, flagged = false): TitlePostSample => ({ id: `p${++seq}`, title: "t", method, clickRate, flagged });
const ALL_IDS = foldTitleLibrary([]).methods.map((m) => m.id);
/** 组成：改一条方法的措辞，其余全留 */
const reword = (id: string) => ({ keep: ALL_IDS.filter((x) => x !== id), remove: [], change: [{ id, why: "换个说法" }] });
const removeOne = (id: string) => ({ keep: ALL_IDS.filter((x) => x !== id), remove: [id], change: [] });
/** 4 个方法各 2 条，方法之间点击率分得很开 */
function pairs(rates: Array<[string, number, number]>): TitlePostSample[] {
  return rates.flatMap(([m, a, b]) => [P(m, a), P(m, b)]);
}
const SPREAD: Array<[string, number, number]> = [["twist", 12, 13], ["before-after", 9, 10], ["candid-talk", 6, 7], ["pitfall-list", 4, 5]];
const propose = (extra: Record<string, unknown>, auditLoop?: unknown) =>
  titleLibraryAction({ op: "propose", kind: "default-aligned", rationale: "按试用期数据", ...extra }, dir, { auditLoop: auditLoop as never });

describe("预测器（留一均值）", () => {
  it("同方法其它稿的均值；方法被删或同方法没别的稿 → 全库其它稿均值", () => {
    const s = [P("twist", 10), P("twist", 20), P("candid-talk", 4)];
    expect(methodScore(s[0], s, new Set(["twist", "candid-talk"]))).toBe(20);
    expect(methodScore(s[0], s, new Set(["candid-talk"]))).toBe(12);
    expect(methodScore(s[2], s, new Set(["twist", "candid-talk"]))).toBe(15);
  });
  it("改措辞不换 id：新旧分相同", () => {
    const g = backtestSamples(pairs(SPREAD), ALL_IDS, ALL_IDS);
    expect(g.every((x) => x.oldScore === x.newScore)).toBe(true);
  });
});

describe("样本资格", () => {
  it("未标记/自拟不参与；待复核数据剔掉并计数；同方法 1 条不下结论", () => {
    const el = eligiblePosts([P("未标记", 5), P("自拟", 5), P("twist", 3), P("twist", undefined, true), P("candid-talk", 4), P("candid-talk", 6)], ALL_IDS);
    expect(el.untagged).toBe(2);
    expect(el.flagged).toBe(1);
    expect(el.oneSample).toEqual(["twist"]);
    expect(el.samples.map((p) => p.method)).toEqual(["candid-talk", "candid-talk"]);
  });
  it("≥3× 基线算单条异常", () => {
    const s = [P("twist", 30), P("twist", 5), P("candid-talk", 6), P("candid-talk", 4)];
    expect(findOutliers(s).map((o) => o.id)).toEqual([s[0].id]);
  });
});

describe("提议组成（模型参数不可信）", () => {
  const state = foldTitleLibrary([]);
  it("JSON 字符串照收", () => {
    const c = readComposition(JSON.stringify(reword("twist")), state, undefined);
    expect(c.change[0]).toMatchObject({ id: "twist", why: "换个说法" });
  });
  it("没写全、重复、不认识的 id、改 id 以外啥都没写 → 打回", () => {
    expect(() => readComposition({ keep: ["twist"], remove: [], change: [] }, state, undefined)).toThrow(/没说留、删还是改/);
    expect(() => readComposition({ ...removeOne("twist"), keep: [...ALL_IDS] }, state, undefined)).toThrow(/不止一个列表/);
    expect(() => readComposition({ keep: "twist", remove: [], change: [] }, state, undefined)).toThrow(/方法 id 数组/);
    expect(() => readComposition({ keep: ALL_IDS.filter((x) => x !== "twist"), change: [{ id: "twist" }] }, state, undefined)).toThrow(/没写要改什么/);
  });
});

describe("终版过门", () => {
  it("门过 + 审计 PASS → 已验证；apply 要确认，落库后生效库变了", async () => {
    await engine(dir, true);
    posts.list = pairs(SPREAD) as never;
    const r = await propose({ composition: reword("twist") }, audit("PASS"));
    expect(r).toMatchObject({ ok: true, label: "已验证", applicable: true });
    expect((await titleLibraryAction({ op: "apply", proposal_id: r.proposal_id }, dir)).code).toBe("needs_confirmation");
    const a = await titleLibraryAction({ op: "apply", proposal_id: r.proposal_id, confirm: true }, dir);
    expect(a.ok).toBe(true);
    expect((await activeTitleMethods(dir)).find((m) => m.id === "twist")!.why).toBe("换个说法");
    expect((await titleLibraryAction({ op: "apply", proposal_id: r.proposal_id, confirm: true }, dir)).code).toBe("already_applied");
  });
  it("门不过（删掉区分度最高的方法）→ 拒绝，不调审计", async () => {
    await engine(dir, true);
    posts.list = pairs(SPREAD) as never;
    const calls: unknown[] = [];
    const r = await propose({ composition: removeOne("twist") }, audit("PASS", calls));
    expect(r).toMatchObject({ ok: false, code: "gate_failed" });
    expect(calls).toHaveLength(0);
  });
  it("门过 + 审计 REJECT → 拒绝；审计线路没配 → 也拒绝，不自审", async () => {
    posts.list = pairs(SPREAD) as never;
    await engine(dir, true);
    expect((await propose({ composition: reword("twist") }, audit("REJECT"))).code).toBe("audit_rejected");
    await engine(dir, false);
    const r = await propose({ composition: reword("twist") }, audit("PASS"));
    expect(r.code).toBe("audit_rejected");
    expect(String(r.error)).toMatch(/不能自审/);
  });
  it("异常稿进了门：去掉后不够 8 条 → outlier_sole_basis，并记成观察", async () => {
    await engine(dir, true);
    posts.list = pairs([["twist", 50, 48], ["before-after", 10, 11], ["candid-talk", 5, 6], ["pitfall-list", 1, 2]]) as never;
    const r = await propose({ composition: reword("twist") }, audit("PASS"));
    expect(r.code).toBe("outlier_sole_basis");
    const { live } = await readObservations(dir);
    expect(live.length).toBe(2);
    await propose({ composition: reword("twist") }, audit("PASS"));
    expect((await readObservations(dir)).live.length).toBe(2); // 同一条异常不重复记
  });
});

describe("只能是判断", () => {
  it("中期（4 条）：标 default-aligned 也强制 judgment-driven，不能 apply", async () => {
    posts.list = pairs([["twist", 6, 7], ["candid-talk", 4, 5]]) as never;
    const r = await propose({ composition: reword("twist") });
    expect(r).toMatchObject({ ok: true, label: "判断", kind: "judgment-driven", applicable: false });
    expect(r.forced).toBeTruthy();
    expect((await titleLibraryAction({ op: "apply", proposal_id: r.proposal_id, confirm: true }, dir)).code).toBe("not_verified");
  });
  it("终版但待复核数据剔完不够 8 条 → 降级为判断，写明剔了几条", async () => {
    posts.list = [...pairs(SPREAD).slice(0, 7), P("pitfall-list", undefined, true)] as never;
    const r = await propose({ composition: reword("twist") });
    expect(r.label).toBe("判断");
    expect(String(r.reason)).toMatch(/1 条待复核/);
  });
  it("单样本方法：报告写「样本 1 条，不下结论」", async () => {
    posts.list = [...pairs([["twist", 6, 7], ["candid-talk", 4, 5]]), P("before-after", 5)] as never;
    const r = await propose({ composition: reword("twist") });
    expect(r.one_sample).toEqual(["before-after：样本 1 条，不下结论"]);
  });
  it("被动到的方法只有一条异常稿 → 不能当依据", async () => {
    posts.list = [P("twist", 30), P("candid-talk", 5), P("candid-talk", 6), P("before-after", 4), P("before-after", 5)] as never;
    const r = await propose({ composition: removeOne("twist") });
    expect(r.code).toBe("outlier_sole_basis");
  });
});

describe("墓碑与撤销", () => {
  async function removeTwistVerified() {
    await engine(dir, true);
    // twist 和全库平均没区别：删掉它门照样过
    posts.list = pairs([["twist", 8, 10], ["before-after", 13, 14], ["candid-talk", 5, 6], ["pitfall-list", 3, 4]]) as never;
    const r = await propose({ composition: removeOne("twist") }, audit("PASS"));
    expect(r.label).toBe("已验证");
    return titleLibraryAction({ op: "apply", proposal_id: r.proposal_id, confirm: true }, dir);
  }
  it("删掉的方法留墓碑；没新证据不能加回来；撤销后恢复", async () => {
    const a = await removeTwistVerified();
    expect((await activeTitleMethods(dir)).some((m) => m.id === "twist")).toBe(false);
    const { titleMethodsAction } = await import("../writing/title-method-stats.js");
    expect((await titleMethodsAction({ _dataDir: dir })).method_ids).not.toContain("twist");
    const st = await titleLibraryAction({ op: "status" }, dir);
    expect(st.tombstones).toEqual([expect.objectContaining({ method: "twist" })]);
    const keep = ALL_IDS.filter((x) => x !== "twist");
    await expect(propose({ composition: { keep, remove: [], change: [], restore: ["twist"] } })).rejects.toThrow(/墓碑/);
    expect((await titleLibraryAction({ op: "revert", change_id: a.change_id, confirm: true }, dir)).code).toBe("needs_confirmation");
    await titleLibraryAction({ op: "revert", change_id: a.change_id, confirm: true, reason: "创始人说先留着" }, dir);
    expect((await activeTitleMethods(dir)).some((m) => m.id === "twist")).toBe(true);
  });
  it("提议审过后库变了 → 不能落（过期）", async () => {
    await engine(dir, true);
    posts.list = pairs(SPREAD) as never;
    const r1 = await propose({ composition: reword("twist") }, audit("PASS"));
    const r2 = await propose({ composition: reword("candid-talk") }, audit("PASS"));
    await titleLibraryAction({ op: "apply", proposal_id: r1.proposal_id, confirm: true }, dir);
    expect((await titleLibraryAction({ op: "apply", proposal_id: r2.proposal_id, confirm: true }, dir)).code).toBe("stale");
  });
});

describe("工具入口", () => {
  it("calib 是 JSON 串、composition 也是 JSON 串照收；坏 op 如实报错", async () => {
    posts.list = pairs([["twist", 6, 7], ["candid-talk", 4, 5]]) as never;
    const calib = JSON.stringify({ target: "title_library", op: "propose", kind: "judgment-driven", rationale: "x", composition: JSON.stringify(reword("twist")) });
    expect(await executeCalibrationAction("calib_bump", calib, dir, "h")).toMatchObject({ ok: true, label: "判断" });
    expect(await executeCalibrationAction("calib_bump", { target: "title_library", op: "nope" }, dir, "h")).toMatchObject({ ok: false });
  });
});
