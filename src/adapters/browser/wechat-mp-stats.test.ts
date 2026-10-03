/**
 * wechat-mp-stats.test.ts — 公众号旁听:发表记录响应(JSON 或 HTML 内嵌)的解析、翻页判定、导入列对齐。
 */
import { describe, it, expect } from "vitest";
import {
  WECHAT_MP_INSPECT_SRC,
  WECHAT_MP_PLATFORM,
  extractPublishPage,
  parsePublishResponse,
  pullWechatMpStats,
  statsToImportRows,
} from "./wechat-mp-stats.js";

const PAGE = {
  total_count: 25,
  publish_list: [
    {
      publish_info: JSON.stringify({
        sent_status: { total: 1200 },
        sent_info: { time: 1783600000 },
        appmsg_info: [
          { title: "第一篇:AI 写码的账", read_num: 456, share_num: 12, old_like_num: 7 },
          { title: "第二篇:同次群发", read_num: 88, share_num: 1, old_like_num: 0 },
        ],
      }),
    },
    { publish_info: JSON.stringify({ sent_status: {}, sent_info: { time: 1783000000 }, appmsg_info: [] }) },
  ],
};
const JSON_BODY = JSON.stringify({ base_resp: { ret: 0 }, publish_page: JSON.stringify(PAGE) });
const HTML_BODY = `<html><script>\nvar a = 1;\npublish_page = ${JSON.stringify(PAGE)};\nvar b = 2;\n</script></html>`;
const URL0 = "https://mp.weixin.qq.com/cgi-bin/appmsgpublish?sub=list&begin=0&count=10&token=1&lang=zh_CN";
const res = (body: string, status = 200, url = URL0) => ({ url, status, body });
type Inspect = (rs: Array<{ url: string; body: string }>) => { oldestMs: number | null; hasMore: boolean | null };
const inspect = (0, eval)(`(${WECHAT_MP_INSPECT_SRC})`) as Inspect;

describe("发表记录响应解析", () => {
  it("JSON 响应(双层 JSON 字符串)→ 逐篇行:阅读/分享/在看/群发时刻", () => {
    const parsed = parsePublishResponse(res(JSON_BODY));
    if (parsed.kind !== "ok") throw new Error("应解析成功");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual({
      title: "第一篇:AI 写码的账",
      publishedAt: new Date(1783600000_000).toISOString(),
      metrics: { views: 456, shares: 12, likes: 7 },
    });
  });

  it("页面首屏文档(HTML 内嵌 publish_page)也认", () => {
    expect(extractPublishPage(HTML_BODY)).toMatchObject({ total_count: 25 });
    expect(parsePublishResponse(res(HTML_BODY)).kind).toBe("ok");
  });

  it("取不到 publish_page / 没有 publish_list → schema_changed,零行", () => {
    expect(parsePublishResponse(res("<html>扫码登录</html>"))).toEqual({
      kind: "stop",
      result: { status: "schema_changed", rows: [], errorCode: "missing:publish_page" },
    });
    expect(parsePublishResponse(res(JSON.stringify({ publish_page: "{}" })))).toMatchObject({
      kind: "stop",
      result: { status: "schema_changed", errorCode: "missing:publish_page.publish_list" },
    });
  });

  it("非 2xx → 按 HTTP 归类", () => {
    expect(parsePublishResponse(res(JSON_BODY, 403))).toMatchObject({ kind: "stop", result: { status: "needs_login" } });
  });
});

describe("旁听配置与翻页判定", () => {
  it("P1-1 只打开首页,从菜单「内容管理 → 发表记录」点进去;不手拼任何数据地址", () => {
    expect(WECHAT_MP_PLATFORM.url).toBe("https://mp.weixin.qq.com/");
    expect(WECHAT_MP_PLATFORM.entry).toEqual({ css: "a,span,li,div", target: ["发表记录"], openers: ["内容管理"] });
    expect(JSON.stringify(WECHAT_MP_PLATFORM)).not.toMatch(/appmsgpublish\?|token=|cgi-bin\/[a-z]+\?/);
    expect(WECHAT_MP_PLATFORM.next).toMatchObject({ kind: "click", texts: ["下一页"] });
  });

  it("inspect:begin+count 对比 total_count;最早群发时间", () => {
    expect(inspect([res(JSON_BODY)])).toEqual({ oldestMs: 1783000000_000, hasMore: true });
    expect(inspect([res(HTML_BODY, 200, URL0.replace("begin=0", "begin=20"))]).hasMore).toBe(false);
  });
});

describe("pullWechatMpStats", () => {
  it("同标题后者覆盖前者(沿用旧拉数语义)", async () => {
    const now = () => new Date(1783600000_000 + 86_400_000);
    const pages = [0, 1].map((index) => ({ index, responses: [res(JSON_BODY)] }));
    const r = await pullWechatMpStats({ now, session: { browse: async () => ({ pages, end: "no_more", gate: null }) } });
    expect(r.status).toBe("ok");
    expect(r.rows).toHaveLength(2);
  });
});

describe("statsToImportRows(对齐 wechat_mp 列名映射)", () => {
  it("行 → 导入列:标题/发表时间(北京时间)/阅读次数/分享次数/在看次数", () => {
    const rows = statsToImportRows([{ title: "T", publishedAt: new Date(1783600000_000).toISOString(), metrics: { views: 456, shares: 12, likes: 7 } }]);
    expect(rows).toEqual([{ 标题: "T", 发表时间: "2026-07-09 20:26", 阅读次数: "456", 分享次数: "12", 在看次数: "7" }]);
  });
});
