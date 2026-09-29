/**
 * 2026-09-29 事故回归：同一台机器上的多个 AutoCrew 服务共用 ~/.autocrew/chief-editor/runs.json，
 * 新起的服务把别的服务正在跑的轮标中断、还杀了它的进程组。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentStillThere, chiefEditorHome, ownerAlive, processIdentity, RunStore, startEpoch, type RunRecord } from "./run-store.js";

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
    const first = { pid: 111, start: 1_000 };
    const second = { pid: 222, start: 2_000 };
    new RunStore(dir, first).put(run({}));
    const killed: number[] = [];
    const leftovers = new RunStore(dir, second).recoverOnStartup((pid) => { killed.push(pid); return true; }, (o) => o.pid === first.pid && o.start === first.start);
    expect(leftovers).toEqual([]);
    expect(killed).toEqual([]);
    expect(new RunStore(dir, second).get("t1")?.status).toBe("running");
  });

  it("主人已经不在（或 pid 被别的进程复用）：才标中断、清进程组", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-server-"));
    new RunStore(dir, { pid: 111, start: 1_000 }).put(run({}));
    const killed: number[] = [];
    const leftovers = new RunStore(dir, { pid: 222, start: 2_000 }).recoverOnStartup((pid) => { killed.push(pid); return true; }, () => false);
    expect(leftovers.map((r) => r.turnId)).toEqual(["t1"]);
    expect(killed).toEqual([4715]);
    expect(ownerAlive({ pid: 111, start: 1_000 }, () => 5_000)).toBe(false);
  });

  it("每条新记录都记上主人（本服务的 pid + 启动时刻）", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-server-"));
    new RunStore(dir, { pid: 333, start: 42 }).put(run({}));
    expect(new RunStore(dir).get("t1")?.owner).toEqual({ pid: 333, start: 42 });
  });
});

describe("评审 v1.3 P1：进程身份不随时区 / 语言变", () => {
  it("不同 TZ、不同语言的服务读到的同一个活进程身份一样；ownerAlive 认它还活着", () => {
    const script = `import("${path.resolve("src/desktop/chief-editor/run-store.ts").replace(/\\/g, "/")}").then((m) => console.log(JSON.stringify(m.processIdentity(${process.pid}))))`;
    const read = (TZ: string, LANG: string) => execFileSync(process.execPath, ["--import", "tsx", "-e", script], { env: { ...process.env, TZ, LANG, LC_ALL: LANG }, encoding: "utf-8" }).trim().split("\n").at(-1)!;
    const shanghai = JSON.parse(read("Asia/Shanghai", "zh_CN.UTF-8"));
    const newYork = JSON.parse(read("America/New_York", "en_US.UTF-8"));
    expect(shanghai).toEqual(newYork);
    expect(ownerAlive(shanghai)).toBe(true);
    expect(processIdentity().start).toBe(startEpoch(process.pid));
  });
});

describe("评审 v1.3 P2：旧记录的 pid 被无关进程复用", () => {
  it("命令对不上 = 对这条记录来说 agent 已经不在：算孤儿；但杀组前再核命令，无关进程不碰", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-server-"));
    const legacy = run({});
    fs.writeFileSync(path.join(dir, "runs.json"), JSON.stringify([legacy]));
    expect(agentStillThere(4715, "node adapter", () => "/usr/bin/some-unrelated-daemon")).toBe(false);
    expect(agentStillThere(4715, "node adapter", () => "node adapter --acp")).toBe(true);
    const killed: number[] = [];
    const leftovers = new RunStore(dir, { pid: 9, start: 9 }).recoverOnStartup((pid, cmd) => { killed.push(pid); return cmd === "node adapter"; }, () => false, () => false);
    expect(leftovers.map((r) => r.turnId)).toEqual(["t1"]);
    // killRecordedGroup 自己会核命令：pid 复用给了别的进程时它不杀、只报「清干净了」
    expect(killed).toEqual([4715]);
  });
});
