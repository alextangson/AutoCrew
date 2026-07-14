import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIpcHandlers } from "./ipc.js";
import { saveContent, getContent } from "../storage/local-store.js";
import { listDiffs } from "../modules/learnings/diff-tracker.js";

let testDir: string;
const handlers = buildIpcHandlers();

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-adopt-"));
});
afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

async function mkContent() {
  return saveContent({ title: "T", body: "原正文", platform: "wechat_mp", status: "draft_ready", tags: [] }, testDir);
}

describe("draft:adopt_revision", () => {
  it("saves a new version and records learning when before+feedback given", async () => {
    const c = await mkContent();
    const r = await handlers["draft:adopt_revision"]({
      content_id: c.id,
      body: "新正文更口语",
      before: "原正文",
      feedback: "口语一点",
      _dataDir: testDir,
    });
    expect(r.ok).toBe(true);
    const saved = await getContent(c.id, testDir);
    expect(saved?.body).toBe("新正文更口语");
    expect(saved?.versions).toHaveLength(2);
    expect((await listDiffs(undefined, testDir)).length).toBe(1);
  });

  it("does NOT record learning without before (no adopt-gated feedback)", async () => {
    const c = await mkContent();
    const r = await handlers["draft:adopt_revision"]({ content_id: c.id, body: "新正文2", _dataDir: testDir });
    expect(r.ok).toBe(true);
    expect((await listDiffs(undefined, testDir)).length).toBe(0);
  });

  it("rejects missing body / bad id", async () => {
    const c = await mkContent();
    expect((await handlers["draft:adopt_revision"]({ content_id: c.id, _dataDir: testDir })).ok).toBe(false);
    expect((await handlers["draft:adopt_revision"]({ content_id: "nope", body: "x", _dataDir: testDir })).ok).toBe(false);
  });
});
