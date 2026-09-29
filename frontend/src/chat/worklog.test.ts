import { describe, expect, it } from "vitest";
import { mergeWork, parseWorkItems, stepCount, unresolvedCount, workTitle, type WorkItem } from "./WorkLog";

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

const items: WorkItem[] = [
  { id: "t", name: "先看看稿子", status: "done", kind: "thought" },
  { id: "1", name: "读取稿件", status: "done" },
  { id: "n", name: "读完了，接着交稿", status: "done", kind: "note" },
  { id: "2", name: "交稿", status: "failed", error: "引文对不上" },
];

describe("「已处理」块（v1.2）", () => {
  it("标题：步数只数动作；有用时；停止写「已停止」（X2）", () => {
    expect(stepCount(items)).toBe(2);
    expect(workTitle(items, { durationMs: 83_000 }, false)).toBe("已处理 · 2 步 · 用时 1 分 23 秒");
    expect(workTitle(items, { stopped: true }, false)).toBe("已停止 · 2 步");
  });
  it("进行中标题显示正在做的那步（X1 实时追加）", () => {
    expect(workTitle([...items, { id: "3", name: "推进写稿流程", status: "running" }], {}, true)).toBe("正在处理 · 推进写稿流程…");
  });
  it("X6：失败后同一动作重试成功 → 不算未解决", () => {
    expect(unresolvedCount(items)).toBe(1);
    expect(unresolvedCount([...items.slice(0, 3), { ...items[3], resolved: true }, { id: "4", name: "交稿", status: "done", recovered: true }])).toBe(0);
  });
});
