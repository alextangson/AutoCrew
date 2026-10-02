import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "autocrew_session";

/**
 * 会话 cookie 名带端口（1b §9）：浏览器按主机存 cookie、不分端口，同名时预览服务（4318–4321）
 * 的登录会顶掉 4317 的。每个端口一个名字，各认各的。
 */
export function sessionCookieName(port: number): string {
  return `${SESSION_COOKIE}_${port}`;
}

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
    /**
     * 会话签名密钥（spec 2026-09-28 §3 D）：不能是交给自动化客户端的 server-token——
     * 否则拿到 server-token 的任何进程都能伪造浏览器会话，冒充创始人在工作台批规则。
     * 缺省是本进程随机值（重启后旧会话失效）；服务端从 host 状态目录读一份持久的独立密钥注入。
     */
    private readonly sessionSecret: string = randomBytes(32).toString("hex"),
    /** 这个服务认的 cookie 名（服务端传 `sessionCookieName(port)`）；旧的不带端口的名字不再认 */
    private readonly cookieName: string = SESSION_COOKIE,
  ) {}

  originAllowed(origin: string | undefined): boolean {
    return typeof origin === "string" && this.allowedOrigins.has(origin);
  }

  issueSession(token: string): { sessionId: string; expiresAt: string } | null {
    if (!this.bootTokenAvailable || !constantTimeEqual(token, this.bootToken)) return null;
    this.bootTokenAvailable = false;
    const expires = this.now() + this.ttlMs;
    // 会话由持久的独立会话密钥签名（不是交给自动化客户端的 server-token）。服务重启后同一浏览器 cookie
    // 仍可验证；轮换 server-token 或会话密钥都会让旧会话立即失效。
    const payload = `${randomBytes(32).toString("hex")}.${expires}`;
    const signature = this.sign(payload);
    const sessionId = `${payload}.${signature}`;
    return { sessionId, expiresAt: new Date(expires).toISOString() };
  }

  /**
   * 地址栏 token 换会话（1b §9）：token 有效 → 发新会话；token 已失效但请求带着有效会话 cookie
   * （刷新了一个还留着旧 token 的地址）→ `existing`，不报错、不另发；两者都无效 → null。
   */
  exchange(token: string, headers: SessionHeaders): ({ status: "issued" } & { sessionId: string; expiresAt: string }) | { status: "existing" } | null {
    const issued = this.issueSession(token);
    if (issued) return { status: "issued", ...issued };
    return this.identify({ cookie: headers.cookie })?.method === "session" ? { status: "existing" } : null;
  }

  /** 清掉旧的不带端口的会话 cookie（它不再被认，留着只会让人以为还登录着） */
  clearLegacyCookieHeader(): string {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }

  /**
   * 看板与 /api/* 的门：只认本地主体（浏览器会话 + server-token）。
   * 命名宿主 token 只属于 /mcp——那里有 host-policy 按宿主限权；放它进 /api/invoke
   * 等于让受限的 codex 工位绕过白名单直接调任意 IPC 通道。/mcp 走 `identify`。
   */
  authenticate(headers: SessionHeaders): AuthMethod | null {
    const identity = this.identify(headers);
    return identity?.subject === LOCAL_SUBJECT ? identity.method : null;
  }

  /** 与 `authenticate` 同一套判定，另外回答「这是谁」——MCP 归因的唯一来源。 */
  identify(headers: SessionHeaders): AuthIdentity | null {
    const authorization = headerValue(headers.authorization);
    if (authorization.startsWith("Bearer ")) {
      const token = authorization.slice(7);
      if (constantTimeEqual(token, this.automationToken)) return { method: "bearer", subject: LOCAL_SUBJECT };
      const host = this.lookupHost(token);
      // 命名 token 永远不能冒充本地主体：tokens/local-user.token 这种文件不给本地权限
      if (host && host !== LOCAL_SUBJECT) return { method: "bearer", subject: host };
    }

    const sessionId = readCookie(headerValue(headers.cookie), this.cookieName);
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
    return `${this.cookieName}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
  }

  private sign(payload: string): string {
    // 密钥 = 独立会话密钥 + server-token：伪造需要会话密钥；轮换 server-token 仍让旧会话全部失效
    return createHmac("sha256", `${this.sessionSecret}\0${this.automationToken}`).update(payload).digest("base64url");
  }
}
