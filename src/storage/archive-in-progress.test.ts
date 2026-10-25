import { describe, expect, it } from "vitest";
import type { BoardItem } from "../desktop/board-data.js";
import type { ThemeCard } from "../modules/theme/group.js";
import type { DestRow } from "../modules/theme/destinations.js";
import { childDone, unfinishedChildren } from "./archive-in-progress.js";

const item = (id: string, column: string): BoardItem => ({ id, title: `t-${id}`, column } as unknown as BoardItem);
const row = (content_id: string, state: DestRow["state"], extra: Partial<DestRow> = {}): DestRow =>
  ({ platform: "youtube", state, detail: "", content_id, required: true, ...extra });
const card = (children: BoardItem[], destinations: DestRow[], kind: ThemeCard["kind"] = "video"): ThemeCard =>
  ({ id: "p", kind, title: "源", children, destinations } as unknown as ThemeCard);

describe("派生稿做没做完（归档用）", () => {
  it("all of the child's destinations sent → done", () => {
    const en = item("en", "已发布");
    expect(childDone(card([en], [row("en", "已发"), { ...row("en", "已发"), platform: "x" }]), en)).toBe(true);
  });
  it("founder skipped every destination → done even before publishing", () => {
    const en = item("en", "剪辑中");
    expect(childDone(card([en], [row("en", "在做", { required: false, skipped: { by: "你在看板上", founder_words: "不出", at: "x" } })]), en)).toBe(true);
  });
  it("still being made, scheduled, 待核 or failed → not done", () => {
    for (const st of ["在做", "已定时", "待核", "没发成"] as const) {
      const en = item("en", "待发布");
      expect(childDone(card([en], [row("en", st)]), en)).toBe(false);
    }
  });
  it("a child with no destination rows that is not published → not done (en edition just started)", () => {
    const en = item("en", "写稿中");
    expect(childDone(card([en], []), en)).toBe(false);
  });
  it("an off-plan row that is not sent keeps the child open unless the child is published", () => {
    const off = row("en", "在做", { required: false });
    expect(childDone(card([item("en", "剪辑中")], [off]), item("en", "剪辑中"))).toBe(false);
    expect(childDone(card([item("en", "已发布")], [off]), item("en", "已发布"))).toBe(true);
  });
  it("maps parent id → unfinished child titles; ignores non-video cards and finished children", () => {
    const done = item("a", "已发布"), open = item("b", "写稿中");
    const themes = [card([done, open], [row("a", "已发"), { ...row("b", "在做"), platform: "wechat_mp" }]), { ...card([open], []), id: "q", kind: "text" as const }];
    expect([...unfinishedChildren(themes)]).toEqual([["p", ["t-b"]]]);
  });
  it("a theme whose destination plan cannot be read is treated as unfinished, even if rows look done", () => {
    const en = item("en", "已发布");
    const themes = [card([en], [row("en", "已发", { required: false })])];
    expect(unfinishedChildren(themes).size).toBe(0);
    expect(unfinishedChildren(themes, [{ id: "p", error: "JSON 坏了" }]).get("p")).toEqual(["去向计划读不出来（JSON 坏了）"]);
  });
});
