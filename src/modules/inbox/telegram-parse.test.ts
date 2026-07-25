import { describe, it, expect } from "vitest";
import { backoffDelayMs, findFirstHttpUrl, parseTelegramMessage, type TgMessage } from "./telegram-poller.js";
import { maskProxyUrl, redactSecrets } from "./telegram-api.js";

function msg(over: Partial<TgMessage>): TgMessage {
  return { message_id: 1, from: { id: 7 }, chat: { id: 9 }, ...over };
}

describe("parseTelegramMessage — 链接 + 备注", () => {
  it("纯链接：url 有值、note 为空", () => {
    expect(parseTelegramMessage(msg({ text: "  https://example.com/a  " }))).toEqual({
      kind: "url",
      url: "https://example.com/a",
    });
  });

  it("链接 + 前后备注：备注是「除链接以外的全文」，空白折叠", () => {
    expect(parseTelegramMessage(msg({ text: "看看这个   https://example.com/a  很有意思" }))).toEqual({
      kind: "url",
      url: "https://example.com/a",
      note: "看看这个 很有意思",
    });
  });

  it("多个链接只取第一个，其余留在备注里", () => {
    const parsed = parseTelegramMessage(msg({ text: "https://a.example.com/1 还有 https://b.example.com/2" }));
    expect(parsed).toEqual({
      kind: "url",
      url: "https://a.example.com/1",
      note: "还有 https://b.example.com/2",
    });
  });

  it("紧贴链接的中英文句读被剥掉（否则会污染幂等键）", () => {
    expect(parseTelegramMessage(msg({ text: "看这个 https://example.com/a。" }))).toEqual({
      kind: "url",
      url: "https://example.com/a",
      note: "看这个",
    });
  });
});

describe("parseTelegramMessage — entities", () => {
  it("text_link：真实地址只在 entity 上，锚文本从备注里剔除", () => {
    const parsed = parseTelegramMessage(
      msg({
        text: "点这里 后面还有 https://raw.example.com/y",
        entities: [{ type: "text_link", offset: 0, length: 3, url: "https://link.example.com/x" }],
      }),
    );
    expect(parsed).toEqual({
      kind: "url",
      url: "https://link.example.com/x",
      note: "后面还有 https://raw.example.com/y",
    });
  });

  it("url entity 按 offset 取子串", () => {
    expect(
      parseTelegramMessage(
        msg({ text: "备注 https://example.com/z", entities: [{ type: "url", offset: 3, length: 21 }] }),
      ),
    ).toEqual({ kind: "url", url: "https://example.com/z", note: "备注" });
  });

  it("裸域名 entity 不算链接，回落到正则找到的 http 链接", () => {
    const parsed = parseTelegramMessage(
      msg({
        text: "example.com 真正的是 https://real.example.com/x",
        entities: [{ type: "url", offset: 0, length: 11 }],
      }),
    );
    expect(parsed).toEqual({ kind: "url", url: "https://real.example.com/x", note: "example.com 真正的是" });
  });

  it("非 http scheme 的 text_link 不采信", () => {
    expect(
      parseTelegramMessage(
        msg({ text: "戳我", entities: [{ type: "text_link", offset: 0, length: 2, url: "tg://user?id=1" }] }),
      ),
    ).toEqual({ kind: "text", text: "戳我" });
  });

  it("mention/bold 之类 entity 一律忽略", () => {
    expect(
      parseTelegramMessage(msg({ text: "@somebody 说得对", entities: [{ type: "mention", offset: 0, length: 9 }] })),
    ).toEqual({ kind: "text", text: "@somebody 说得对" });
  });
});

describe("parseTelegramMessage — 纯文字与不支持类型", () => {
  it("无链接的文字 → text item（trim 后）", () => {
    expect(parseTelegramMessage(msg({ text: "  随手记一句  " }))).toEqual({ kind: "text", text: "随手记一句" });
  });

  it.each(["photo", "document", "sticker", "video", "voice", "animation"])(
    "%s 消息 → unsupported（要回执，不入账）",
    (kind) => {
      expect(parseTelegramMessage(msg({ [kind]: [{}] }))).toEqual({ kind: "unsupported" });
    },
  );

  it("带 caption 的图片仍是 unsupported —— caption 不是 text", () => {
    expect(parseTelegramMessage(msg({ photo: [{}], caption: "https://example.com/a" }))).toEqual({
      kind: "unsupported",
    });
  });

  it("既无 text 又无媒体的服务消息 → ignore（不回执、只推进 offset）", () => {
    expect(parseTelegramMessage(msg({ new_chat_members: [{ id: 1 }] }))).toEqual({ kind: "ignore" });
    expect(parseTelegramMessage(msg({ text: "   " }))).toEqual({ kind: "ignore" });
  });
});

describe("findFirstHttpUrl", () => {
  it("没有 http 链接时返回 null", () => {
    expect(findFirstHttpUrl("就是一句话，example.com 也不算")).toBeNull();
  });

  it("返回的区间能把链接从原文里切掉", () => {
    const text = "前 https://example.com/a 后";
    const hit = findFirstHttpUrl(text);
    expect(hit).not.toBeNull();
    expect(text.slice(hit!.start, hit!.end)).toBe("https://example.com/a");
  });
});

describe("backoffDelayMs", () => {
  it("1s 起、60s 封顶", () => {
    expect(backoffDelayMs(1, () => 1)).toBe(1_000);
    expect(backoffDelayMs(2, () => 1)).toBe(2_000);
    expect(backoffDelayMs(7, () => 1)).toBe(60_000);
    expect(backoffDelayMs(30, () => 1)).toBe(60_000);
  });

  it("半抖动：最低不小于档位的一半", () => {
    expect(backoffDelayMs(1, () => 0)).toBe(500);
    expect(backoffDelayMs(7, () => 0)).toBe(30_000);
    expect(backoffDelayMs(3, () => 0.5)).toBe(3_000);
  });
});

describe("脱敏", () => {
  it("代理凭证段被抹掉，端口与路径保留", () => {
    expect(maskProxyUrl("http://alex:s3cret@proxy.example.com:7890")).toBe(
      "http://***:***@proxy.example.com:7890",
    );
    expect(maskProxyUrl("socks5://127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080");
  });

  it("错误文本里的 bot token 与代理凭证同时脱敏", () => {
    const token = "123456:AAH-secret-token";
    const proxy = "http://alex:s3cret@proxy.example.com:7890";
    const out = redactSecrets(`连 https://api.telegram.org/bot${token}/getUpdates 经 ${proxy} 失败`, {
      botToken: token,
      proxyUrl: proxy,
    });
    expect(out).not.toContain(token);
    expect(out).not.toContain("s3cret");
    expect(out).toContain("/bot***/getUpdates");
    expect(out).toContain("http://***:***@proxy.example.com:7890");
  });
});

describe("命令消息（/ 开头）", () => {
  it("/start 是命令不是随手记", () => {
    expect(parseTelegramMessage({ text: "/start" })).toEqual({ kind: "command", command: "start" });
  });
  it("带参数的命令同样是命令", () => {
    expect(parseTelegramMessage({ text: "/status now" })).toEqual({ kind: "command", command: "status" });
  });
  it("斜杠不在开头不算命令", () => {
    expect(parseTelegramMessage({ text: "看看 a/b 测试怎么做" })).toEqual({
      kind: "text",
      text: "看看 a/b 测试怎么做",
    });
  });
});
