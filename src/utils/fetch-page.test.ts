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

  it("drops content after an unclosed script tag", async () => {
    const fetchImpl = (async () =>
      htmlResponse("<body><p>正文在前。</p><script>evil_payload(1)")) as typeof fetch;
    const page = await fetchPageText("https://example.com/c", { fetchImpl });
    expect(page.text).toContain("正文在前");
    expect(page.text).not.toContain("evil_payload");
  });

  it("caps text length", async () => {
    const fetchImpl = (async () => htmlResponse("<body>" + "长".repeat(20000) + "</body>")) as typeof fetch;
    const page = await fetchPageText("https://example.com/b", { fetchImpl, maxChars: 500 });
    expect(page.text.length).toBeLessThanOrEqual(500);
    expect(page.truncated).toBe(true);
  });

  it("flags garbled pages and leaves clean pages unflagged", async () => {
    const garbledImpl = (async () =>
      htmlResponse("<body>" + "�".repeat(50) + "正文</body>")) as typeof fetch;
    const garbledPage = await fetchPageText("https://example.com/g", { fetchImpl: garbledImpl });
    expect(garbledPage.garbled).toBe(true);

    const cleanImpl = (async () => htmlResponse("<body>正常正文</body>")) as typeof fetch;
    const cleanPage = await fetchPageText("https://example.com/ok", { fetchImpl: cleanImpl });
    expect(cleanPage.garbled).toBeUndefined();
  });
});
