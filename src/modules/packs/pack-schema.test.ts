import { describe, it, expect } from "vitest";
import { KOUBO_PACK } from "./koubo.js";
import { getPack, DEFAULT_PACK_ID } from "./index.js";

describe("koubo pack shape", () => {
  it("registry resolves the default pack", () => {
    expect(DEFAULT_PACK_ID).toBe("koubo");
    expect(getPack("koubo")).toBe(KOUBO_PACK);
    expect(() => getPack("nonexistent")).toThrow(/未注册/);
  });

  it("carries the five hook types extracted from the playbook", () => {
    expect(KOUBO_PACK.hooks).toHaveLength(5);
    const types = KOUBO_PACK.hooks.map((h) => h.type);
    expect(types).toContain("痛点");
    expect(types).toContain("悬念");
    expect(types).toContain("反差");
    for (const h of KOUBO_PACK.hooks) {
      expect(h.whenToUse.length).toBeGreaterThan(4);
    }
  });

  it("抖音 = 纯口播正文，包里不再示范镜头/字幕条格式（P1 §4.4 口播格式硬门）", () => {
    const douyin = KOUBO_PACK.platformAdjustments.douyin;
    expect(douyin?.style).toBe("纯口播正文，不写画面/字幕条/镜头标注；3 秒内出钩子");
    for (const marker of ["[画面]", "[口播]", "[字幕条]"]) {
      expect(douyin?.style).not.toContain(marker);
    }
  });

  it("structure skeleton covers hook/body/cta with non-empty rules", () => {
    expect(KOUBO_PACK.structure.hook.length).toBeGreaterThan(0);
    expect(KOUBO_PACK.structure.body.length).toBeGreaterThanOrEqual(4);
    expect(KOUBO_PACK.structure.cta.length).toBeGreaterThan(0);
    // V5.7:自检从 10 条字数打勾收敛为 7 条功能性检验(活人感重写)
    expect(KOUBO_PACK.selfReview.length).toBeGreaterThanOrEqual(7);
  });

  it("reward: default exists and every byPlatform entry names its primary inside its own weights", () => {
    const all = [KOUBO_PACK.reward.default, ...Object.values(KOUBO_PACK.reward.byPlatform ?? {})];
    for (const r of all) {
      expect(Object.keys(r.weights).length).toBeGreaterThan(0);
      expect(r.weights[r.primary]).toBeGreaterThan(0);
    }
  });

  it("every declared weight is a positive finite number (调参面保护)", () => {
    const all = [KOUBO_PACK.reward.default, ...Object.values(KOUBO_PACK.reward.byPlatform ?? {})];
    for (const r of all) {
      for (const [key, w] of Object.entries(r.weights)) {
        expect(Number.isFinite(w), `${key} 权重非有限数`).toBe(true);
        expect(w, `${key} 权重必须为正`).toBeGreaterThan(0);
      }
    }
  });

  it("xiaohongshu reward does not depend on completion metrics (平台无此列)", () => {
    const xhs = KOUBO_PACK.reward.byPlatform?.xiaohongshu;
    expect(xhs).toBeDefined();
    expect(xhs?.weights.completionRate).toBeUndefined();
    expect(xhs?.weights.completion5s).toBeUndefined();
    expect(xhs?.primary).toBe("favorites");
  });

  it("douyin reward leads with completion5s (dogfood 发现：对钩子质量更敏感)", () => {
    const dy = KOUBO_PACK.reward.byPlatform?.douyin;
    expect(dy?.primary).toBe("completion5s");
    expect(dy?.weights.completion5s).toBeGreaterThan(0);
  });
});
