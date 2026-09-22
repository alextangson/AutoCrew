import { describe, it, expect } from "vitest";
import {
  buildSubmitTool,
  createCapture,
  isAcceptedCapture,
  validateSubmitArgs,
  assembleScript,
  assembleAndHumanize,
  MAX_BODY_CHARS,
} from "./script-payload.js";
import type { Captured, SubmitGateDeps } from "./script-payload.js";
import type { QualityGateSpec } from "../packs/pack-schema.js";
import type { LedgerEntry } from "./number-gate.js";

function args(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "三个坑",
    hook: "开场就说结论",
    body: "正文讲清机制，读者照做能少走弯路。",
    cta: "今晚就去改一行配置。",
    hashtags: ["AI"],
    ...over,
  };
}

function submit(tool: ReturnType<typeof buildSubmitTool>, over: Record<string, unknown> = {}): string {
  const out = tool.execute(args(over));
  if (typeof out !== "string") throw new Error("submit_script 必须同步返回字符串");
  return out;
}

const KOUBO_DEPS: SubmitGateDeps = { forbidFormatMarkers: true };

describe("buildSubmitTool — 形状校验在最前", () => {
  it("缺字段直接退回，不跑任何门", () => {
    const captured = createCapture();
    const tool = buildSubmitTool(captured, undefined, { forbidFormatMarkers: true, requireNumberEvidence: true });
    const out = submit(tool, { body: "" });
    expect(out).toContain("缺少字段 body");
    expect(captured.payload).toBeNull();
    expect(captured.gateFailures).toEqual([]);
    expect(captured.blocked).toBeNull();
  });

  it("类型不对也退回", () => {
    expect(validateSubmitArgs(args({ hashtags: "AI" }))).toMatchObject({ ok: false });
  });
  it("完整正文可独立提交，不为格式强制开头、CTA 或标签", () => {
    const text = "我们记录了实际操作。\n\n我们形成闭环。\n\n我们决定继续观察。";
    const result = validateSubmitArgs({ title: "试点复盘", body: text });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.payload).toEqual({ title: "试点复盘", body: text, hook: "", cta: "", hashtags: [] });
    expect(assembleScript(result.payload)).toBe(text);
    expect(assembleAndHumanize(result.payload)).toBe(text);
    expect(buildSubmitTool(createCapture()).parameters.required).toEqual(["title", "body"]);
  });

  it("旧分段提交保持顺序，空开头/结尾不制造空段", () => {
    const legacy = validateSubmitArgs(args());
    expect(legacy.ok && assembleScript(legacy.payload)).toBe("开场就说结论\n\n正文讲清机制，读者照做能少走弯路。\n\n今晚就去改一行配置。");
    const optional = validateSubmitArgs(args({ hook: " ", cta: "", hashtags: [] }));
    expect(optional.ok && assembleScript(optional.payload)).toBe("正文讲清机制，读者照做能少走弯路。");
  });

  it.each(["title", "body"])("%s 仍严格必需且不能全是空白", (field) => {
    for (const value of [undefined, null, "", "  ", 42]) {
      expect(validateSubmitArgs(args({ [field]: value })).ok).toBe(false);
    }
  });

  it.each([{ hook: 42 }, { cta: null }, { hashtags: null }, { hashtags: [42] }])("可选字段仍验证类型：%j", (over) => {
    expect(validateSubmitArgs(args(over)).ok).toBe(false);
  });

  it("正文上限覆盖拼接后的开头与结尾，不能把超长正文挪到可选字段绕过", () => {
    expect(validateSubmitArgs(args({ hook: "", cta: "", body: "文".repeat(MAX_BODY_CHARS) })).ok).toBe(true);
    for (const over of [
      { body: "文".repeat(MAX_BODY_CHARS), hook: "开头", cta: "" },
      { body: "正文", hook: "", cta: "尾".repeat(MAX_BODY_CHARS) },
    ]) {
      expect(validateSubmitArgs(args(over))).toMatchObject({ ok: false, error: expect.stringContaining("完整正文") });
    }
    expect(validateSubmitArgs(args({ hook: "😀", body: "文".repeat(MAX_BODY_CHARS - 3), cta: "" })).ok).toBe(true);
  });

  it("完整正文提交仍须通过数字与格式硬门", () => {
    const captured = createCapture();
    const tool = buildSubmitTool(captured, undefined, { requireNumberEvidence: true, forbidFormatMarkers: true });
    tool.execute({ title: "复盘", body: "[画面] 留存上升了 45%。" });
    expect(captured.gateFailures.map((failure) => failure.check)).toEqual(["format_markers", "unverified_numbers"]);
    expect(captured.accepted).toBe(false);
  });

});

