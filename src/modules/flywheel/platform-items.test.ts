/**
 * platform-items.test.ts — 绑定表的读写与容错（spec §5.1）。
 *
 * 立场：绑定表是**缓存不是账本**——损坏就重建空表，代价只是退回标题匹配再自愈一次；
 * 但已认对的绑定不许被弱证据推翻（url > title），否则「自愈」会变成「自坏」。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readPlatformItems,
  lookupPlatformItem,
  commitBindings,
  bindingsForContent,
  bindByPublishUrl,
  platformItemKey,
} from "./platform-items.js";

let dir: string;
const file = () => path.join(dir, "platform-items.json");

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-platform-items-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("读写", () => {
  it("提交后读得回来，落盘结构带 schemaVersion", async () => {
    const written = await commitBindings([{ platform: "douyin", itemId: "item-1", contentId: "c1", via: "title" }], dir);
    expect(written).toBe(1);

    const bound = await lookupPlatformItem("douyin", "item-1", dir);
    expect(bound?.contentId).toBe("c1");
    expect(bound?.via).toBe("title");
    expect(bound?.boundAt).toBeTruthy();

    const raw = JSON.parse(await fs.readFile(file(), "utf-8"));
    expect(raw.schemaVersion).toBe(1);
    expect(Object.keys(raw.items)).toEqual(["douyin:item-1"]);
  });

  it("文件不存在 → 空表，不抛也不 warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await readPlatformItems(dir)).toEqual({});
    expect(await lookupPlatformItem("douyin", "nope", dir)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("平台别名归一：xhs 与 xiaohongshu 是同一个键", async () => {
    expect(platformItemKey("xhs", "note-1")).toBe(platformItemKey("xiaohongshu", "note-1"));
    await commitBindings([{ platform: "xhs", itemId: "note-1", contentId: "c9", via: "url" }], dir);
    expect((await lookupPlatformItem("xiaohongshu", "note-1", dir))?.contentId).toBe("c9");
  });

  it("bindingsForContent 列出某稿的全部绑定", async () => {
    await commitBindings(
      [
        { platform: "douyin", itemId: "a", contentId: "c1", via: "url" },
        { platform: "xiaohongshu", itemId: "b", contentId: "c1", via: "title" },
        { platform: "douyin", itemId: "z", contentId: "c2", via: "title" },
      ],
      dir,
    );
    expect((await bindingsForContent("c1", dir)).map((b) => b.key).sort()).toEqual(["douyin:a", "xiaohongshu:b"]);
  });
});

describe("损坏与容错", () => {
  it("JSON 损坏 → 空表 + warn，下次提交重建出可读文件", async () => {
    await fs.writeFile(file(), "{ 这不是 JSON", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await readPlatformItems(dir)).toEqual({});
    expect(warn).toHaveBeenCalled();

    await commitBindings([{ platform: "douyin", itemId: "item-1", contentId: "c1", via: "title" }], dir);
    expect((await lookupPlatformItem("douyin", "item-1", dir))?.contentId).toBe("c1");
  });

  it("schemaVersion 不认 → 空表（不拿未来版本的结构瞎猜）", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await fs.writeFile(file(), JSON.stringify({ schemaVersion: 99, items: { "douyin:x": { contentId: "c1" } } }), "utf-8");
    expect(await readPlatformItems(dir)).toEqual({});
  });

  it("单条坏值只丢那条，同表其余绑定照常可用", async () => {
    await fs.writeFile(
      file(),
      JSON.stringify({
        schemaVersion: 1,
        items: {
          "douyin:good": { contentId: "c1", boundAt: "2026-08-01T00:00:00.000Z", via: "url" },
          "douyin:bad": { contentId: 42, via: "telepathy" },
        },
      }),
      "utf-8",
    );
    const items = await readPlatformItems(dir);
    expect(Object.keys(items)).toEqual(["douyin:good"]);
  });
});

describe("证据优先级", () => {
  it("url 证据顶替既有的 title 绑定（人贴的链接比标题猜得准）", async () => {
    await commitBindings([{ platform: "douyin", itemId: "i", contentId: "c-old", via: "title" }], dir);
    const written = await commitBindings([{ platform: "douyin", itemId: "i", contentId: "c-new", via: "url" }], dir);
    expect(written).toBe(1);
    expect((await lookupPlatformItem("douyin", "i", dir))?.contentId).toBe("c-new");
  });

  it("title 证据不许推翻既有的 url 绑定；重复提交同一条不重写", async () => {
    await commitBindings([{ platform: "douyin", itemId: "i", contentId: "c-url", via: "url" }], dir);
    expect(await commitBindings([{ platform: "douyin", itemId: "i", contentId: "c-other", via: "title" }], dir)).toBe(0);
    expect(await commitBindings([{ platform: "douyin", itemId: "i", contentId: "c-url", via: "url" }], dir)).toBe(0);
    expect((await lookupPlatformItem("douyin", "i", dir))?.contentId).toBe("c-url");
  });

  it("空 itemId / 空 contentId 不入表", async () => {
    expect(await commitBindings([{ platform: "douyin", itemId: "  ", contentId: "c1", via: "url" }], dir)).toBe(0);
    expect(await commitBindings([{ platform: "douyin", itemId: "i", contentId: "", via: "url" }], dir)).toBe(0);
    expect(await readPlatformItems(dir)).toEqual({});
  });
});

describe("写队列（进程内并发）", () => {
  it("两次并发提交不互相覆盖：两条绑定都在", async () => {
    await Promise.all([
      commitBindings([{ platform: "douyin", itemId: "p1", contentId: "c1", via: "title" }], dir),
      commitBindings([{ platform: "douyin", itemId: "p2", contentId: "c2", via: "title" }], dir),
    ]);
    expect(Object.keys(await readPlatformItems(dir)).sort()).toEqual(["douyin:p1", "douyin:p2"]);
  });

  it("十条并发提交一条不丢", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        commitBindings([{ platform: "douyin", itemId: `x${i}`, contentId: `c${i}`, via: "title" }], dir),
      ),
    );
    expect(Object.keys(await readPlatformItems(dir))).toHaveLength(10);
  });
});

describe("bindByPublishUrl", () => {
  it("直链当场登记，返回作品 id", async () => {
    const id = await bindByPublishUrl("c1", "douyin", "https://www.douyin.com/video/7412345678901234567", dir);
    expect(id).toBe("7412345678901234567");
    expect((await lookupPlatformItem("douyin", "7412345678901234567", dir))?.via).toBe("url");
  });

  it("短链跟一次重定向后登记（注入 fetch）", async () => {
    const impl = (async () =>
      ({
        status: 302,
        headers: new Headers({ location: "https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f6a7b8c9d0" }),
      }) as Response) as unknown as typeof fetch;
    const id = await bindByPublishUrl("c2", "xiaohongshu", "https://xhslink.com/a/abc", dir, impl);
    expect(id).toBe("65f0a1b2c3d4e5f6a7b8c9d0");
  });

  it("解析不出（视频号分享链 / 平台对不上）→ null 且不写表", async () => {
    expect(await bindByPublishUrl("c3", "wechat_video", "https://channels.weixin.qq.com/web/pages/feed?eid=abc", dir)).toBeNull();
    expect(await bindByPublishUrl("c4", "douyin", "https://www.xiaohongshu.com/explore/65f0a1b2c3d4e5f6a7b8c9d0", dir)).toBeNull();
    expect(await readPlatformItems(dir)).toEqual({});
  });
});
