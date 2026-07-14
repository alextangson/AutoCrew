import { describe, expect, it } from "vitest";
import { LocalSessionAuth, SESSION_COOKIE } from "./server-auth.js";

describe("LocalSessionAuth", () => {
  it("exchanges the boot token for a short-lived cookie session", () => {
    const auth = new LocalSessionAuth("boot-secret", new Set(["http://127.0.0.1:4317"]));
    const issued = auth.issueSession("boot-secret");
    expect(issued).not.toBeNull();
    expect(auth.issueSession("boot-secret")).toBeNull();
    expect(auth.authenticate({ cookie: `${SESSION_COOKIE}=${issued!.sessionId}` })).toBe("session");
    expect(auth.cookieHeader(issued!.sessionId)).toContain("HttpOnly; SameSite=Strict");
  });

  it("never accepts a wrong boot token or an expired session", () => {
    let now = 1_000;
    const auth = new LocalSessionAuth("boot-secret", new Set(), 100, () => now);
    expect(auth.issueSession("wrong")).toBeNull();
    const issued = auth.issueSession("boot-secret")!;
    now += 101;
    expect(auth.authenticate({ cookie: `${SESSION_COOKIE}=${issued.sessionId}` })).toBeNull();
  });

  it("accepts explicit bearer automation and rejects unknown origins", () => {
    const auth = new LocalSessionAuth(
      "one-time-browser-token",
      new Set(["http://localhost:4317"]),
      undefined,
      undefined,
      "persistent-cli-token",
    );
    expect(auth.authenticate({ authorization: "Bearer persistent-cli-token" })).toBe("bearer");
    expect(auth.authenticate({ authorization: "Bearer one-time-browser-token" })).toBeNull();
    expect(auth.originAllowed("http://localhost:4317")).toBe(true);
    expect(auth.originAllowed("https://attacker.example")).toBe(false);
  });

  it("keeps a browser session valid across server restarts", () => {
    const origins = new Set(["http://127.0.0.1:4317"]);
    const firstProcess = new LocalSessionAuth(
      "first-boot-token",
      origins,
      undefined,
      undefined,
      "persistent-server-token",
    );
    const issued = firstProcess.issueSession("first-boot-token")!;

    const restartedProcess = new LocalSessionAuth(
      "second-boot-token",
      origins,
      undefined,
      undefined,
      "persistent-server-token",
    );
    expect(restartedProcess.authenticate({ cookie: `${SESSION_COOKIE}=${issued.sessionId}` })).toBe("session");
  });

  it("invalidates browser sessions when the persistent server token is rotated", () => {
    const firstProcess = new LocalSessionAuth("boot", new Set(), undefined, undefined, "old-server-token");
    const issued = firstProcess.issueSession("boot")!;
    const rotatedProcess = new LocalSessionAuth("next-boot", new Set(), undefined, undefined, "new-server-token");
    expect(rotatedProcess.authenticate({ cookie: `${SESSION_COOKIE}=${issued.sessionId}` })).toBeNull();
  });
});
