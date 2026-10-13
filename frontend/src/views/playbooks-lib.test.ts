import { describe, expect, it } from "vitest";
import { publishLine, roundsLine, versionLabel, type VersionStats } from "./playbooks-lib";

const S = (over: Partial<VersionStats> = {}): VersionStats => ({
  version: 1, finalized: 2, in_progress: 1, pre_switch_rounds: 0, label: "样本不够", rounds: { median: 2, min: 1, max: 3 },
  publish: { published: 0, d3: { count: 0, bounce2s: null, shares_per_1k: null, favorites_per_1k: null }, d7: { count: 0, bounce2s: null, shares_per_1k: null, favorites_per_1k: null }, label: "样本不够" }, ...over,
});

describe("写作手册页的统计文字", () => {
  it("样本不够照摆数并标出来；换体裁前的轮数单独说", () => {
    expect(roundsLine(S())).toBe("已定稿 2 条 · 进行中 1 条 · 改稿轮数中位数 2（最少 1，最多 3） · 样本不够");
    expect(roundsLine(S({ label: null, pre_switch_rounds: 2 }))).toContain("换体裁前 2 轮（不计）");
    expect(roundsLine(undefined)).toBe("还没有稿用过这一版");
  });
  it("发布数据缺那天的快照就说没有", () => {
    expect(publishLine(S())).toBe("还没有发布的抖音作品");
    const p = S({ publish: { ...S().publish, published: 1, d3: { count: 1, bounce2s: 40, shares_per_1k: 5, favorites_per_1k: 10 } } });
    expect(publishLine(p)).toBe("已发布 1 条 · D+3（1 条）：2 秒跳出 40%，每千播分享 5，每千播收藏 10 · D+7：没有那天的快照 · 样本不够");
  });
  it("版本标签", () => {
    expect(versionLabel({ version: 3, at: "", author: "founder", kind: "rollback", rolled_back_to: 1 })).toBe("第 3 版 · 创始人 · 回滚到第 1 版");
  });
});
