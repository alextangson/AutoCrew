import { describe, expect, it } from "vitest";
import { mergeWork, parseWorkItems } from "./WorkLog";

describe("工作记录（v1.1 U12）", () => {
  it("同一步的后续帧覆盖状态，出错信息保留", () => {
    let list = mergeWork([], { id: "1", name: "运行命令", status: "running" });
    list = mergeWork(list, { id: "1", name: "运行命令", status: "failed", error: "No such file" });
    list = mergeWork(list, { id: "2", name: "读取稿件", status: "done" });
    expect(list).toEqual([{ id: "1", name: "运行命令", status: "failed", error: "No such file" }, { id: "2", name: "读取稿件", status: "done" }]);
  });
  it("脏数据丢弃", () => {
    expect(parseWorkItems([{ id: 1 }, null, { id: "a", name: "x", status: "done" }])).toHaveLength(1);
  });
});
