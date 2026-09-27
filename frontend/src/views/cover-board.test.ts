import { describe, expect, it } from "vitest";
import { coverApproveBlock, coverGroups, selectedCover } from "./cover-board";
import type { Artifact } from "./project-board";

const cover = (ratio: "3:4" | "4:3", version: number, sha = `${ratio}-${version}`): Artifact =>
  ({ path: `05-cover/v${String(version).padStart(2, "0")}/${ratio.replace(":", "x")}.png`, sha256: sha, role: `cover:${ratio}`, version, reported_at: `2026-09-27T0${version}:00:00Z` });

describe("coverGroups", () => {
  it("只收 3:4 和 4:3，新版在前，旧版保留", () => {
    const g = coverGroups([cover("3:4", 1), cover("4:3", 1), cover("3:4", 2), { ...cover("3:4", 9), role: "final-cut" }]);
    expect(g["3:4"].map((a) => a.version)).toEqual([2, 1]);
    expect(g["4:3"].map((a) => a.version)).toEqual([1]);
  });
});

describe("coverApproveBlock", () => {
  const all = coverGroups([cover("3:4", 1), cover("4:3", 1), cover("3:4", 2)]);
  it("缺尺寸时写明缺哪个", () => {
    expect(coverApproveBlock(coverGroups([cover("3:4", 1)]), null)).toBe("还缺 4:3 封面，等剪辑交上来");
    expect(coverApproveBlock(coverGroups([]), null)).toBe("还缺 3:4、4:3 封面，等剪辑交上来");
  });
  it("每个尺寸都选了一张才可点；选的版本不在索引里当没选", () => {
    expect(coverApproveBlock(all, { "3:4": { sha256: "3:4-2", path: "x" } })).toBe("先在 4:3 里各选一张");
    expect(coverApproveBlock(all, { "3:4": { sha256: "gone", path: "x" }, "4:3": { sha256: "4:3-1", path: "y" } })).toBe("先在 3:4 里各选一张");
    expect(coverApproveBlock(all, { "3:4": { sha256: "3:4-2", path: "x" }, "4:3": { sha256: "4:3-1", path: "y" } })).toBeNull();
    expect(selectedCover(all, { "3:4": { sha256: "3:4-1", path: "x" } }, "3:4")?.version).toBe(1);
  });
});
