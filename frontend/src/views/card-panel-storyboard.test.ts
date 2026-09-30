/**
 * 卡片面板的「分镜」段（spec 2026-09-30-storyboard-review-check §4、E8、E9）：最新一版带「打开审阅页」「在访达中显示」，
 * 旧版折叠；报上之后被改过有提示；看板信息行带「分镜 vNNN」。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StoryboardSection } from "./CardPanel";
import { itemMeta, type BoardItem } from "./board-columns";
import type { StoryboardPanel } from "./board-api";

const v = (n: string) => ({ fact_id: `f-${n}`, sha256: "a".repeat(64), version: n, path: `03-broll/review-${n}/review.html`, at: "2026-09-30T02:00:00.000Z" });
const panel: StoryboardPanel = { latest: { ...v("v002"), changed: false, missing: false }, older: [v("v001")] };
const html = (s: StoryboardPanel) => renderToStaticMarkup(createElement(StoryboardSection, { contentId: "content-1-a", s }));

describe("分镜段", () => {
  it("最新一版：版本号、打开审阅页、在访达中显示；旧版在折叠里", () => {
    const h = html(panel);
    expect(h).toContain("分镜 v002");
    expect(h).toContain("打开审阅页");
    expect(h).toContain("在访达中显示");
    expect(h).toMatch(/<details>.*以前的分镜（1 版）.*分镜 v001.*<\/details>/s);
  });
  it("报上之后被改过：提示", () => {
    expect(html({ ...panel, latest: { ...panel.latest, changed: true, note: "审阅页在报上之后被改过" } })).toContain("审阅页在报上之后被改过");
  });
  it("看板信息行带「分镜 v002」", () => {
    const item = { id: "content-1-a", column: "剪辑中", status: "editing", updatedAt: new Date().toISOString(), storyboard: "v002" } as unknown as BoardItem;
    expect(itemMeta(item, null)).toContain("分镜 v002");
  });
});
