/**
 * 2026-09-29 事故回归：同一台机器上的多个 AutoCrew 服务共用 ~/.autocrew/chief-editor/runs.json，
 * 新起的服务把别的服务正在跑的轮标中断、还杀了它的进程组。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chiefEditorHome, ownerAlive, RunStore, type RunRecord } from "./run-store.js";

let dir = "";
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
const run = (over: Partial<RunRecord>): RunRecord => ({ turnId: "t1", clientId: "c", conversationId: "conv-1-a", dataDir: "/d", backend: "claude", message: "m", status: "running", startedAt: "", pid: 4715, command: "node adapter", ...over });

describe("总编辑状态按服务隔离", () => {
  it("状态目录跟着本服务的状态目录走（AUTOCREW_LOCAL_DIR）；缺省服务仍是 ~/.autocrew/chief-editor", () => {
    expect(chiefEditorHome("/tmp/preview-lib")).toBe("/tmp/preview-lib/chief-editor");
    const prev = process.env.AUTOCREW_LOCAL_DIR;
    process.env.AUTOCREW_LOCAL_DIR = "/tmp/other-state";
    try { expect(chiefEditorHome()).toBe("/tmp/other-state/chief-editor"); }
    finally { if (prev === undefined) delete process.env.AUTOCREW_LOCAL_DIR; else process.env.AUTOCREW_LOCAL_DIR = prev; }
  });

  it("两个服务共用一个目录：第二个启动时，第一个（还活着）的进行中轮原样保留，进程组不杀", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-server-"));
    const first = { pid: 111, lstart: "Tue Sep 29 13:40:00 2026" };
    const second = { pid: 222, lstart: "Tue Sep 29 13:47:00 2026" };
    new RunStore(dir, first).put(run({}));
    const killed: number[] = [];
    const leftovers = new RunStore(dir, second).recoverOnStartup((pid) => { killed.push(pid); return true; }, (o) => o.pid === first.pid && o.lstart === first.lstart);
    expect(leftovers).toEqual([]);
    expect(killed).toEqual([]);
    expect(new RunStore(dir, second).get("t1")?.status).toBe("running");
  });

  it("主人已经不在（或 pid 被别的进程复用）：才标中断、清进程组", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-server-"));
    new RunStore(dir, { pid: 111, lstart: "old" }).put(run({}));
    const killed: number[] = [];
    const leftovers = new RunStore(dir, { pid: 222, lstart: "new" }).recoverOnStartup((pid) => { killed.push(pid); return true; }, () => false);
    expect(leftovers.map((r) => r.turnId)).toEqual(["t1"]);
    expect(killed).toEqual([4715]);
    expect(ownerAlive({ pid: 111, lstart: "old" }, () => "reused-later")).toBe(false);
  });

  it("每条新记录都记上主人（本服务的 pid + 启动时刻）", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-server-"));
    new RunStore(dir, { pid: 333, lstart: "x" }).put(run({}));
    expect(new RunStore(dir).get("t1")?.owner).toEqual({ pid: 333, lstart: "x" });
  });
});
