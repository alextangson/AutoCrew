import { describe, expect, it } from "vitest";
import { canReshoot, canSkipRow, collapsedColumns, DROP_TARGET, groupByTheme, meterRows, meterTone, mmdd, skippedLine, statusLine, stateIcon, type ThemeCard } from "./pipeline-model";
import { exceptionRows } from "./PipelineCard";
import type { BoardItem } from "./board-columns";

const item = (extra: Partial<BoardItem> = {}): BoardItem => ({
  id: "v", title: "稿", platform: "douyin", status: "publish_ready", topicId: null, column: "待发布", createdAt: "", updatedAt: "2026-10-24T00:00:00.000Z",
  draftReadyAt: null, chars: 0, finalDurationMs: null, cover: null, publish: null, publishTime: null, lastError: null, blockedReason: null, ...extra,
});
const card = (extra: Partial<ThemeCard> = {}): ThemeCard => ({
  id: "v", kind: "video", title: "稿", column: "发布中", item: item(), children: [], destinations: [], sent: 0, required: 0, exceptions: [],
  plan: { required: [], skipped: [], persisted: true }, reshoot: null, date: null, ...extra,
});

describe("管线页面模型", () => {
  it("去向条只画要发的；颜色按状态", () => {
    const c = card({ destinations: [
      { platform: "douyin", state: "已发", detail: "已发", content_id: "v", required: true },
      { platform: "bilibili", state: "没发成", detail: "被驳回", content_id: "v", required: true },
      { platform: "x", state: "没开始", detail: "", content_id: null, required: false, skipped: { by: "你在看板上", founder_words: "不发", at: "" } },
    ] });
    expect(meterRows(c).map((r) => meterTone(r.state))).toEqual(["done", "hot"]);
    expect(stateIcon(c.destinations[2])).toBe("skip");
  });
  it("空列收成竖条，选题列永远展开", () => {
    const s = collapsedColumns([card({ column: "发布中" })]);
    expect([...s].sort()).toEqual(["写稿", "全部发完", "剪辑", "录制", "待发布"].sort());
    expect(s.has("发布中")).toBe(false);
  });
  it("卡上只显示例外：没发成标红、发布中还没发的列出来、重拍要你去撤", () => {
    const c = card({ column: "发布中", reshoot: { round_ended: 1, round: 2, at: "", founder_words: "重拍", via: "board", published: [], to_cancel: [{ platform: "bilibili", content_id: "v" }] }, destinations: [
      { platform: "douyin", state: "已发", detail: "已发", content_id: "v", required: true },
      { platform: "wechat_video", state: "没发成", detail: "被驳回：封面违规", content_id: "v", required: true },
      { platform: "youtube", state: "在做", detail: "在写", content_id: "e", required: true },
      { platform: "x", state: "没开始", detail: "", content_id: null, required: true },
      { platform: "wechat_mp", state: "在做", detail: "等新成片", content_id: "w", required: true, paused: true },
    ] });
    expect(exceptionRows(c).map((x) => [x.text, x.hot])).toEqual([
      ["视频号 被驳回：封面违规", true], ["YouTube 英文版在做", false], ["X 没开始", false], ["公众号 等新成片", false], ["B站 已定时，要你去撤", true],
    ]);
  });
  it("不出的脚注、状态行、拖动落点", () => {
    expect(skippedLine(card({ plan: { required: [], skipped: [{ platform: "youtube", by: "你在看板上", founder_words: "", at: "" }, { platform: "x", by: "你在看板上", founder_words: "", at: "" }], persisted: true } }))).toBe("YouTube、X 不出 · 你定的");
    expect(statusLine(card({ column: "写稿", item: item({ status: "draft_ready", column: "写稿中" }) }))).toEqual({ text: "稿子写好了，等你认", tone: "you" });
    expect(statusLine(card({ column: "录制", item: item({ status: "approved", column: "待录制" }), reshoot: { round_ended: 1, round: 2, at: "", founder_words: "", via: "board", published: [], to_cancel: [] } }))?.text).toBe("要重拍 · 等你录新的 A-roll");
    expect(DROP_TARGET.全部发完).toBe("已发布");
    expect(mmdd("2026-10-24T02:00:00.000Z")).toBe("10-24");
  });
  it("「要你做的」按主题分组只是排列：每一行原样保留；父稿发了，子稿的事照样在", () => {
    const rows = [
      { key: "a", items: [{ content_id: "v", theme_id: "v", theme_title: "主题" }] },
      { key: "b", items: [{ content_id: "o", theme_id: "o", theme_title: "别的" }] },
      { key: "c", items: [{ content_id: "e", theme_id: "v", theme_title: "主题" }] },
      { key: "d", items: [{ content_id: null }] },
    ];
    const g = groupByTheme(rows);
    expect(g.map((x) => [x.theme?.id ?? null, x.rows.map((r) => r.key)])).toEqual([["v", ["a", "c"]], ["o", ["b"]], [null, ["d"]]]);
    expect(g.flatMap((x) => x.rows)).toHaveLength(rows.length);
  });
  it("「不出」看发布状态，不看通用动作；「重拍」看本轮有没有素材，重拍过的轮次也能再拍", () => {
    const row = { required: true, state: "没开始" as const, actions: ["prepare_publish" as const, "i_published" as const] };
    expect(canSkipRow(card(), row)).toBe(true);
    expect(canSkipRow(card(), { ...row, state: "已定时" })).toBe(false);
    const reshot = { round_ended: 1, round: 2, at: "", founder_words: "", via: "board" as const, published: [], to_cancel: [] };
    expect(canReshoot(card({ column: "剪辑", item: item({ active: true }), reshoot: reshot }))).toBe(true);
    expect(canReshoot(card({ column: "录制", item: item({ active: true }), reshoot: reshot }))).toBe(false);
  });
});


describe("待核（定时过点、还没核到公开）", () => {
  it("琥珀色：去向条 check、行图标 check；卡上是提示不是红色例外", () => {
    expect(meterTone("待核")).toBe("check");
    expect(stateIcon({ state: "待核", required: true })).toBe("check");
    const rows = exceptionRows(card({ destinations: [{ platform: "wechat_video", state: "待核", detail: "应已公开，等核对", content_id: "v", required: true }] }));
    expect(rows).toEqual([{ key: "wechat_video-v-", platform: "wechat_video", text: "视频号 应已公开，等核对", hot: false, amber: true }]);
  });
});
