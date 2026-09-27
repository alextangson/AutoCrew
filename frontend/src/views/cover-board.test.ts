import { describe, expect, it } from "vitest";
import { approvedVersion, approveFiles, confirmLabel, coverVersions, missingNote, versionLabel, viewerOrder, viewerStep } from "./cover-board";
import type { Artifact, GateView } from "./project-board";

const cover = (ratio: "3:4" | "4:3", version: number, sha = `${ratio}-${version}`, at = `2026-09-27T0${version}:00:00Z`): Artifact =>
  ({ path: `05-cover/v${String(version).padStart(3, "0")}/${ratio.replace(":", "x")}.png`, sha256: sha, role: `cover:${ratio}`, version, reported_at: at });
const gate = (status: GateView["status"]) => ({ status } as GateView);

describe("coverVersions", () => {
  it("按版本成对，新版在前，只收封面", () => {
    const vs = coverVersions([cover("3:4", 1), cover("4:3", 1), cover("3:4", 2), { ...cover("3:4", 9), role: "final-cut" }]);
    expect(vs.map((v) => v.version)).toEqual([2, 1]);
    expect(vs[0].missing).toEqual(["4:3"]);
    expect(vs[1].missing).toEqual([]);
  });
  it("同版同尺寸取最后交的那张", () => {
    const vs = coverVersions([cover("3:4", 1, "old", "2026-09-27T01:00:00Z"), cover("3:4", 1, "new", "2026-09-27T02:00:00Z")]);
    expect(vs[0].pair["3:4"]?.sha256).toBe("new");
  });
});

describe("文案与批准", () => {
  const vs = coverVersions([cover("3:4", 1), cover("4:3", 1), cover("3:4", 2), cover("4:3", 2), cover("3:4", 3)]);
  it("缺尺寸写明缺哪个，且不给按钮", () => {
    expect(missingNote(vs[0])).toBe("这一版缺 4:3，让 Codex 补一张");
    expect(missingNote(vs[1])).toBeNull();
    expect(confirmLabel(vs[0], null)).toBeNull();
    expect(versionLabel(2)).toBe("v02");
  });
  it("已批准的那版显示已选用，其它改用；未批准都叫用这一版", () => {
    const sel = { "3:4": { sha256: "3:4-1", path: "x" }, "4:3": { sha256: "4:3-1", path: "y" } };
    expect(approvedVersion(vs, sel, gate("approved"))).toBe(1);
    expect(approvedVersion(vs, sel, gate("invalidated"))).toBeNull();
    expect(approvedVersion(vs, { "3:4": sel["3:4"] }, gate("approved"))).toBeNull();
    expect(confirmLabel(vs[2], 1)).toBe("已选用");
    expect(confirmLabel(vs[1], 1)).toBe("改用这一版");
    expect(confirmLabel(vs[1], null)).toBe("用这一版");
  });
  it("批准带这一版的两张，3:4 在前", () => {
    expect(approveFiles(vs[1]).map((f) => f.sha256)).toEqual(["3:4-2", "4:3-2"]);
  });
});

describe("大图浏览", () => {
  const order = viewerOrder(coverVersions([cover("3:4", 1), cover("4:3", 1), cover("3:4", 2)]));
  it("新版在前，每版 3:4 再 4:3", () => {
    expect(order.map((x) => x.artifact.sha256)).toEqual(["3:4-2", "3:4-1", "4:3-1"]);
  });
  it("到头停住，图不在了返回 null", () => {
    expect(viewerStep(order, "3:4-2", -1)?.artifact.sha256).toBe("3:4-2");
    expect(viewerStep(order, "3:4-2", 1)?.artifact.sha256).toBe("3:4-1");
    expect(viewerStep(order, "4:3-1", 1)?.artifact.sha256).toBe("4:3-1");
    expect(viewerStep(order, "gone", 1)).toBeNull();
  });
});
