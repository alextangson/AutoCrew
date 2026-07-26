/**
 * event-hub.test.ts — 事件总线：落盘/广播/回放/观测层吞错语义
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initEventHub, emitEngineEvent, readRecentEvents } from "./event-hub.js";
import type { EngineEvent } from "./event-hub.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-events-"));
});

afterEach(async () => {
  initEventHub(() => {});
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("event hub", () => {
  it("emit：盖时间戳、落盘 JSONL、广播给订阅者", async () => {
    const seen: EngineEvent[] = [];
    initEventHub((e) => seen.push(e));
    const e = await emitEngineEvent({ role: "writer", kind: "work", label: "编剧正在写稿" }, dir);
    expect(e.ts).toBeTruthy();
    expect(seen).toHaveLength(1);
    expect(seen[0].label).toBe("编剧正在写稿");
    const raw = await fs.readFile(path.join(dir, "events.jsonl"), "utf-8");
    expect(raw).toContain("编剧正在写稿");
  });

  it("广播抛错不影响 emit 完成（观测层吞错）", async () => {
    initEventHub(() => {
      throw new Error("boom");
    });
    await expect(emitEngineEvent({ role: "system", kind: "x", label: "l" }, dir)).resolves.toBeTruthy();
  });

  it("readRecentEvents：尾部截取保序 + 坏行跳过 + 无文件返回空", async () => {
    expect(await readRecentEvents(dir)).toEqual([]);
    for (let i = 0; i < 5; i++) {
      await emitEngineEvent({ role: "system", kind: "k", label: `e${i}` }, dir);
    }
    await fs.appendFile(path.join(dir, "events.jsonl"), "not-json\n{\"broken\":true}\n");
    const events = await readRecentEvents(dir, 3);
    expect(events.map((e) => e.label)).toEqual(["e2", "e3", "e4"]);
  });
});
