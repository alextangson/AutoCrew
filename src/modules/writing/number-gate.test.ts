import { describe, it, expect } from "vitest";
import { extractNumbers, verifyNumbers, formatNumberGateFeedback } from "./number-gate.js";
import type { LedgerEntry, ScriptFields } from "./number-gate.js";

const EMPTY: ScriptFields = { title: "", hook: "", body: "", cta: "" };

function fields(body: string, extra: Partial<ScriptFields> = {}): ScriptFields {
  return { ...EMPTY, body, ...extra };
}

function quote(id: string, text: string, source: LedgerEntry["source"] = "verified_quote"): LedgerEntry {
  return { id, source, quote: text };
}

function raws(text: string): string[] {
  return extractNumbers(text).map((m) => m.raw);
}

function only(text: string) {
  const mentions = extractNumbers(text);
  expect(mentions).toHaveLength(1);
  return mentions[0];
}

describe("extractNumbers — 归一", () => {
  it("阿拉伯数字：千分位、小数、负数、科学计数、全角", () => {
    expect(only("95,386 个仓库").value).toBe(95386);
    expect(only("增长 12.5%").value).toBe(12.5);
    expect(only("利润 -5%").value).toBe(-5);
    expect(only("规模 1.2e3 台").value).toBe(1200);
    expect(only("９５３８６ 个仓库").value).toBe(95386);
  });

  it("万/亿量级：9.5万 / 9万5千 / 九万五千 归一到同一个数", () => {
    for (const raw of ["9.5万", "9万5千", "九万五千"]) {
      const m = only(raw);
      expect(m.value).toBe(95000);
      expect(m.scale).toBe(1e4);
    }
    expect(only("1.2亿").value).toBe(1.2e8);
  });

  it("中文数字与比例词：三成 = 30%、百分之三十 = 30%、三分之一、一半", () => {
    expect(only("三成")).toMatchObject({ value: 30, unit: "percent", kind: "percent" });
    expect(only("百分之三十")).toMatchObject({ value: 30, unit: "percent" });
    expect(only("三分之一").value).toBeCloseTo(1 / 3, 10);
    expect(only("一半的时间").value).toBe(0.5);
    expect(only("两成").value).toBe(20);
  });

  it("模糊量词标 needsHuman，不猜数值", () => {
    for (const raw of ["十几个", "数十家", "几十次", "好几百人"]) {
      const m = only(raw);
      expect(m.needsHuman).toBe(true);
      expect(m.value).toBeNull();
    }
  });

  it("区间：3-5 与 三到五 都归一成端点对", () => {
    expect(only("3-5 倍")).toMatchObject({ kind: "range", range: { min: 3, max: 5 }, unit: "multiple" });
    expect(only("三到五个")).toMatchObject({ kind: "range", range: { min: 3, max: 5 } });
  });

  it("语法角色：序号 / 列表编号 / 版本号 / 年份 / 时长", () => {
    expect(only("第 3 条").role).toBe("ordinal");
    expect(only("第三章").role).toBe("ordinal");
    expect(extractNumbers("1. 先看结构")[0].role).toBe("list");
    // 行内枚举也是编号：`1. …；2. …` 的 2 不该被当数据点
    expect(extractNumbers("1. 先看结构；2. 再看证据").map((m) => m.role)).toEqual(["list", "list"]);
    expect(only("v1.2").role).toBe("version");
    expect(only("0.1.0-rc.6").role).toBe("version");
    expect(only("2026 年").role).toBe("year");
    expect(only("2026").role).toBe("year");
    expect(only("3 秒")).toMatchObject({ role: "duration", unit: "second" });
  });

  it("行文量词与型号不是数据点：一个 / 两次 / GPT-4 / V4 不抽", () => {
    expect(raws("这是一个很典型的坑")).toEqual([]);
    expect(raws("我试了两次都失败")).toEqual([]);
    expect(raws("GPT-4 和 V4 都跑过")).toEqual([]);
    expect(raws("十分认真地写")).toEqual([]);
    // 写成阿拉伯数字就是在给读者「这是数据」的信号，照验
    expect(raws("踩了 3 个坑")).toEqual(["3 个"]);
  });
});

