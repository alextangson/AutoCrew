/**
 * run-log.test.ts — 运行日志:读写往返、分组、脱敏、截断、保留期、吞错。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendRunLog, listRuns, readRun, redactSecrets, createRunRecorder } from "./run-log.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-runlog-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const base = {
  kind: "tool" as const,
  agent: "writer",
  name: "submit_script",
  durationMs: 12,
  ok: true,
  input: '{"x":1}',
  output: "done",
};

describe("appendRunLog / listRuns / readRun", () => {
  it("追加 → 按 runId 聚合 → 明细按 seq 有序", async () => {
    await appendRunLog(dir, { ...base, runId: "run-a", kind: "llm", name: "model-x", tokens: 100 });
    await appendRunLog(dir, { ...base, runId: "run-a" });
    await appendRunLog(dir, { ...base, runId: "run-b", ok: false, error: "boom" });

    const runs = await listRuns(dir);
    expect(runs).toHaveLength(2);
    const a = runs.find((r) => r.runId === "run-a")!;
    expect(a).toMatchObject({ llmCalls: 1, toolCalls: 1, totalTokens: 100, errorCount: 0, firstModel: "model-x" });
    expect(a.agents).toEqual(["writer"]);
    const b = runs.find((r) => r.runId === "run-b")!;
    expect(b.errorCount).toBe(1);

    const records = await readRun(dir, "run-a");
    expect(records.map((r) => r.seq)).toEqual([1, 2]);
    expect(records[0].name).toBe("model-x");
  });

  it("密钥字段落盘前脱敏(_geminiApiKey / api_key / token)", async () => {
    await appendRunLog(dir, {
      ...base,
      runId: "run-secret",
      input: '{"_geminiApiKey":"AIzaSecret123","api_key":"sk-verysecret","topic":"正常内容","x_token":"tok123"}',
      output: '{"apiKeyMasked":"ok"}',
    });
    const [rec] = await readRun(dir, "run-secret");
    expect(rec.input).not.toContain("AIzaSecret123");
    expect(rec.input).not.toContain("sk-verysecret");
    expect(rec.input).not.toContain("tok123");
    expect(rec.input).toContain("<redacted>");
    expect(rec.input).toContain("正常内容");
  });

  it("超长内容截断并打 truncated 标", async () => {
    await appendRunLog(dir, { ...base, runId: "run-long", input: "字".repeat(20_000), output: "y" });
    const [rec] = await readRun(dir, "run-long");
    expect(rec.truncated).toBe(true);
    expect(rec.input.length).toBeLessThan(17_000);
    expect(rec.input).toContain("截断");
  });

  it("保留期:超过 14 天的日志文件在下次追加时清掉", async () => {
    const runsDir = path.join(dir, "logs", "runs");
    await fs.mkdir(runsDir, { recursive: true });
    await fs.writeFile(path.join(runsDir, "2020-01-01.jsonl"), "{}\n", "utf-8");
    await appendRunLog(dir, { ...base, runId: "run-new" });
    const files = await fs.readdir(runsDir);
    expect(files).not.toContain("2020-01-01.jsonl");
    expect(files.some((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))).toBe(true);
  });

  it("dataDir 不可写/未知 → 静默吞,不抛(观测层不破坏执行层)", async () => {
    await expect(appendRunLog("/dev/null/nope", { ...base, runId: "x" })).resolves.toBeUndefined();
  });

  it("坏行不清空读视图", async () => {
    await appendRunLog(dir, { ...base, runId: "run-ok" });
    const today = new Date().toISOString().slice(0, 10);
    await fs.appendFile(path.join(dir, "logs", "runs", `${today}.jsonl`), "not-json\n", "utf-8");
    await appendRunLog(dir, { ...base, runId: "run-ok" });
    const records = await readRun(dir, "run-ok");
    expect(records).toHaveLength(2);
  });
});

describe("redactSecrets", () => {
  it("大小写不敏感,值含转义也整段遮蔽", () => {
    const out = redactSecrets('{"API_KEY":"a\\"b","GeminiToken":"t","normal":"keep"}');
    expect(out).not.toContain('a\\"b');
    expect(out).toContain('"normal":"keep"');
  });
});

describe("createRunRecorder", () => {
  it("dataDir 缺省 → no-op(不建目录不写文件)", async () => {
    const rec = createRunRecorder(undefined, { runId: "run-x" });
    rec.llm({ model: "m", durationMs: 1, ok: true, input: "i", output: "o" });
    await new Promise((r) => setTimeout(r, 20));
    await expect(fs.access(path.join(dir, "logs"))).rejects.toThrow();
  });

  it("usedPatternIds 随每条记录落盘(拆解卡归因);缺省/空则字段不出现", async () => {
    createRunRecorder(dir, { runId: "run-pat", agent: "writer", usedPatternIds: ["pat-1", "pat-2"] })
      .llm({ model: "m1", durationMs: 5, ok: true, input: "in", output: "out" });
    createRunRecorder(dir, { runId: "run-nopat", agent: "writer", usedPatternIds: [] })
      .llm({ model: "m1", durationMs: 5, ok: true, input: "in", output: "out" });
    await new Promise((r) => setTimeout(r, 50));

    const [withCards] = await readRun(dir, "run-pat");
    expect(withCards.usedPatternIds).toEqual(["pat-1", "pat-2"]);
    const [without] = await readRun(dir, "run-nopat");
    expect(without.usedPatternIds).toBeUndefined();
  });

  it("有 dataDir → llm/tool 都落盘,共享 runId 与 agent", async () => {
    const rec = createRunRecorder(dir, { runId: "run-rec", agent: "cover-designer" });
    rec.llm({ model: "m1", durationMs: 5, ok: true, tokens: 9, input: "in", output: "out" });
    rec.tool({ name: "submit_cover_plan", durationMs: 2, ok: true, input: "{}", output: "已收到" });
    await new Promise((r) => setTimeout(r, 50));
    const records = await readRun(dir, "run-rec");
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.agent === "cover-designer")).toBe(true);
    expect(records[0].kind).toBe("llm");
    expect(records[1].kind).toBe("tool");
  });
});
