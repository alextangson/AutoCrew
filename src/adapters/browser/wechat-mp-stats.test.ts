/**
 * wechat-mp-stats.test.ts — 公众号后台 appmsgpublish 响应解析(musegzh 移植)。
 * 后台接口的双层 JSON 字符串形状(publish_page 是字符串、publish_info 也是字符串)必须兼容。
 */
import { describe, it, expect } from "vitest";
import { parsePublishPage, statsToImportRows, wechatStatusToPullStatus } from "./wechat-mp-stats.js";

const APPMSG = {
  publish_page: JSON.stringify({
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
      { publish_info: JSON.stringify({ sent_status: {}, sent_info: {}, appmsg_info: [] }) },
    ],
  }),
};

describe("parsePublishPage", () => {
  it("双层 JSON 字符串 → 逐篇行:阅读/分享/在看/送达/群发时刻", () => {
    const rows = parsePublishPage(JSON.stringify(APPMSG));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ title: "第一篇:AI 写码的账", read: 456, share: 12, like: 7, fans: 1200, sentTime: 1783600000 });
    expect(rows[1].read).toBe(88);
  });

  it("publish_list 为空/坏 JSON → 空数组,不抛", () => {
    expect(parsePublishPage(JSON.stringify({ publish_page: JSON.stringify({ publish_list: [] }) }))).toEqual([]);
    expect(parsePublishPage("not-json")).toEqual([]);
  });
});

describe("wechatStatusToPullStatus(三态 → 结构化状态码)", () => {
  it("in=ok / out=needs_login(等扫码,不是失败) / timeout=timeout", () => {
    expect(wechatStatusToPullStatus("in")).toBe("ok");
    expect(wechatStatusToPullStatus("out")).toBe("needs_login");
    expect(wechatStatusToPullStatus("timeout")).toBe("timeout");
  });
});

describe("statsToImportRows(对齐 wechat_mp 列名映射)", () => {
  it("行 → 导入列:标题/发表时间/阅读次数/分享次数/在看次数", () => {
    const rows = statsToImportRows([
      { title: "T", read: 10, share: 2, like: 1, fans: 100, sentTime: 1783600000 },
    ]);
    expect(rows[0]["标题"]).toBe("T");
    expect(rows[0]["阅读次数"]).toBe("10");
    expect(rows[0]["分享次数"]).toBe("2");
    expect(rows[0]["在看次数"]).toBe("1");
    expect(rows[0]["发表时间"]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
