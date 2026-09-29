import { describe, expect, it } from "vitest";
import { deriveStage } from "./derive.js";
import { BODY, BH, DERIVE_CASES, doc, fact, fullFacts, SHA, decision } from "./derive-fixtures.js";
import { explain, withLegacyDecisions } from "./explain.js";
import { emptyProductionDoc } from "../../storage/production-types.js";

describe("推导表夹具（§2.6 每行正反例 + §16）", () => {
  it.each(DERIVE_CASES)("$name", ({ build, expect: want }) => {
    const { doc: d, body, publish } = build();
    const r = deriveStage(d, body ?? BODY, publish ?? { verified: false });
    expect({ stage: r.stage, rule: r.rule }).toEqual({ stage: want.stage, rule: want.rule });
    if (want.missing) expect(r.missing).toEqual(want.missing);
    if (want.missingIncludes) expect(r.missing).toEqual(expect.arrayContaining(want.missingIncludes));
    if (want.badges) expect(r.badges).toEqual(want.badges);
    if (want.publishable !== undefined) expect(r.publishable).toBe(want.publishable);
  });

  it("每一行都有正例和反例", () => {
    for (const rule of ["D1", "D2", "D3", "D4"]) {
      expect(DERIVE_CASES.some((c) => c.name.startsWith(`${rule}+`)), `${rule} 正例`).toBe(true);
      expect(DERIVE_CASES.some((c) => c.name.startsWith(`${rule}-`)), `${rule} 反例`).toBe(true);
    }
    expect(DERIVE_CASES.some((c) => c.name.startsWith("D5+"))).toBe(true);
  });
});

const video = (over: Partial<Parameters<typeof explain>[0]["content"]> = {}) => ({ id: "content-x", status: "approved" as const, platform: "douyin", body: BODY, ...over });

describe("explain：写稿段与制作段的边界（§2.1）", () => {
  it("写稿段稿件已有 A-roll：仍在写稿中，只挂 badge，不越过认稿", () => {
    const d = { ...emptyProductionDoc(), facts: [fact("aroll", SHA.aroll)] };
    const r = explain({ content: video({ status: "draft_ready" }), doc: d, enabled: true, publish: { verified: false } });
    expect(r).toMatchObject({ column: "写稿中", phase: "writing", stage: null, badges: ["已有 A-roll，等你认稿"] });
  });

  it("A-roll 与成片都在、没认稿：badge 说两样都有", () => {
    const d = { ...emptyProductionDoc(), facts: [fact("aroll", SHA.aroll), fact("cut", SHA.cut)] };
    expect(explain({ content: video({ status: "draft_ready" }), doc: d, enabled: true, publish: { verified: false } }).badges).toEqual(["已有 A-roll / 剪辑产物，等你认稿"]);
  });

  it("status 写着 approved 但没有有效认稿决定：推导回写稿中（制作段资格只来自认稿决定）", () => {
    expect(explain({ content: video(), doc: emptyProductionDoc(), enabled: true, publish: { verified: false } }).column).toBe("写稿中");
  });

  it("改标题不让认稿与批准失效（只绑正文）", () => {
    const d = doc(fullFacts(), []);
    const a = explain({ content: { ...video(), title: "旧标题" } as never, doc: d, enabled: true, publish: { verified: false } });
    const b = explain({ content: { ...video(), title: "新标题" } as never, doc: d, enabled: true, publish: { verified: false } });
    expect(a.column).toBe("剪辑中");
    expect(b).toEqual(a);
  });

  it("改正文 → 认稿失效，回写稿中", () => {
    const d = doc(fullFacts(), []);
    expect(explain({ content: video({ body: "改了一句" }), doc: d, enabled: true, publish: { verified: false } }).column).toBe("写稿中");
  });

  it("重开文稿后（round+1、新轮没有认稿）回写稿中", () => {
    const d = doc(fullFacts(), []);
    d.decisions.push(decision("reopen", { round: 1 }));
    d.round = 2;
    expect(explain({ content: video({ status: "editing" }), doc: d, enabled: true, publish: { verified: false } })).toMatchObject({ column: "写稿中", phase: "writing" });
  });

  it("图文不走推导（E3）", () => {
    const r = explain({ content: video({ platform: "wechat_mp", status: "approved" }), doc: null, enabled: true, publish: { verified: false } });
    expect(r).toMatchObject({ column: "待发布", phase: "other", status: null });
  });

  it("投影：待录制 approved / 剪辑中 editing / 待发布 publish_ready / 已发布 published", () => {
    const e = (d: ReturnType<typeof doc>, publish = { verified: false }) => explain({ content: video(), doc: d, enabled: true, publish }).status;
    expect(e(doc([], []))).toBe("approved");
    expect(e(doc([fact("aroll", SHA.aroll)], []))).toBe("editing");
    expect(e(doc([], []), { verified: true })).toBe("published");
  });
});

describe("影子模式（§4.1）", () => {
  it("未启用：column 仍按旧状态，推导结果放在 shadow", () => {
    const r = explain({ content: video({ status: "editing" }), doc: null, enabled: false, publish: { verified: false } });
    expect(r.column).toBe("剪辑中");
    expect(r.shadow).toMatchObject({ column: "待录制", rule: "D5" });
  });

  it("旧状态等价决定：认过稿之后补 legacy 认稿；已发布补「我发了」；已登记补 legacy 登记", () => {
    const d = withLegacyDecisions(null, { ...video({ status: "published" }), video: undefined });
    expect(d.decisions.map((x) => [x.type, x.source])).toEqual([["script_approval", "legacy"], ["i_published", "legacy"]]);
    expect(d.decisions[0].body_hash).toBe(BH);
    const reg = withLegacyDecisions(null, { ...video({ status: "publish_ready" }), video: { final: { sha256: SHA.cut, covers: { "3:4": SHA.c34, "4:3": SHA.c43 } } } as never });
    expect(reg.registrations).toMatchObject([{ source: "legacy", cut_sha: SHA.cut, body_hash: BH }]);
    expect(explain({ content: { ...video({ status: "publish_ready" }), video: { final: { sha256: SHA.cut, covers: { "3:4": SHA.c34, "4:3": SHA.c43 } } } as never }, doc: null, enabled: false, publish: { verified: false } }).shadow?.column).toBe("待发布");
  });

  it("写稿段、真决定存在时不补 legacy", () => {
    expect(withLegacyDecisions(null, video({ status: "draft_ready" })).decisions).toEqual([]);
    const real = doc([], []);
    expect(withLegacyDecisions(real, video()).decisions).toHaveLength(1);
  });
});
