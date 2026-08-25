import { describe, it, expect } from "vitest";
import { keptWithDelta, withToggle, type KeepDelta } from "./cut-keeps";

const delta = (entries: Array<[string, boolean]>): KeepDelta => new Map(entries);
const ids = ["u1", "u2", "u3"];

describe("keptWithDelta", () => {
  it("没有增量时就是服务端那版 keeps(与改造前逐字节同行为)", () => {
    expect([...keptWithDelta({ keeps: ["u1", "u3"], ids, delta: delta([]) })].sort()).toEqual(["u1", "u3"]);
  });

  it("增量优先于新基线:人取消过的不会被新 keeps 加回来,人勾上的也不会被抹掉", () => {
    const kept = keptWithDelta({ keeps: ["u1", "u3"], ids, delta: delta([["u1", false], ["u2", true]]) });
    expect([...kept].sort()).toEqual(["u2", "u3"]);
  });

  it("新基线里消失的 id:keeps 与增量一起丢弃(重跑后 unit 编号会跨代复用)", () => {
    const kept = keptWithDelta({
      keeps: ["u1", "老单元"],
      ids,
      delta: delta([["上一代", true], ["u2", true]]),
    });
    expect([...kept].sort()).toEqual(["u1", "u2"]);
  });

  it("全不留 / 全选:每一行都记成显式 toggle,刷新后照样是那个决定", () => {
    const none = withToggle(delta([]), ids.map((id) => [id, false] as [string, boolean]));
    expect(keptWithDelta({ keeps: ["u1", "u2", "u3"], ids, delta: none }).size).toBe(0);
    const all = withToggle(none, ids.map((id) => [id, true] as [string, boolean]));
    expect([...keptWithDelta({ keeps: [], ids, delta: all })].sort()).toEqual(ids);
  });
});

describe("withToggle", () => {
  it("后一次覆盖前一次,原增量不被就地改(React 状态要换新引用才会重渲)", () => {
    const first = withToggle(delta([]), [["u1", false]]);
    const second = withToggle(first, [["u1", true]]);
    expect(first.get("u1")).toBe(false);
    expect(second.get("u1")).toBe(true);
    expect(second).not.toBe(first);
  });
});
