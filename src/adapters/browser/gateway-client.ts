/**
 * OpenClaw Gateway HTTP Client
 *
 * Communicates with the OpenClaw Gateway to execute browser operations
 * via Chrome Relay. Uses the user's real browser sessions (logged-in state).
 *
 * Gateway default: http://127.0.0.1:18789
 */

const DEFAULT_GATEWAY_URL =
  process.env.AUTOCREW_GATEWAY_URL || "http://127.0.0.1:18789";

const REQUEST_TIMEOUT_MS = 30_000;

export interface GatewayBrowserAction {
  action: "navigate" | "click" | "type" | "screenshot" | "snapshot" | "evaluate";
  url?: string;
  /** Element reference ID (from snapshot) */
  ref?: number;
  /** Text to type */
  text?: string;
  /** JavaScript expression to evaluate */
  expression?: string;
  /** Coordinate-based click */
  coordinate?: [number, number];
}

export interface GatewaySnapshot {
  /** Page URL */
  url: string;
  /** Page title */
  title: string;
  /** Accessibility tree / element list with ref IDs */
  elements: GatewaySnapshotElement[];
  /** Raw page text (truncated) */
  pageText?: string;
}

export interface GatewaySnapshotElement {
  ref: number;
  role: string;
  name: string;
  /** Additional attributes */
  attrs?: Record<string, string>;
}

export interface GatewayBrowserResult {
  ok: boolean;
  /** Snapshot after the action */
  snapshot?: GatewaySnapshot;
  /** Screenshot base64 (if action=screenshot) */
  screenshot?: string;
  /** Evaluation result (if action=evaluate) */
  value?: unknown;
  error?: string;
}

export interface GatewaySession {
  id: string;
  /** Tab URL */
  url: string;
  title: string;
}

export class GatewayClient {
  readonly baseUrl: string;

  constructor(gatewayUrl?: string) {
    this.baseUrl = (gatewayUrl || DEFAULT_GATEWAY_URL).replace(/\/+$/, "");
  }

  /** Check if the Gateway is running and reachable */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Execute a browser action through the Gateway */
  async browser(action: GatewayBrowserAction): Promise<GatewayBrowserResult> {
    const res = await fetch(`${this.baseUrl}/tools/browser`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Gateway returned ${res.status}: ${text}` };
    }

    try {
      const data = await res.json();
      return { ok: true, ...data };
    } catch {
      return { ok: false, error: "Gateway returned non-JSON response" };
    }
  }

  /** Navigate to a URL and return a snapshot */
  async navigate(url: string): Promise<GatewayBrowserResult> {
    return this.browser({ action: "navigate", url });
  }

  /** Take a page snapshot (accessibility tree with element refs) */
  async snapshot(): Promise<GatewayBrowserResult> {
    return this.browser({ action: "snapshot" });
  }

  /** Click an element by ref ID */
  async click(ref: number): Promise<GatewayBrowserResult> {
    return this.browser({ action: "click", ref });
  }

  /** Type text into the focused element */
  async type(text: string): Promise<GatewayBrowserResult> {
    return this.browser({ action: "type", text });
  }

  /** Take a screenshot (returns base64 PNG) */
  async screenshot(): Promise<GatewayBrowserResult> {
    return this.browser({ action: "screenshot" });
  }

  /** Evaluate a JavaScript expression in the page context */
  async evaluate(expression: string): Promise<GatewayBrowserResult> {
    return this.browser({ action: "evaluate", expression });
  }

  /** List active browser sessions */
  async listSessions(): Promise<GatewaySession[]> {
    try {
      const res = await fetch(`${this.baseUrl}/sessions`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return [];
      return (await res.json()) as GatewaySession[];
    } catch {
      return [];
    }
  }
}
