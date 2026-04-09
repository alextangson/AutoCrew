/**
 * SessionLogger — persistent JSONL logging for audit entries, events, and tool IO.
 *
 * Writes to {dataDir}/logs/{sessionId}/ with separate files:
 * - audit.jsonl   — tool execution audit trail
 * - events.jsonl  — workflow events
 * - tool-io.jsonl — full tool input/output for debugging
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { AuditEntry } from "./context.js";
import type { AutoCrewEvent } from "./events.js";

export interface ToolIOEntry {
  tool: string;
  action?: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  durationMs: number;
  timestamp: string;
}

export class SessionLogger {
  private sessionDir: string;
  private initialized = false;

  constructor(dataDir: string, sessionId: string) {
    this.sessionDir = path.join(dataDir, "logs", sessionId);
  }

  private async ensureDir(): Promise<void> {
    if (!this.initialized) {
      await fs.mkdir(this.sessionDir, { recursive: true });
      this.initialized = true;
    }
  }

  private async append(filename: string, data: unknown): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify(data) + "\n";
    await fs.appendFile(path.join(this.sessionDir, filename), line, "utf-8");
  }

  async audit(entry: AuditEntry): Promise<void> {
    await this.append("audit.jsonl", entry);
  }

  async event(event: AutoCrewEvent): Promise<void> {
    await this.append("events.jsonl", event);
  }

  async toolIO(entry: ToolIOEntry): Promise<void> {
    await this.append("tool-io.jsonl", entry);
  }
}

/** List all session log directories, newest first */
export async function listLogSessions(dataDir: string): Promise<string[]> {
  const logsDir = path.join(dataDir, "logs");
  try {
    const entries = await fs.readdir(logsDir);
    return entries.sort().reverse();
  } catch {
    return [];
  }
}

/** Delete session logs older than N days */
export async function cleanOldLogs(dataDir: string, maxAgeDays: number): Promise<number> {
  const logsDir = path.join(dataDir, "logs");
  const cutoff = Date.now() - maxAgeDays * 86400000;
  let deleted = 0;
  try {
    const entries = await fs.readdir(logsDir);
    for (const entry of entries) {
      const stat = await fs.stat(path.join(logsDir, entry));
      if (stat.mtimeMs < cutoff) {
        await fs.rm(path.join(logsDir, entry), { recursive: true });
        deleted++;
      }
    }
  } catch { /* logs dir may not exist */ }
  return deleted;
}
