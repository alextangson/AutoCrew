import { describe, it, expect } from "vitest";
import { fetchPageText } from "./fetch-page.js";

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

describe("fetchPageText", () => {
  it("rejects non-http(s) urls without fetching", async () => {
    await expect(fetchPageText("file:///etc/passwd")).rejects.toThrow("仅支持 http/https");
    await expect(fetchPageText("not-a-url")).rejects.toThrow("仅支持 http/https");
  });

  it("strips tags/scripts and collapses whitespace", async () => {
    const fetchImpl = (async () =>
      htmlResponse(
        "<html><head><title>测试标题</title><script>evil()</script><style>.x{}</style></head>" +
        "<body><h1>正文标题</h1><p>第一段。</p>\n\n<p>第二段。</p></body></html>",
      )) as typeof fetch;
    const page = await fetchPageText("https://example.com/a", { fetchImpl });
    expect(page.title).toBe("测试标题");
    expect(page.text).toContain("正文标题");
    expect(page.text).toContain("第一段。");
    expect(page.text).not.toContain("evil");
    expect(page.text).not.toContain(".x{}");
    expect(page.text).not.toContain("<p>");
  });

  it("caps text length", async () => {
    const fetchImpl = (async () => htmlResponse("<body>" + "长".repeat(20000) + "</body>")) as typeof fetch;
    const page = await fetchPageText("https://example.com/b", { fetchImpl, maxChars: 500 });
    expect(page.text.length).toBeLessThanOrEqual(500);
    expect(page.truncated).toBe(true);
  });
});
