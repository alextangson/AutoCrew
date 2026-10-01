/** 卡片「下一步」：点过「还要改…」之后说那句话，不再说「成片出来了，等你看」（verifier 2a P1） */
import { describe, expect, it } from "vitest";
import { nextStep } from "./card-next";

describe("下一步", () => {
  it("你说还要改 → 说那句话、等 AI 交新版", () => {
    const n = nextStep({ column: "剪辑中", stage: "剪辑中", status: "editing", missing: ["你说还要改：前 10 秒再紧一点"], active: true });
    expect(n?.text).toBe("你说还要改：前 10 秒再紧一点；等 AI 交新版，暂时不用你操作");
    expect(n?.action).toBeUndefined();
  });
});
