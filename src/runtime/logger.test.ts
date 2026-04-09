import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionLogger } from "./logger.js";

describe("SessionLogger", () => {
  let tmpDir: string;
  let logger: SessionLogger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-log-"));
    logger = new SessionLogger(tmpDir, "test-session-001");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes audit entries as JSONL", async () => {
    await logger.audit({
      tool: "autocrew_content",
      action: "save",
      timestamp: "2026-04-09T10:00:00Z",
      durationMs: 150,
      ok: true,
    });

    const logPath = path.join(tmpDir, "logs", "test-session-001", "audit.jsonl");
    const raw = await fs.readFile(logPath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).tool).toBe("autocrew_content");
  });

  it("writes events as JSONL", async () => {
    await logger.event({
      type: "content:created",
      timestamp: "2026-04-09T10:00:00Z",
      data: { contentId: "abc" },
    });

    const logPath = path.join(tmpDir, "logs", "test-session-001", "events.jsonl");
    const raw = await fs.readFile(logPath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).type).toBe("content:created");
  });

  it("writes tool IO as JSONL", async () => {
    await logger.toolIO({
      tool: "autocrew_content",
      action: "draft",
      input: { topic_title: "AI编程", platform: "xhs" },
      output: { ok: true, writingInstructions: "..." },
      durationMs: 200,
      timestamp: "2026-04-09T10:00:00Z",
    });

    const logPath = path.join(tmpDir, "logs", "test-session-001", "tool-io.jsonl");
    const raw = await fs.readFile(logPath, "utf-8");
    const entry = JSON.parse(raw.trim());
    expect(entry.tool).toBe("autocrew_content");
    expect(entry.input.topic_title).toBe("AI编程");
    expect(entry.output.ok).toBe(true);
  });

  it("appends multiple entries without overwriting", async () => {
    await logger.audit({ tool: "a", timestamp: "t1", durationMs: 1, ok: true });
    await logger.audit({ tool: "b", timestamp: "t2", durationMs: 2, ok: false, error: "boom" });

    const logPath = path.join(tmpDir, "logs", "test-session-001", "audit.jsonl");
    const lines = (await fs.readFile(logPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
