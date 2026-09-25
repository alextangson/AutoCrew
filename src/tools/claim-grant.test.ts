import { describe, expect, it } from "vitest";
import { withTokenInNextAction } from "./claim-grant.js";

describe("withTokenInNextAction", () => {
  it("有令牌且 next_action 带 params 时，把令牌塞进 params", () => {
    const out = withTokenInNextAction({ ok: true, claim_token: "clm-1", next_action: { tool: "autocrew_writer", params: { action: "pack" } } });
    expect((out.next_action as { params: Record<string, unknown> }).params).toEqual({ action: "pack", claim_token: "clm-1" });
    expect(out.claim_token).toBe("clm-1");
  });
  it("没有令牌或没有 next_action 时原样返回", () => {
    const noToken = { ok: true, next_action: { tool: "x", params: { action: "y" } } };
    expect(withTokenInNextAction(noToken)).toBe(noToken);
    const noNext = { ok: true, claim_token: "clm-1" };
    expect(withTokenInNextAction(noNext)).toBe(noNext);
  });
  it("next_action 没有 params（纯提示）时不硬造 params", () => {
    const hint = { ok: true, claim_token: "clm-1", next_action: { action: "present_draft", message: "展示正文" } };
    expect(withTokenInNextAction(hint)).toBe(hint);
  });
});
