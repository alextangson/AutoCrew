import { describe, expect, it } from "vitest";
import { TITLE_CATEGORIES, TITLE_METHODS } from "./title-method-library.js";
import { normalizeMethodId, SELF_WRITTEN, titleMethodGuide, titleMethodIds, titleNumberWarnings, validateTitleChoice } from "./title-methods.js";

const C = (method: string, title = "标题") => ({ title, method, reason: "理由" });
const GOOD = [C("identity-call"), C("name-the-need"), C("before-after")];

describe("方法库数据", () => {
  it("8 类 16 个方法，id 唯一，每类至少一个，字段齐全，例子不用装修领域", () => {
    expect(TITLE_CATEGORIES).toHaveLength(8);
    expect(TITLE_METHODS).toHaveLength(16);
    expect(new Set(titleMethodIds()).size).toBe(16);
    for (const c of TITLE_CATEGORIES) expect(TITLE_METHODS.some((m) => m.category === c.id)).toBe(true);
    for (const m of TITLE_METHODS) {
      for (const k of ["formula", "why", "fits", "notFor", "example"] as const) expect(m[k].trim()).not.toBe("");
      expect(m.example).not.toMatch(/装修|设计师|户型|软装/);
    }
  });

  it("用数字的方法都挂了真实性红线", () => {
    for (const id of ["result-promise", "pitfall-list", "complete-guide", "before-after"]) {
      expect(TITLE_METHODS.find((m) => m.id === id)!.redLine!.join("")).toContain("数字");
    }
  });

  it("指引含流程（3 个通用候选→挑→按平台改）、自拟、撑不起不硬凑、平台语气", () => {
    const g = titleMethodGuide("bilibili");
    for (const s of ["3 个四平台通用候选", SELF_WRITTEN, "撑不起", "改几个字仍记原方法 id", "【】", "真实性红线"]) expect(g).toContain(s);
  });
});

describe("normalizeMethodId：先规范化再判", () => {
  it.each([["identity-call", "identity-call"], ["  Identity_Call ", "identity-call"], ["身份代入", "identity-call"], ["自拟", SELF_WRITTEN], ["no-such", null], [3, null], ["", null]])("%s → %s", (raw, want) => {
    expect(normalizeMethodId(raw)).toBe(want);
  });
});

describe("validateTitleChoice", () => {
  it("合规：3 个候选分属 3 类 + 方法 id", () => {
    const r = validateTitleChoice(GOOD, "Identity-Call");
    expect(r.failures).toEqual([]);
    expect(r.choice.method).toBe("identity-call");
    expect(r.choice.candidates.map((c) => c.method)).toEqual(["identity-call", "name-the-need", "before-after"]);
  });

  it("自拟：不算任何方法但照收", () => {
    expect(validateTitleChoice(GOOD, "自拟")).toMatchObject({ failures: [], choice: { method: SELF_WRITTEN } });
  });

  it("方法 id 不存在 → 拒收并列出全部可用 id", () => {
    const r = validateTitleChoice(GOOD, "clickbait");
    expect(r.failures[0].field).toBe("title_method");
    for (const id of titleMethodIds()) expect(r.failures[0].detail).toContain(id);
    const bad = validateTitleChoice([C("identity-call"), C("nope"), C("before-after")], "identity-call");
    expect(bad.failures[0]).toMatchObject({ field: "title_candidates[1]" });
    expect(bad.failures[0].detail).toContain("candid-talk");
  });

  it("候选里不许写自拟：自拟只用于创始人最终自己写", () => {
    expect(validateTitleChoice([C("自拟"), C("name-the-need"), C("before-after")], "自拟").failures[0].field).toBe("title_candidates[0]");
  });

  it("3 个候选不分属 3 个不同类 → 拒收（同方法连用不拦，但同一组里类别要分开）", () => {
    const r = validateTitleChoice([C("belief-clash"), C("twist"), C("before-after")], "twist");
    expect(r.failures.map((f) => f.detail).join("")).toContain("3 个不同类");
  });

  it("不是 3 个 → 拒收并提示可以再出 3 个或自拟", () => {
    const r = validateTitleChoice(GOOD.slice(0, 2), "identity-call");
    expect(r.failures[0].detail).toContain("正好 3 个");
    expect(r.failures[0].detail).toContain(SELF_WRITTEN);
  });

  it("中转把数组序列化成字符串（含没转义的内层引号）也能解析", () => {
    expect(validateTitleChoice(JSON.stringify(GOOD), "identity-call").failures).toEqual([]);
    const stray = `[{"title":"说"真"话","method":"candid-talk","reason":"r"},{"title":"b","method":"name-the-need","reason":"r"},{"title":"c","method":"before-after","reason":"r"}]`;
    const r = validateTitleChoice(stray, "candid-talk");
    expect(r.failures).toEqual([]);
    expect(r.choice.candidates[0].title).toBe('说"真"话');
  });

  it("缺候选、非数组字符串、解析不了的 JSON → 明确报错，不当成空数组放过", () => {
    expect(validateTitleChoice(undefined, "identity-call").failures[0].detail).toContain("缺");
    expect(validateTitleChoice("三个候选", "identity-call").failures[0].detail).toContain("不是数组");
    expect(validateTitleChoice("[{oops", "identity-call").failures[0].detail).toContain("解析不了");
  });
});

describe("titleNumberWarnings：只提示不拦", () => {
  it("标题数字在正文里有 → 无提示；没有 → 一条提示", () => {
    expect(titleNumberWarnings("3 个技巧", "这里讲 3 个技巧")).toEqual([]);
    const w = titleNumberWarnings("省 30 分钟的 3 个技巧", "这里讲 3 个技巧");
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("30");
    expect(w[0]).toContain("不拦");
  });
  it("按完整数字比：正文的 130、13 不能当标题 30、3 的依据", () => {
    const w = titleNumberWarnings("省30分钟的3个技巧", "花了130分钟，试了13种方法");
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("30、3");
  });
  it("标题没有数字 → 无提示", () => {
    expect(titleNumberWarnings("不写代码也能用的 AI", "正文")).toEqual([]);
  });
});
