/** 登录跨重启（1b §9）：cookie 名按端口分、失效 token + 有效 cookie 不报错 */
import { describe, expect, it } from "vitest";
import { LocalSessionAuth, SESSION_COOKIE, sessionCookieName } from "./server-auth.js";

const auth = (port: number, boot = "boot") =>
  new LocalSessionAuth(boot, new Set([`http://127.0.0.1:${port}`]), undefined, undefined, boot, () => null, "secret", sessionCookieName(port));

describe("cookie 名带端口（B21）", () => {
  it("4317 与 4320 的会话 cookie 名不同：预览服务的登录顶不掉正式服务", () => {
    const main = auth(4317), preview = auth(4320, "boot2");
    const a = main.issueSession("boot")!, b = preview.issueSession("boot2")!;
    expect(main.cookieHeader(a.sessionId)).toMatch(/^autocrew_session_4317=/);
    expect(preview.cookieHeader(b.sessionId)).toMatch(/^autocrew_session_4320=/);
    // 浏览器按主机存 cookie：两个都在同一个 Cookie 头里，各认各的
    const both = `autocrew_session_4320=${encodeURIComponent(b.sessionId)}; autocrew_session_4317=${encodeURIComponent(a.sessionId)}`;
    expect(main.authenticate({ cookie: both })).toBe("session");
  });

  it("旧名 cookie 不认；响应里给清旧名的头", () => {
    const main = auth(4317);
    const s = main.issueSession("boot")!;
    expect(main.authenticate({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(s.sessionId)}` })).toBeNull();
    expect(main.clearLegacyCookieHeader()).toBe(`${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  });
});

describe("地址栏 token 已失效但 cookie 有效（B22）", () => {
  it("交换时认出已有会话：不报错、不另发 cookie；两者都无效才拒", () => {
    const main = auth(4317);
    const s = main.issueSession("boot")!;
    const cookie = `autocrew_session_4317=${encodeURIComponent(s.sessionId)}`;
    expect(main.exchange("boot", { cookie })).toEqual({ status: "existing" });
    expect(main.exchange("stale-token", { cookie: "" })).toBeNull();
  });
});
