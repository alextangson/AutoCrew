import { describe, expect, it } from "vitest";
import { extractEnglishNumbers } from "./english-numbers.js";
import { verifyNumbers, type LedgerEntry } from "./number-gate.js";
import { buildChecklist, locateMapping } from "../draft/draft-final.js";

const q = (id: string, quote: string): LedgerEntry => ({ id, source: "verified_quote", quote });
const sourced = (body: string, quote: string) =>
  verifyNumbers({ title: "", hook: "", body, cta: "" }, [q("ev", quote)]).unverified.map((m) => m.raw.trim());

// content-1792502404813-dovnpj v4 的真实证据（Anthropic 内部研究报告原句）
const EV = [
  q("ev-d1", "By August interactive AI agent hours outnumbered employees’ six to one."),
  q("ev-d2", "Even among non-technical employees, reading all the output of their Claude agents would take half their work week."),
  q("ev-d6", "Based on calendar data, the median employee spends 20% more time in meetings than a year ago."),
  q("ev-d7", "Written standing instructions for agents grew from a few hundred in July 2025 to 8,500 a year later."),
  q("ev-d20", "Agent hours worked outnumber human hours 6 to 1."),
];

describe("英文引文的数字说法", () => {
  it("数词、比例、量级、美元、百分比、时长", () => {
    const pick = (t: string) => extractEnglishNumbers(t).map((m) => [m.value, m.unit]);
    expect(pick("six to one")).toContainEqual([6, "multiple"]);
    expect(pick("6:1")).toContainEqual([6, "multiple"]);
    expect(pick("a 3x jump, a 4-fold rise")).toEqual(expect.arrayContaining([[3, "multiple"], [4, "multiple"]]));
    expect(pick("twenty-five teams")).toContainEqual([25, undefined]);
    expect(pick("1.2 million users")).toContainEqual([1.2e6, undefined]);
    expect(pick("$3 billion")).toContainEqual([3e9, "usd"]);
    expect(pick("40 percent")).toContainEqual([40, "percent"]);
    expect(pick("two years")).toContainEqual([2, "year"]);
    expect(pick("half an hour")).toContainEqual([0.5, "hour"]);
    expect(pick("July 2025")).toContainEqual([7, "calendar_month"]);
  });

  it("不抽约数和行文里的 one / a / may", () => {
    expect(extractEnglishNumbers("a few hundred people, one of the tools, hundreds of teams")).toEqual([]);
    expect(extractEnglishNumbers("Results may vary and we march on.")).toEqual([]);
  });

  it("同一事实不同写法放行", () => {
    expect(sourced("agent 干活的时长是人的 6 倍", EV[0].quote)).toEqual([]);
    expect(sourced("agent 干活的时长是人的 6 倍", EV[4].quote)).toEqual([]);
    expect(sourced("也得花掉半个工作周", EV[1].quote)).toEqual([]);
    expect(sourced("2025 年 7 月才几百条，一年后到了 8500 条", EV[3].quote)).toEqual([]);
    expect(sourced("贵了 3 倍", "three times more expensive")).toEqual([]);
    expect(sourced("融了 30亿美元", "raised $3 billion")).toEqual([]);
    expect(sourced("用户 120万", "1.2 million users")).toEqual([]);
  });

  it("值或口径不同照样拦", () => {
    expect(sourced("是人的 5 倍", EV[0].quote)).toEqual(["5 倍"]);
    expect(sourced("是人的 6 倍", "6 to 10 hours")).toEqual(["6 倍"]);
    expect(sourced("2025 年 8 月", EV[3].quote)).toEqual(["8 月"]);
    expect(sourced("用了 7 个月", "in July 2025")).toEqual(["7 个月"]);
    expect(sourced("三分之一的工作周", EV[1].quote)).toEqual(["三分之一"]);
    expect(sourced("两年后", EV[3].quote)).toEqual(["两年"]);
    expect(sourced("半小时", EV[1].quote)).toEqual(["半小时"]);
  });

  // Codex review 找出的六种误放
  it("负号、分数组成部分、并列数词、区间端点、非 1 分母、币种都不误放", () => {
    expect(sourced("增长 5%", "Growth was -5 percent")).toEqual(["5%"]);
    expect(sourced("下降 -5%", "Growth was -5 percent")).toEqual([]);
    expect(sourced("花了 1 小时", "it took half an hour")).toEqual(["1 小时"]);
    expect(sourced("有 2 人", "two thirds of staff")).toEqual(["2 人"]);
    expect(sourced("用了 5 年", "It takes between two and three years")).toEqual(["5 年"]);
    expect(sourced("用了 5 年", "It takes 3-5 years")).toEqual(["5 年"]);
    expect(sourced("用了 3-5 年", "It takes 3-5 years")).toEqual([]);
    expect(sourced("用了 2-3 年", "It takes between two and three years")).toEqual([]);
    expect(sourced("是人的 6 倍", "The ratio is 6 to 1.5")).toEqual(["6 倍"]);
    expect(sourced("有 20 人", "We spent twenty dollars")).toEqual(["20 人"]);
    expect(sourced("花了 20 美元", "We spent twenty dollars")).toEqual([]);
    expect(sourced("用了 120 年", "one hundred and twenty years")).toEqual([]);
  });
});

