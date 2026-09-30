/**
 * 卡片面板的抽帧检查段（spec 2026-09-30 §6）：列每处时间码 + 前后条目 + 修法，逐处「这处是故意的」带齐绑定参数；
 * 整条放行只在没跑成时出现（E13）。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SliverSection } from "./CardPanel";
import type { SliverPanel } from "./board-api";

const base: SliverPanel = { cut_sha: "s", status: "slivers", reason: null, fingerprint: "fp", blocked: true, missing: "抽帧缝 1 处", whole_waivable: false, whole_waived: false,
  items: [{ key: "100-105-b1-b2", start_frame: 100, end_frame: 105, frames: 5, start_tc: "00:03:10", prev_name: "空镜", next_name: "动效", suggestion: "剪掉这个气口，让两段 B-roll 接上", waived: false }] };
const html = (s: SliverPanel) => renderToStaticMarkup(createElement(SliverSection, { s, busy: false, act: async () => ({}) }));

describe("抽帧检查段", () => {
  it("有缝：时间码、帧数、前后条目、修法、逐处放行按钮；没有整条放行", () => {
    const h = html(base);
    expect(h).toContain("00:03:10 露出真人 5 帧");
    expect(h).toContain("「空镜」和「动效」之间");
    expect(h).toContain("建议：剪掉这个气口");
    expect(h).toContain("这处是故意的");
    expect(h).not.toContain("这条不查了");
  });
  it("没跑成：写原因 + 整条放行", () => {
    const h = html({ ...base, status: "unchecked", reason: "本机找不到这个 ChatCut 工程", items: [], whole_waivable: true });
    expect(h).toContain("没跑成：本机找不到这个 ChatCut 工程");
    expect(h).toContain("这条不查了，放行");
  });
  it("已放行的那处不再给按钮", () => {
    expect(html({ ...base, items: [{ ...base.items[0], waived: true }] })).toContain("已放行");
  });
});
