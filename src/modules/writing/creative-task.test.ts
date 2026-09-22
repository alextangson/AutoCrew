import { describe, expect, it } from "vitest";
import { createCreativeTask, creativeTaskHash, creativeTaskMatches, renderCreativeTask } from "./creative-task.js";

describe("shared creative task", () => {
  it("keeps the full original wording and only takes task fields", () => {
    const requirements = "  写给一线店长\n保留访谈里的犹豫，不用危言耸听。  ";
    const task = createCreativeTask({ platform: "wechat", requirements, direction: "一次失败的复盘" });
    expect(task).toEqual({ version: 1, platform: "wechat", requirements, direction: "一次失败的复盘" });
    expect(renderCreativeTask(task)).toContain(requirements);
    expect(renderCreativeTask(task)).toContain(creativeTaskHash(task));
  });
  it("inherits omitted fields but preserves explicit clearing", () => {
    const prior = createCreativeTask({ platform: "wechat", requirements: "原完整规划", direction: "先讲经历" });
    expect(createCreativeTask({}, prior)).toEqual(prior);
    expect(createCreativeTask({ direction: "", requirements: undefined }, prior)).toEqual({ version: 1, platform: "wechat", requirements: "原完整规划" });
    expect(createCreativeTask({ requirements: "" }, prior)).toEqual({ version: 1, platform: "wechat", direction: "先讲经历" });
    expect(prior.direction).toBe("先讲经历");
  });
  it("ignores surrounding whitespace for identity, but detects platform or plan changes", () => {
    const prior = createCreativeTask({ platform: "wechat", requirements: "原规划" });
    expect(creativeTaskHash(createCreativeTask({ platform: "wechat", requirements: " 原规划 " }))).toBe(creativeTaskHash(prior));
    expect(creativeTaskMatches(createCreativeTask({ platform: "douyin" }, prior), prior)).toBe(false);
    expect(creativeTaskMatches(createCreativeTask({ requirements: "改为产品公告" }, prior), prior)).toBe(false);
  });
  it("keeps legacy platform-only use without claiming legacy research covered a new plan", () => {
    expect(creativeTaskMatches(createCreativeTask({ platform: "wechat" }))).toBe(true);
    expect(creativeTaskMatches(createCreativeTask({ requirements: "新受众" }))).toBe(false);
    expect(creativeTaskMatches(createCreativeTask({ direction: "新方向" }))).toBe(false);
  });
});
