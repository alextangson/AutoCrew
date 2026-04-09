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
