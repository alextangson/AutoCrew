/**
 * publish-url.test.ts — 平台链接 → 作品 id（spec §5.1）。
 *
 * 锁的是「宁可不认，不认错」：认不出返回 null，解析出来的 id 必须是抓取器同一命名空间的东西
 * （视频号分享链里的 eid 是令牌不是 objectId，故意不认）。短链走注入 fetch，跳数/超时有上限。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { parsePublishUrl, isShortLink, resolveShortLink, resolvePublishUrl } from "./publish-url.js";

const DY_ID = "7412345678901234567";
const XHS_ID = "65f0a1b2c3d4e5f6a7b8c9d0";

afterEach(() => {
  vi.useRealTimers();
});

describe("parsePublishUrl 抖音", () => {
  it("作品页 / 分享页 / 主页弹层 / 创作者后台四种形态都认", () => {
    const forms = [
      `https://www.douyin.com/video/${DY_ID}`,
      `https://www.iesdouyin.com/share/video/${DY_ID}/?region=CN&mid=123`,
      `https://www.douyin.com/user/MS4wLjABAAAA?modal_id=${DY_ID}`,
      `https://creator.douyin.com/creator-micro/content/manage?item_id=${DY_ID}&enter_from=web`,
    ];
    for (const url of forms) {
      expect(parsePublishUrl(url), url).toEqual({ platform: "douyin", itemId: DY_ID });
    }
  });

  it("短链本身解析不出 id（要先跟重定向）", () => {
    expect(parsePublishUrl("https://v.douyin.com/iRxbcNaK/")).toBeNull();
    expect(isShortLink("https://v.douyin.com/iRxbcNaK/")).toBe(true);
  });
});

describe("parsePublishUrl 小红书", () => {
  it("explore / discovery / 个人页三种形态都认", () => {
    const forms = [
      `https://www.xiaohongshu.com/explore/${XHS_ID}?xsec_token=ab`,
      `https://www.xiaohongshu.com/discovery/item/${XHS_ID}`,
      `https://www.xiaohongshu.com/user/profile/5f0a1b2c3d4e5f6a7b8c9d01/${XHS_ID}`,
    ];
    for (const url of forms) {
      expect(parsePublishUrl(url), url).toEqual({ platform: "xiaohongshu", itemId: XHS_ID });
    }
  });

  it("xhslink 短链解析不出 id，但认得出是短链", () => {
    expect(parsePublishUrl("https://xhslink.com/a/AbCdEf")).toBeNull();
    expect(isShortLink("https://xhslink.com/a/AbCdEf")).toBe(true);
  });
});

describe("parsePublishUrl 视频号", () => {
  it("明写 objectId 的形态认得出", () => {
    expect(parsePublishUrl("https://channels.weixin.qq.com/platform/post/list?objectId=export_abc123")).toEqual({
      platform: "wechat_video",
      itemId: "export_abc123",
    });
  });

  it("只有 eid/exportkey 的分享链 → null（令牌不是作品 id，不冒充）", () => {
    expect(
      parsePublishUrl("https://channels.weixin.qq.com/web/pages/feed?eid=AAAAAgdnekIEAQAAAAA%3D&exportkey=xyz"),
    ).toBeNull();
  });
});

describe("parsePublishUrl 边界", () => {
  it("只接受 http(s)", () => {
    expect(parsePublishUrl(`javascript:alert(1)//www.douyin.com/video/${DY_ID}`)).toBeNull();
    expect(parsePublishUrl(`file:///www.douyin.com/video/${DY_ID}`)).toBeNull();
    expect(parsePublishUrl(`www.douyin.com/video/${DY_ID}`)).toBeNull();
    expect(parsePublishUrl("")).toBeNull();
  });

  it("陌生域名一律不认（哪怕路径长得像）", () => {
    expect(parsePublishUrl(`https://example.com/video/${DY_ID}`)).toBeNull();
    expect(parsePublishUrl("https://mp.weixin.qq.com/s/abcdef")).toBeNull(); // 公众号文章不是视频作品
  });

  it("platform 是过滤器：平台对不上直接 null，别名 xhs 照样认", () => {
    expect(parsePublishUrl(`https://www.douyin.com/video/${DY_ID}`, "xiaohongshu")).toBeNull();
    expect(parsePublishUrl(`https://www.douyin.com/video/${DY_ID}`, "douyin")?.itemId).toBe(DY_ID);
    expect(parsePublishUrl(`https://www.xiaohongshu.com/explore/${XHS_ID}`, "xhs")?.itemId).toBe(XHS_ID);
  });

  it("平台域名对但没有 id → null", () => {
    expect(parsePublishUrl("https://www.douyin.com/discover")).toBeNull();
    expect(parsePublishUrl("https://www.xiaohongshu.com/explore")).toBeNull();
  });
});

/** 极简 fetch 桩：按 URL 给响应，记录实际打了几跳 */
function stubFetch(routes: Record<string, { status: number; location?: string }>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    const key = String(url);
    calls.push(key);
    const route = routes[key] ?? { status: 200 };
    return {
      status: route.status,
      headers: new Headers(route.location ? { location: route.location } : {}),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("resolveShortLink", () => {
  it("一跳落地：返回真实链接，且不再多打一次作品页", async () => {
    const target = `https://www.douyin.com/video/${DY_ID}`;
    const { impl, calls } = stubFetch({ "https://v.douyin.com/abc/": { status: 302, location: target } });
    expect(await resolveShortLink("https://v.douyin.com/abc/", impl)).toBe(target);
    expect(calls).toEqual(["https://v.douyin.com/abc/"]);
  });

  it("短链套短链也跟得下去（仍在跳数预算内）", async () => {
    const target = `https://www.xiaohongshu.com/explore/${XHS_ID}`;
    const { impl, calls } = stubFetch({
      "https://xhslink.com/a/one": { status: 302, location: "https://xhslink.com/a/two" },
      "https://xhslink.com/a/two": { status: 302, location: target },
    });
    expect(await resolveShortLink("https://xhslink.com/a/one", impl)).toBe(target);
    expect(calls).toHaveLength(2);
  });

  it("一直在短链里绕 → 3 跳封顶后返回 null", async () => {
    const { impl, calls } = stubFetch({
      "https://v.douyin.com/1/": { status: 302, location: "https://v.douyin.com/2/" },
      "https://v.douyin.com/2/": { status: 302, location: "https://v.douyin.com/3/" },
      "https://v.douyin.com/3/": { status: 302, location: "https://v.douyin.com/4/" },
      "https://v.douyin.com/4/": { status: 302, location: "https://v.douyin.com/5/" },
    });
    expect(await resolveShortLink("https://v.douyin.com/1/", impl)).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("5 秒无响应 → 中止并返回 null（不抛、不挂住调用方）", async () => {
    vi.useFakeTimers();
    const hanging = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    const pending = resolveShortLink("https://v.douyin.com/slow/", hanging);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBeNull();
  });

  it("网络抛错 / 非 http(s) 目标 / 非 http(s) 入参 → 一律 null", async () => {
    const throwing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await resolveShortLink("https://v.douyin.com/abc/", throwing)).toBeNull();

    const { impl } = stubFetch({ "https://v.douyin.com/app/": { status: 302, location: "snssdk1128://aweme/detail/1" } });
    expect(await resolveShortLink("https://v.douyin.com/app/", impl)).toBeNull();

    const { impl: unused, calls } = stubFetch({});
    expect(await resolveShortLink("javascript:alert(1)", unused)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("落地页直接 200 无跳转 → 返回原地址", async () => {
    const { impl } = stubFetch({ "https://v.douyin.com/final/": { status: 200 } });
    expect(await resolveShortLink("https://v.douyin.com/final/", impl)).toBe("https://v.douyin.com/final/");
  });
});

describe("resolvePublishUrl", () => {
  it("短链 → 跟重定向后解析出 id", async () => {
    const { impl } = stubFetch({
      "https://v.douyin.com/abc/": { status: 302, location: `https://www.douyin.com/video/${DY_ID}?x=1` },
    });
    expect(await resolvePublishUrl("https://v.douyin.com/abc/", "douyin", impl)).toEqual({
      platform: "douyin",
      itemId: DY_ID,
    });
  });

  it("直链不打网（纯解析就够）", async () => {
    const { impl, calls } = stubFetch({});
    expect(await resolvePublishUrl(`https://www.douyin.com/video/${DY_ID}`, undefined, impl)).toEqual({
      platform: "douyin",
      itemId: DY_ID,
    });
    expect(calls).toHaveLength(0);
  });

  it("非短链且解析不出 → null，也不打网", async () => {
    const { impl, calls } = stubFetch({});
    expect(await resolvePublishUrl("https://example.com/whatever", undefined, impl)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