describe("口播格式硬门", () => {
  it("命中即打回，并把 blocked 置上（loop 半路终止也不会被当成稿收走）", () => {
    const captured = createCapture();
    const tool = buildSubmitTool(captured, undefined, KOUBO_DEPS);
    const out = submit(tool, { body: "[画面] 终端截图，然后讲三个坑。" });
    expect(out).toContain("口播格式硬门未通过");
    expect(captured.gateFailures.map((f) => f.check)).toEqual(["format_markers"]);
    expect(captured.blocked).toMatchObject({ reason: "format_markers" });
    expect(isAcceptedCapture(captured)).toBe(false);
  });

  it("改好重交即清空 blocked", () => {
    const captured = createCapture();
    const tool = buildSubmitTool(captured, undefined, KOUBO_DEPS);
    submit(tool, { body: "[画面] 终端截图。" });
    const out = submit(tool);
    expect(out).toBe("已收到脚本");
    expect(captured.blocked).toBeNull();
    expect(captured.accepted).toBe(true);
    expect(isAcceptedCapture(captured)).toBe(true);
  });

  it("修复轮耗尽后拒收，状态 format_markers", () => {
    const captured = createCapture();
    const tool = buildSubmitTool(captured, undefined, KOUBO_DEPS);
    submit(tool, { body: "[画面] 一" });
    submit(tool, { body: "[画面] 二" });
    const out = submit(tool, { body: "[画面] 三" });
    expect(out).toContain("修复轮已用尽");
    expect(out).toContain("format_markers");
    expect(captured.blocked?.reason).toBe("format_markers");
    expect(captured.accepted).toBe(false);
    expect(captured.payload?.body).toBe("[画面] 三");
  });

  it("开关关掉就不管格式", () => {
    const captured = createCapture();
    const tool = buildSubmitTool(captured);
    expect(submit(tool, { body: "[画面] 终端截图" })).toBe("已收到脚本");
    expect(captured.accepted).toBe(true);
  });
});

describe("数字硬门", () => {
  const ledger: LedgerEntry[] = [{ id: "ev-1", source: "verified_quote", quote: "次日留存只有 30%" }];
  const deps: SubmitGateDeps = { requireNumberEvidence: true, ledger: () => ledger };

  it("无据数字打回，状态 needs_evidence", () => {
    const captured = createCapture();
    const tool = buildSubmitTool(captured, undefined, deps);
    const out = submit(tool, { body: "留存只有 45%，这就是问题。" });
    expect(out).toContain("数字硬门未通过");
    expect(captured.gateFailures.map((f) => f.check)).toEqual(["unverified_numbers"]);
    expect(captured.blocked?.reason).toBe("needs_evidence");
  });

  it("有据即过，来源分级不影响放行", () => {
    const captured = createCapture();
    const tool = buildSubmitTool(captured, undefined, deps);
    expect(submit(tool, { body: "次日留存只有 30%，这就是问题。" })).toBe("已收到脚本");
    expect(captured.accepted).toBe(true);
  });

  it("账本是 getter：find_evidence 中途加的条目下一次提交就算数", () => {
    const live: LedgerEntry[] = [];
    const captured = createCapture();
    const tool = buildSubmitTool(captured, undefined, { requireNumberEvidence: true, ledger: () => live });
    expect(submit(tool, { body: "留存 45%。" })).toContain("数字硬门未通过");
    live.push({ id: "ev-T1.1", source: "verified_quote", quote: "实测留存 45%" });
    expect(submit(tool, { body: "留存 45%。" })).toBe("已收到脚本");
    expect(captured.blocked).toBeNull();
  });

  it("开了硬门却没账本 = 没有证据，所有数字都拦下", () => {
    const captured = createCapture();
    const tool = buildSubmitTool(captured, undefined, { requireNumberEvidence: true });
    expect(submit(tool, { body: "留存 45%。" })).toContain("数字硬门未通过");
  });

  it("模糊量词只是 advisory，不拦门", () => {
    const captured = createCapture();
    const tool = buildSubmitTool(captured, undefined, deps);
    expect(submit(tool, { body: "我见过十几个这样的团队。" })).toBe("已收到脚本");
    expect(captured.needsHumanNumbers).toEqual(["十几个"]);
    expect(captured.accepted).toBe(true);
  });

  it("[未证实] 不是放行口", () => {
    const captured = createCapture();
    const tool = buildSubmitTool(captured, undefined, deps);
    expect(submit(tool, { body: "留存 [未证实] 45%。" })).toContain("数字硬门未通过");
    expect(captured.blocked?.reason).toBe("needs_evidence");
  });
});

