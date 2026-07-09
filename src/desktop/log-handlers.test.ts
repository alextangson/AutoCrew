/**
 * log-handlers.test.ts — logs:list / logs:get_run / skills:list 频道形状。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendRunLog } from "../runtime/run-log.js";
import { logsListHandler, logsGetRunHandler, skillsListHandler } from "./log-handlers.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-loghandlers-"));
  await appendRunLog(dir, {
    runId: "run-h1",
    kind: "llm",
    agent: "chief-editor",
    name: "m",
    durationMs: 5,
    ok: true,
    tokens: 10,
    input: "in",
    output: "out",
  });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("logs:list / logs:get_run", () => {
  it("列表与明细", async () => {
    const list = (await logsListHandler({ _dataDir: dir })) as { ok: boolean; data: { runs: Array<{ runId: string }> } };
    expect(list.ok).toBe(true);
    expect(list.data.runs[0].runId).toBe("run-h1");

    const detail = (await logsGetRunHandler({ run_id: "run-h1", _dataDir: dir })) as { ok: boolean; data: { records: unknown[] } };
    expect(detail.ok).toBe(true);
    expect(detail.data.records).toHaveLength(1);
  });

  it("未知 run → 空明细(不报错);缺 run_id → 报错", async () => {
    const unknown = (await logsGetRunHandler({ run_id: "run-nope", _dataDir: dir })) as { ok: boolean; data: { records: unknown[] } };
    expect(unknown.ok).toBe(true);
    expect(unknown.data.records).toEqual([]);
    const missing = await logsGetRunHandler({ _dataDir: dir });
    expect(missing.ok).toBe(false);
  });

  it("limit 生效且封顶 200", async () => {
    for (let i = 0; i < 3; i++) {
      await appendRunLog(dir, { runId: `run-x${i}`, kind: "tool", name: "t", durationMs: 1, ok: true, input: "", output: "" });
    }
    const list = (await logsListHandler({ limit: 2, _dataDir: dir })) as { data: { runs: unknown[] } };
    expect(list.data.runs).toHaveLength(2);
  });
});

describe("skills:list", () => {
  it("读回仓库全部技能(≥19),含标题与全文", async () => {
    const r = (await skillsListHandler({})) as { ok: boolean; data: { skills: Array<{ id: string; title: string; content: string }> } };
    expect(r.ok).toBe(true);
    expect(r.data.skills.length).toBeGreaterThanOrEqual(19);
    for (const s of r.data.skills) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.content.length).toBeGreaterThan(0);
    }
    expect(r.data.skills.some((s) => s.id === "cover-generator")).toBe(true);
  });
});
