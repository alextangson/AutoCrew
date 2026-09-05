/**
 * 看板列与状态文案（纯数据）——Board.tsx 渲染时读的就是这三张表。
 *
 * 前端没有组件渲染测试环境（vitest 跑在 node、没装 testing-library），所以「看板显示得对不对」
 * 的可测部分就是这些表：列归属、状态文案、拖拽落点。P1 §4.4 新增的 `needs_evidence`
 * 漏进任何一张表，看板上的表现就是一张**看不见的卡**——状态不在任何一列里，稿子凭空消失。
 */
import { describe, expect, it } from "vitest";
import { BOARD_COLUMNS, STATUS_COLUMN, VARIANT_STATUS, DROP_TARGET_STATUS, workspaceForStatus } from "./lib";

describe("needs_evidence（P1 §4.4）在看板上有位置", () => {
  it("落在「在写」列——稿子还没成，人要在这一列看到它", () => {
    const writing = BOARD_COLUMNS.findIndex((c) => c.key === "writing");
    expect(STATUS_COLUMN["needs_evidence"]).toBe(writing);
  });

  it("有人话状态名，不会在卡片上露出英文枚举", () => {
    expect(VARIANT_STATUS["needs_evidence"]).toBe("缺证据");
  });

  it("打开它进文案台（不是剪辑/封面/发布台）", () => {
    expect(workspaceForStatus("needs_evidence")).toBe("draft");
  });

  it("拖回「在写」列不会把它拖成 needs_evidence：落点仍是草稿就绪", () => {
    expect(DROP_TARGET_STATUS["writing"]).toBe("draft_ready");
  });
});

describe("每个状态都属于且只属于一列", () => {
  it("列之间不重叠", () => {
    const seen = new Set<string>();
    for (const col of BOARD_COLUMNS) {
      for (const s of col.statuses) {
        expect(seen.has(s)).toBe(false);
        seen.add(s);
      }
    }
  });

  it("列里出现的状态都有人话名", () => {
    for (const col of BOARD_COLUMNS) {
      for (const s of col.statuses) expect(VARIANT_STATUS[s]).toBeTruthy();
    }
  });
});