describe("三道门的顺序与共用修复计数", () => {
  const gate: QualityGateSpec = { minChars: 200 };
  const deps: SubmitGateDeps = { forbidFormatMarkers: true, requireNumberEvidence: true, ledger: () => [] };

  it("失败顺序：格式 → 数字 → 质量", () => {
    const captured = createCapture();
    const tool = buildSubmitTool(captured, gate, deps);
    const out = submit(tool, { body: "[画面] 留存 45%。" });
    expect(captured.gateFailures.map((f) => f.check)).toEqual([
      "format_markers",
      "unverified_numbers",
      "min_chars",
    ]);
    expect(out.indexOf("口播格式硬门")).toBeLessThan(out.indexOf("数字硬门"));
    expect(out.indexOf("数字硬门")).toBeLessThan(out.indexOf("QUALITY GATE"));
  });

  it("硬门与质量门共用同一个修复计数（两轮硬门用完，第三轮质量门不再打回）", () => {
    const captured = createCapture();
    const tool = buildSubmitTool(captured, gate, deps);
    expect(submit(tool, { body: "[画面] 一" })).toContain("口播格式硬门未通过");
    expect(submit(tool, { body: "留存 45%。" })).toContain("数字硬门未通过");
    const third = submit(tool, { body: "正文很短。" });
    expect(third).toBe("已收到脚本");
    expect(captured.gateFailures.map((f) => f.check)).toEqual(["min_chars"]);
    expect(captured.accepted).toBe(true);
  });

  it("包级 maxRepairRounds 对硬门同样生效", () => {
    const captured = createCapture();
    const tool = buildSubmitTool(captured, { minChars: 1, maxRepairRounds: 1 }, KOUBO_DEPS);
    expect(submit(tool, { body: "[画面] 一" })).toContain("口播格式硬门未通过");
    expect(submit(tool, { body: "[画面] 二" })).toContain("修复轮已用尽");
    expect(captured.blocked?.reason).toBe("format_markers");
  });

  it("软门 FAIL 不影响 accepted（沿用旧行为：接受最后一稿 + 透出未过项）", () => {
    const captured = createCapture();
    const tool = buildSubmitTool(captured, gate);
    submit(tool);
    submit(tool);
    submit(tool);
    expect(captured.gateFailures.map((f) => f.check)).toEqual(["min_chars"]);
    expect(isAcceptedCapture(captured)).toBe(true);
  });

  it("旧调用签名（无 deps）行为不变", () => {
    const captured: Captured = { payload: null, gateFailures: [] };
    const tool = buildSubmitTool(captured, { minChars: 5 });
    expect(submit(tool)).toBe("已收到脚本");
    expect(assembleScript(captured.payload!)).toContain("开场就说结论");
  });
});
