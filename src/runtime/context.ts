/**
 * ToolContext — shared state across tool invocations within a session.
 *
 * Inspired by Claude Code's State Manager. Provides:
 * - Session-scoped workspace state (activeContentId, activeTopicId)
 * - Plugin config injection (dataDir, gemini key, etc.)
 * - Audit trail for debugging
 */
import path from "node:path";

// --- Types ---

export interface PluginConfig {
  data_dir?: string;
  pro_api_key?: string;
  pro_api_url?: string;
  gateway_url?: string;
  gemini_api_key?: string;
  gemini_model?: string;
  [key: string]: unknown;
}

export interface WorkspaceState {
  /** Currently active content id (set by content save/get/update) */
  activeContentId?: string;
  /** Currently active topic id (set by topic create) */
  activeTopicId?: string;
  /** Last tool invocation result (for chaining) */
  lastToolResult?: unknown;
  /** Last tool name that was executed */
  lastToolName?: string;
}

export interface AuditEntry {
  tool: string;
  action?: string;
  timestamp: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface ToolContext {
  /** Unique session identifier */
  sessionId: string;
  /** Resolved data directory path */
  dataDir: string;
  /** Plugin configuration */
  config: PluginConfig;
  /** Cross-tool workspace state */
  workspace: WorkspaceState;
  /** Audit log for this session */
  audit: AuditEntry[];
}

// --- Factory ---

let _activeContext: ToolContext | null = null;

function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveDataDir(config?: PluginConfig): string {
  if (config?.data_dir) return config.data_dir;
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return path.join(home, ".autocrew");
}

/**
 * Create a new ToolContext. Called once per plugin registration or MCP session.
 */
export function createContext(config?: PluginConfig): ToolContext {
  const ctx: ToolContext = {
    sessionId: generateSessionId(),
    dataDir: resolveDataDir(config),
    config: config || {},
    workspace: {},
    audit: [],
  };
  _activeContext = ctx;
  return ctx;
}

/**
 * Get the active context. Returns null if no context has been created.
 */
export function getActiveContext(): ToolContext | null {
  return _activeContext;
}

/**
 * Update workspace state. Merges with existing state.
 */
export function updateWorkspace(ctx: ToolContext, update: Partial<WorkspaceState>): void {
  Object.assign(ctx.workspace, update);
}

/**
 * Record an audit entry.
 */
export function recordAudit(ctx: ToolContext, entry: AuditEntry): void {
  ctx.audit.push(entry);
  // Keep last 100 entries to avoid memory bloat
  if (ctx.audit.length > 100) {
    ctx.audit.splice(0, ctx.audit.length - 100);
  }
}

/**
 * Resolve the Gemini API key from config or environment.
 */
export function resolveGeminiKey(ctx: ToolContext): string | undefined {
  return (ctx.config.gemini_api_key as string) || process.env.GEMINI_API_KEY || undefined;
}

/**
 * Resolve the Gemini model preference.
 */
export function resolveGeminiModel(ctx: ToolContext): string {
  return (ctx.config.gemini_model as string) || "auto";
}

/**
 * Resolve the OpenClaw Gateway URL from config or environment.
 */
export function resolveGatewayUrl(ctx: ToolContext): string {
  return (ctx.config.gateway_url as string) || process.env.AUTOCREW_GATEWAY_URL || "http://127.0.0.1:18789";
}
