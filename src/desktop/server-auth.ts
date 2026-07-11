import { randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "autocrew_session";

export type AuthMethod = "session" | "bearer";

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function readCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export interface SessionHeaders {
  authorization?: string | string[];
  cookie?: string | string[];
}

/**
 * Browser-facing auth for the localhost dashboard.
 *
 * The persistent boot token is accepted only during a same-origin session
 * exchange (or as an Authorization bearer for explicit CLI automation). The
 * browser receives a short-lived, HttpOnly, SameSite=Strict session cookie, so
 * third-party pages cannot steal the persistent token through a script tag.
 */
export class LocalSessionAuth {
  private readonly sessions = new Map<string, number>();
  private bootTokenAvailable = true;

  constructor(
    private readonly bootToken: string,
    private readonly allowedOrigins: ReadonlySet<string>,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
    private readonly automationToken = bootToken,
  ) {}

  originAllowed(origin: string | undefined): boolean {
    return typeof origin === "string" && this.allowedOrigins.has(origin);
  }

  issueSession(token: string): { sessionId: string; expiresAt: string } | null {
    if (!this.bootTokenAvailable || !constantTimeEqual(token, this.bootToken)) return null;
    this.bootTokenAvailable = false;
    this.sweepExpired();
    const sessionId = randomBytes(32).toString("hex");
    const expires = this.now() + this.ttlMs;
    this.sessions.set(sessionId, expires);
    return { sessionId, expiresAt: new Date(expires).toISOString() };
  }

  authenticate(headers: SessionHeaders): AuthMethod | null {
    const authorization = headerValue(headers.authorization);
    if (authorization.startsWith("Bearer ") && constantTimeEqual(authorization.slice(7), this.automationToken)) {
      return "bearer";
    }

    const sessionId = readCookie(headerValue(headers.cookie), SESSION_COOKIE);
    if (!sessionId) return null;
    const expires = this.sessions.get(sessionId);
    if (!expires || expires <= this.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    return "session";
  }

  cookieHeader(sessionId: string): string {
    const maxAge = Math.max(1, Math.floor(this.ttlMs / 1000));
    return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [id, expires] of this.sessions) {
      if (expires <= now) this.sessions.delete(id);
    }
  }
}