describe("prepare_final 清单回归（dovnpj v4）", () => {
  const body = [
    "agent 干活的时长是人的 6 倍，员工开会的时间却比一年前多了两成。",
    "6 倍，算的是员工自己指挥的那些 agent，时长加起来，跟员工本人的工时比。",
    "一个是，哪怕是不写代码的员工，要把自己 agent 的产出全读一遍，也得花掉半个工作周。",
    "他们员工写给 agent 的长期说明，2025 年 7 月才几百条，一年后到了 8500 条。",
  ].join("");
  const mapping = [
    { text: "agent 干活的时长是人的 6 倍，员工开会的时间却比一年前多了两成。", evidence_ids: ["ev-d20", "ev-d1", "ev-d6"] },
    { text: "6 倍，算的是员工自己指挥的那些 agent，时长加起来，跟员工本人的工时比。", evidence_ids: ["ev-d20", "ev-d1"] },
    { text: "要把自己 agent 的产出全读一遍，也得花掉半个工作周。", evidence_ids: ["ev-d2"] },
    { text: "2025 年 7 月才几百条，一年后到了 8500 条。", evidence_ids: ["ev-d7"] },
  ];

  it("四句误报不再报没出处", () => {
    const { spans, errors } = locateMapping(body, mapping, EV);
    expect(errors).toEqual([]);
    const items = buildChecklist(body, spans, EV);
    expect(items.length).toBeGreaterThanOrEqual(4);
    expect(items.filter((i) => i.status === "unsourced")).toEqual([]);
  });

  it("英文 half 不让别处标成判断的「一半」变成必须引台账", () => {
    const judged = `${body}我的看法是，以后你在公司里的存在感，至少有一半在你写下来的东西里。`;
    const withJudgment = [...mapping, { text: "我的看法是，以后你在公司里的存在感，至少有一半在你写下来的东西里。", evidence_ids: [], kind: "judgment" as const }];
    const { spans } = locateMapping(judged, withJudgment, EV);
    const item = buildChecklist(judged, spans, EV).find((i) => i.text.includes("存在感"));
    expect(item?.status).toBe("exempt");
  });

  it("改错一个数仍然报", () => {
    const wrong = body.replace("2025 年 7 月", "2025 年 9 月");
    const { spans } = locateMapping(wrong, mapping.map((m) => ({ ...m, text: m.text.replace("7 月", "9 月") })), EV);
    const bad = buildChecklist(wrong, spans, EV).filter((i) => i.status === "unsourced");
    expect(bad).toHaveLength(1);
    expect(bad[0].numbers_unsourced).toEqual(["9 月"]);
  });
});
