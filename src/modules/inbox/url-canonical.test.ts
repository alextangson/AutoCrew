import { describe, it, expect } from "vitest";
import { canonicalizeUrl, normalizeTextForHash } from "./url-canonical.js";

describe("canonicalizeUrl — x / twitter", () => {
  it("normalizes a user status URL to the canonical i/status form", () => {
    expect(canonicalizeUrl("https://x.com/elonmusk/status/1234567890?s=20&t=abc")).toBe(
      "https://x.com/i/status/1234567890",
    );
  });

  it("maps twitter.com to x.com", () => {
    expect(canonicalizeUrl("https://twitter.com/foo/status/999")).toBe("https://x.com/i/status/999");
  });

  it("handles subdomains and the /i/web/status shape", () => {
    expect(canonicalizeUrl("https://mobile.twitter.com/i/web/status/555?ref_src=x")).toBe(
      "https://x.com/i/status/555",
    );
  });

  it("dedupes the same tweet shared under different handles/params", () => {
    const a = canonicalizeUrl("https://x.com/alice/status/777?utm_source=tg");
    const b = canonicalizeUrl("https://twitter.com/bob/status/777");
    expect(a).toBe(b);
  });

  it("falls back to generic rules for non-status x URLs", () => {
    expect(canonicalizeUrl("https://x.com/someone?utm_source=tg")).toBe("https://x.com/someone");
  });
});

describe("canonicalizeUrl — douyin", () => {
  it("normalizes a /video/<id> URL", () => {
    expect(canonicalizeUrl("https://www.douyin.com/video/7123456789?previous_page=web_code")).toBe(
      "https://www.douyin.com/video/7123456789",
    );
  });

  it("takes the video id from modal_id on profile-share URLs", () => {
    expect(canonicalizeUrl("https://www.douyin.com/user/MS4wLjAB?modal_id=7123456789")).toBe(
      "https://www.douyin.com/video/7123456789",
    );
  });

  it("leaves an unresolved short link to the generic path (no video id to take)", () => {
    // v.douyin.com 短链未解析时不该被瞎归一——上游按约定回退用原始 URL 当键
    expect(canonicalizeUrl("https://v.douyin.com/iAbCdEf/")).toBe("https://v.douyin.com/iAbCdEf/");
  });
});

describe("canonicalizeUrl — generic tracking strip", () => {
  it("strips every param on the explicit list and keeps the rest", () => {
    const url =
      "https://example.com/post?id=42&utm_source=tg&utm_medium=chat&utm_campaign=x" +
      "&fbclid=abc&gclid=def&spm=a1.b2&share_token=tok&ref=friend";
    expect(canonicalizeUrl(url)).toBe("https://example.com/post?id=42&ref=friend");
  });

  it("does not wildcard-delete params outside the list", () => {
    const url = "https://example.com/p?utm=keepme&campaign=keepme&source=keepme";
    expect(canonicalizeUrl(url)).toBe(url);
  });

  it("matches tracking keys case-insensitively", () => {
    expect(canonicalizeUrl("https://example.com/p?UTM_Source=tg&FBCLID=x&a=1")).toBe(
      "https://example.com/p?a=1",
    );
  });

  it("drops the '?' entirely when only tracking params were present", () => {
    expect(canonicalizeUrl("https://example.com/p?utm_source=tg")).toBe("https://example.com/p");
  });

  it("preserves path, fragment and non-tracking param order", () => {
    expect(canonicalizeUrl("https://example.com/a/b?z=1&a=2#frag")).toBe(
      "https://example.com/a/b?z=1&a=2#frag",
    );
  });

  it("is idempotent", () => {
    const once = canonicalizeUrl("https://example.com/post?id=42&utm_source=tg");
    expect(canonicalizeUrl(once)).toBe(once);
  });
});

describe("canonicalizeUrl — bad input is total, never throws", () => {
  it("returns unparseable input trimmed", () => {
    expect(canonicalizeUrl("  not a url  ")).toBe("not a url");
  });

  it("leaves non-http(s) schemes untouched (ingress owns the protocol gate)", () => {
    expect(canonicalizeUrl("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(canonicalizeUrl("ftp://example.com/x?utm_source=a")).toBe("ftp://example.com/x?utm_source=a");
  });

  it("returns empty string for empty input", () => {
    expect(canonicalizeUrl("   ")).toBe("");
  });
});

describe("normalizeTextForHash", () => {
  it("returns a 64-char sha256 hex digest", () => {
    expect(normalizeTextForHash("灵感")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("folds whitespace and trims — same note forwarded twice hashes equal", () => {
    expect(normalizeTextForHash("  做一期  关于\n\tAI 的   选题 ")).toBe(
      normalizeTextForHash("做一期 关于 AI 的 选题"),
    );
  });

  it("treats full-width spaces as whitespace", () => {
    expect(normalizeTextForHash("做一期　选题")).toBe(normalizeTextForHash("做一期 选题"));
  });

  it("keeps case significant", () => {
    expect(normalizeTextForHash("AI 选题")).not.toBe(normalizeTextForHash("ai 选题"));
  });

  it("distinguishes different notes", () => {
    expect(normalizeTextForHash("选题 A")).not.toBe(normalizeTextForHash("选题 B"));
  });
});
