import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "autocrew_session";

/** 浏览器会话与老 `server-token` 的主体名（P3 §4.1：命名 token 之外的一切都算它）。 */
export const LOCAL_SUBJECT = "local-user";

export type AuthMethod = "session" | "bearer";

/** 认证结果：方法 + 主体。主体就是 MCP 侧的宿主名，`tools/call` 靠它归因。 */
export interface AuthIdentity {
  method: AuthMethod;
  subject: string;
}

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
  private bootTokenAvailable = true;

  constructor(
    private readonly bootToken: string,
    private readonly allowedOrigins: ReadonlySet<string>,
    private readonly ttlMs = 30 * 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
    private readonly automationToken = bootToken,
    /**
     * 命名宿主 token 的反查（`<dataDir>/tokens/<host>.token` → 宿主名）。
     * 注进来而不是直接读盘：这个类是纯逻辑、有单测，不该长出文件系统依赖。
     */
    private readonly lookupHost: (token: string) => string | null = () => null,
  ) {}

  originAllowed(origin: string | undefined): boolean {
    return typeof origin === "string" && this.allowedOrigins.has(origin);
  }

  issueSession(token: string): { sessionId: string; expiresAt: string } | null {
    if (!this.bootTokenAvailable || !constantTimeEqual(token, this.bootToken)) return null;
    this.bootTokenAvailable = false;
    const expires = this.now() + this.ttlMs;
    // 会话改成由持久 automation token 签名的短期凭证。服务重启时内存会清空，
    // 但同一浏览器 cookie 仍可验证；显式轮换 server-token 则会立即让旧会话失效。
    const payload = `${randomBytes(32).toString("hex")}.${expires}`;
    const signature = this.sign(payload);
    const sessionId = `${payload}.${signature}`;
    return { sessionId, expiresAt: new Date(expires).toISOString() };
  }

  authenticate(headers: SessionHeaders): AuthMethod | null {
    return this.identify(headers)?.method ?? null;
  }

  /** 与 `authenticate` 同一套判定，另外回答「这是谁」——MCP 归因的唯一来源。 */
  identify(headers: SessionHeaders): AuthIdentity | null {
    const authorization = headerValue(headers.authorization);
    if (authorization.startsWith("Bearer ")) {
      const token = authorization.slice(7);
      if (constantTimeEqual(token, this.automationToken)) return { method: "bearer", subject: LOCAL_SUBJECT };
      const host = this.lookupHost(token);
      if (host) return { method: "bearer", subject: host };
    }

    const sessionId = readCookie(headerValue(headers.cookie), SESSION_COOKIE);
    if (!sessionId) return null;
    const parts = sessionId.split(".");
    if (parts.length !== 3) return null;
    const [nonce, expiresText, signature] = parts;
    const payload = `${nonce}.${expiresText}`;
    if (!constantTimeEqual(signature, this.sign(payload))) return null;
    const expires = Number(expiresText);
    if (!Number.isFinite(expires) || expires <= this.now()) return null;
    return { method: "session", subject: LOCAL_SUBJECT };
  }

  cookieHeader(sessionId: string): string {
    const maxAge = Math.max(1, Math.floor(this.ttlMs / 1000));
    return `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.automationToken).update(payload).digest("base64url");
  }
}