describe("verifyNumbers — 值 + 单位匹配", () => {
  it("5 不命中 15（字符串级伪核验的反例）", () => {
    const verdict = verifyNumbers(fields("我们跑了 5 个选题"), [quote("ev-1", "他们跑了 15 个选题")]);
    expect(verdict.verified).toHaveLength(0);
    expect(verdict.unverified.map((m) => m.raw)).toEqual(["5 个"]);
  });

  it("30% 不命中 30 元（单位不兼容）", () => {
    const verdict = verifyNumbers(fields("完播率涨了 30%"), [quote("ev-1", "客单价涨了 30 元")]);
    expect(verdict.unverified.map((m) => m.raw)).toEqual(["30%"]);
  });

  it("% 与百分点不互通", () => {
    const verdict = verifyNumbers(fields("提升 3 个百分点"), [quote("ev-1", "提升 3%")]);
    expect(verdict.unverified).toHaveLength(1);
  });

  it("9.5万 / 9万5千 命中 95000 的引文；95,386 / ９５３８６ 命中 95386 的引文", () => {
    const cases: Array<[string, string]> = [
      ["9.5万", "截至发稿共 95000 个仓库"],
      ["9万5千", "截至发稿共 95000 个仓库"],
      ["95,386", "截至发稿共 95386 个仓库"],
      ["９５３８６", "截至发稿共 95386 个仓库"],
    ];
    for (const [written, evidence] of cases) {
      const verdict = verifyNumbers(fields(`已经有 ${written} 个仓库`), [quote("ev-1", evidence)]);
      expect(verdict.unverified, written).toHaveLength(0);
      expect(verdict.verified[0].entryId).toBe("ev-1");
    }
  });

  it("约数不等于精确数：9.5万 不能拿 95,386 当出处", () => {
    const verdict = verifyNumbers(fields("已经有 9.5万 个仓库"), [quote("ev-1", "共 95,386 个仓库")]);
    expect(verdict.unverified.map((m) => m.raw)).toEqual(["9.5万 个"]);
  });

  it("三成命中 30% 的引文", () => {
    const verdict = verifyNumbers(fields("三成的人第二天就不用了"), [quote("ev-1", "次日留存只有 30%")]);
    expect(verdict.verified).toHaveLength(1);
    expect(verdict.unverified).toHaveLength(0);
  });

  it("年份照验：引文里有 2026 才过，没有就拦", () => {
    const withYear = verifyNumbers(fields("2026 年这套做法才成立"), [quote("ev-1", "2026 年 3 月发布")]);
    expect(withYear.verified).toHaveLength(1);
    const bareYear = verifyNumbers(fields("2026 年这套做法才成立"), [quote("ev-1", "发布于 2026")]);
    expect(bareYear.verified).toHaveLength(1);
    const wrongYear = verifyNumbers(fields("2026 年这套做法才成立"), [quote("ev-1", "2025 年 3 月发布")]);
    expect(wrongYear.unverified.map((m) => m.raw)).toEqual(["2026 年"]);
  });

  it("时长照验：3 秒要有出处", () => {
    expect(verifyNumbers(fields("前 3 秒必须出钩子"), [quote("ev-1", "前 3 秒决定完播")]).verified).toHaveLength(1);
    expect(verifyNumbers(fields("前 3 秒必须出钩子"), [quote("ev-1", "前 5 秒决定完播")]).unverified).toHaveLength(1);
  });

  it("区间要端点全对", () => {
    expect(verifyNumbers(fields("提速 3-5 倍"), [quote("ev-1", "实测提速 3-5 倍")]).verified).toHaveLength(1);
    expect(verifyNumbers(fields("提速 3-5 倍"), [quote("ev-1", "实测提速 3 到 6 倍")]).unverified).toHaveLength(1);
  });

  it("豁免只给语法角色：序号 / 列表编号 / 版本号", () => {
    const verdict = verifyNumbers(
      { title: "v0.1.0-rc.6 的三个坑", hook: "第 3 条最疼", body: "1. 先看结构", cta: "" },
      [],
    );
    expect(verdict.unverified).toHaveLength(0);
    expect(verdict.exempt.map((m) => m.role).sort()).toEqual(["list", "ordinal", "version"]);
  });

  it("模糊量词进 needsHuman，不进 unverified", () => {
    const verdict = verifyNumbers(fields("我见过十几个这样的团队"), []);
    expect(verdict.unverified).toHaveLength(0);
    expect(verdict.needsHuman.map((m) => m.raw)).toEqual(["十几个"]);
  });

  it("[未证实] 只是诊断文本，不是放行口", () => {
    const verdict = verifyNumbers(fields("留存 [未证实] 45%"), [quote("ev-1", "留存 40%")]);
    expect(verdict.unverified.map((m) => m.raw)).toEqual(["45%"]);
  });

  it("只被 own_claim / user_claim 命中也算过门，但来源标签透出", () => {
    const own = verifyNumbers(fields("我自己重写了 7 遍"), [quote("om-1", "这稿我改了 7 遍", "own_claim")]);
    expect(own.verified[0].source).toBe("own_claim");
    const user = verifyNumbers(fields("我自己重写了 7 遍"), [quote("uc-1", "改了 7 遍", "user_claim")]);
    expect(user.verified[0].source).toBe("user_claim");
  });

  it("多条命中时优先记 verified_quote", () => {
    const verdict = verifyNumbers(fields("涨了 30%"), [
      quote("uc-1", "涨了 30%", "user_claim"),
      quote("ev-1", "涨了 30%"),
    ]);
    expect(verdict.verified[0]).toMatchObject({ entryId: "ev-1", source: "verified_quote" });
  });

  it("四个字段全验，不只验正文", () => {
    const verdict = verifyNumbers(
      { title: "11 个坑", hook: "22 分钟", body: "33 元", cta: "44 次" },
      [],
    );
    expect(verdict.unverified.map((m) => m.field)).toEqual(["title", "hook", "body", "cta"]);
  });

  it("引文里的版本号不能给数据背书", () => {
    const verdict = verifyNumbers(fields("涨了 1.2 倍"), [quote("ev-1", "发布 v1.2.0 版本")]);
    expect(verdict.unverified).toHaveLength(1);
  });
});

describe("formatNumberGateFeedback", () => {
  it("列出无据数字 + 上下文 + 三条改法，模糊量词单列 advisory", () => {
    const verdict = verifyNumbers(
      fields("我们把首屏时间从 8 秒压到 45%，十几个团队都验过"),
      [],
    );
    const msg = formatNumberGateFeedback(verdict);
    expect(msg).toContain("数字硬门未通过");
    expect(msg).toContain("「8 秒」");
    expect(msg).toContain("「45%」");
    expect(msg).toContain("首屏时间");
    expect(msg).toContain("1. 删除");
    expect(msg).toContain("2. 改成材料里的数");
    expect(msg).toContain("3. 用 find_evidence 查证");
    expect(msg).toContain("[需人工确认]");
    expect(msg).toContain("「十几个」");
    expect(msg).toContain("[未证实]");
  });

  it("全部有据时返回空串", () => {
    const verdict = verifyNumbers(fields("涨了 30%"), [quote("ev-1", "涨了 30%")]);
    expect(formatNumberGateFeedback(verdict)).toBe("");
  });
});
