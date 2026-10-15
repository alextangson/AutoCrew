/**
 * 写稿交给谁（spec 2026-10-15 §B）：默认写稿 AI 的选法、三种 AI 的打开方式、没接 / 断开不建稿、交出时刻与接手信号、认领中不重交。
 * 宿主配置全在临时 HOME 里（makeSandbox），真实的 ~/.codex、~/.workbuddy、~/.autocrew 不碰。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { initializeProjectLayout } from "../storage/content-project.js";
import { getContent, listContents, saveContent, saveTopic, updateContent, type Topic } from "../storage/local-store.js";
import { founderAuthored } from "../modules/research/angle-gate.test-helper.js";
import { startWriting } from "./board-actions.js";
import { deliver, handOff, writePrompt } from "./writing-handoff.js";
import { connectedWriters, pickWriter, writeWritingHost } from "./host-connect/writing-host.js";
import { ensureHostToken } from "./host-tokens.js";
import { recordVerify } from "./host-connect/verify-state.js";
import { mergeWorkbuddyMcp } from "./workbuddy-connect.js";
import { makeSandbox, type Sandbox } from "./host-connect/test-fakes.js";
import { handoffView } from "./board-data.js";
import { draftStart } from "../tools/draft-start.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";
import type http from "node:http";
import { createConnectHandler } from "./connect-route.js";

let dir: string, topic: Topic, exitCode: number;
const spawnImpl = vi.fn(() => { const c = new EventEmitter(); setImmediate(() => c.emit("exit", exitCode)); return c; }) as unknown as typeof spawn;
const opened = () => vi.mocked(spawnImpl).mock.calls.map((c) => (c as unknown as [string, string[]])[1][0]);
const with_ = (host: "claude" | "codex" | "workbuddy", label: string) => ({ platform: "darwin" as const, spawnImpl, programDir: "/opt/autocrew", writer: () => ({ ok: true as const, host, label }) });

beforeEach(async () => {
  dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "autocrew-handoff-")));
  await initializeProjectLayout(dir, "lib-deadbeef", "default");
  topic = await saveTopic({ title: "喊一定没用", tags: [] }, dir);
  await founderAuthored(dir, topic.id);
  exitCode = 0;
  vi.mocked(spawnImpl).mockClear();
});
afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

describe("开工指令", () => {
  it("任何接了 AutoCrew MCP 的 agent 都看得懂：点名 autocrew_draft、稿件 id、平台；仍以「这条视频开工」开头", () => {
    const p = writePrompt("喊一定没用", "topic-1-a", "content-1-b", "douyin");
    expect(p.startsWith("这条视频开工")).toBe(true);
    for (const s of ["autocrew_draft", "start{content_id:\"content-1-b\"}", "douyin", "next_action"]) expect(p).toContain(s);
  });
});

describe("按默认 AI 打开", () => {
  it("Claude：深链带指令；Codex：打开新对话、指令要粘贴；WorkBuddy：不打开、只进剪贴板", async () => {
    const c = await deliver("claude", "Claude Code", "开工", with_("claude", "Claude Code"));
    expect(c).toMatchObject({ opened: true, paste: false });
    const x = await deliver("codex", "Codex", "开工", with_("codex", "Codex"));
    expect(x).toMatchObject({ opened: true, paste: true });
    const w = await deliver("workbuddy", "WorkBuddy", "开工", with_("workbuddy", "WorkBuddy"));
    expect(w).toMatchObject({ opened: false, paste: true });
    expect(w.open_error).toBeUndefined();
    expect(opened()).toEqual([expect.stringMatching(/^claude:\/\/code\/new\?q=/), "codex://threads/new"]);
  });

  it("打不开：说清是哪个 AI、为什么，退回剪贴板", async () => {
    exitCode = 1;
    expect(await deliver("codex", "Codex", "开工", with_("codex", "Codex"))).toMatchObject({ opened: false, paste: true, open_error: expect.stringContaining("Codex 桌面版") });
    expect(await deliver("claude", "Claude Code", "开工", { platform: "linux" })).toMatchObject({ opened: false, paste: true, open_error: expect.stringContaining("不是 macOS") });
  });

  it("开始写交给 Codex：建稿、记交出时刻，回指令让前端放剪贴板", async () => {
    const r = await startWriting(topic.id, "douyin", dir, with_("codex", "Codex"));
    expect(r).toMatchObject({ ok: true, created: true, host: "codex", label: "Codex", opened: true, paste: true });
    if (!r.ok || !r.created) throw new Error();
    expect(r.prompt).toContain(r.content_id);
    expect((await getContent(r.content_id, dir))?.writingHandoff).toMatchObject({ host: "codex" });
  });

  it("一个 AI 都没接 / 默认的连不上了：不建稿、不开窗，原样回原因", async () => {
    const none = { platform: "darwin" as const, spawnImpl, writer: () => ({ ok: false as const, code: "no_writer" as const, error: "先接一个 AI" }), engineReady: async () => false };
    expect(await startWriting(topic.id, "douyin", dir, none)).toMatchObject({ ok: false, code: "no_writer" });
    const gone = { platform: "darwin" as const, spawnImpl, writer: () => ({ ok: false as const, code: "default_gone" as const, host: "codex" as const, label: "Codex", error: "默认的 Codex 连不上了", alternatives: [] }) };
    expect(await startWriting(topic.id, "douyin", dir, gone)).toMatchObject({ ok: false, code: "default_gone", label: "Codex" });
    expect((await listContents(dir)).filter((c) => c.topicId === topic.id)).toHaveLength(0);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe("只配了模型钥匙、没接本机 AI", () => {
  const keyOnly = { platform: "darwin" as const, spawnImpl, writer: () => ({ ok: false as const, code: "no_writer" as const, error: "先接一个 AI" }), engineReady: async () => true };
  it("开始写照样建稿，交给总编辑：不开窗、不进剪贴板，指令给前端填进右侧对话框", async () => {
    const r = await startWriting(topic.id, "douyin", dir, keyOnly);
    expect(r).toMatchObject({ ok: true, created: true, host: "chief", label: "总编辑", opened: false, paste: false });
    if (!r.ok || !r.created) throw new Error();
    expect(r.prompt).toContain(r.content_id);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(handoffView((await getContent(r.content_id, dir))!)).toMatchObject({ label: "总编辑", pickedUp: false });
  });
  it("默认的断开了不悄悄换成总编辑：照旧 default_gone", async () => {
    const gone = { ...keyOnly, writer: () => ({ ok: false as const, code: "default_gone" as const, host: "codex" as const, label: "Codex", error: "默认的 Codex 连不上了", alternatives: [] }) };
    expect(await startWriting(topic.id, "douyin", dir, gone)).toMatchObject({ ok: false, code: "default_gone" });
  });
});

describe("默认写稿 AI 的选法", () => {
  let sb: Sandbox;
  beforeEach(async () => { sb = await makeSandbox({ claude: false, codex: false }); });
  afterEach(async () => { await sb.cleanup(); });
  const connectCodex = () => {
    ensureHostToken("codex", sb.dataDir);
    fs.mkdirSync(sb.env.codexHome, { recursive: true });
    fs.writeFileSync(path.join(sb.env.codexHome, "config.toml"), "[mcp_servers.autocrew]\ncommand = \"node\"\n");
    recordVerify("codex", { verified: true, at: new Date().toISOString() }, sb.dataDir);
  };
  const connectWorkbuddy = () => {
    ensureHostToken("workbuddy", sb.dataDir);
    mergeWorkbuddyMcp(sb.home);
    recordVerify("workbuddy", { verified: true, at: new Date().toISOString() }, sb.dataDir);
  };

  it("一个都没接 → no_writer；只接了 Codex → 就是它", () => {
    expect(pickWriter(sb.env)).toMatchObject({ ok: false, code: "no_writer" });
    connectCodex();
    expect(connectedWriters(sb.env)).toEqual(["codex"]);
    expect(pickWriter(sb.env)).toMatchObject({ ok: true, host: "codex", label: "Codex" });
  });

  it("存了默认就用默认；这一次点名换一个只管这一次；默认断开 → default_gone 带可换的", () => {
    connectCodex(); connectWorkbuddy();
    writeWritingHost("workbuddy", sb.dataDir);
    expect(pickWriter(sb.env)).toMatchObject({ ok: true, host: "workbuddy" });
    expect(pickWriter(sb.env, "codex")).toMatchObject({ ok: true, host: "codex" });
    expect(pickWriter(sb.env)).toMatchObject({ ok: true, host: "workbuddy" });
    recordVerify("workbuddy", { verified: false, reason: "连不上", at: new Date().toISOString() }, sb.dataDir);
    expect(pickWriter(sb.env)).toMatchObject({ ok: false, code: "default_gone", label: "WorkBuddy", error: expect.stringContaining("默认的 WorkBuddy 连不上了"), alternatives: [{ host: "codex", label: "Codex" }] });
  });

  it("设置里改默认：只认接上了的；GET 带回默认和可选的", async () => {
    connectCodex();
    const call = async (method: string, pathName: string, body?: unknown) => {
      let status = 0, out = "";
      const res = { writeHead(st: number) { status = st; return this; }, end(b: string) { out = b ?? ""; } } as unknown as http.ServerResponse;
      const handler = createConnectHandler({ authorize: () => "session", originAllowed: () => true, readBody: async () => JSON.stringify(body ?? {}), env: () => sb.env });
      await handler({ method, headers: {} } as http.IncomingMessage, res, new URL(`http://x${pathName}`));
      return { status, body: JSON.parse(out) as Record<string, unknown> };
    };
    expect(await call("POST", "/api/connect/writing-host", { host: "workbuddy" })).toMatchObject({ status: 400, body: { code: "not_connected" } });
    expect(await call("POST", "/api/connect/writing-host", { host: "codex" })).toMatchObject({ status: 200 });
    expect((await call("GET", "/api/connect")).body.data).toMatchObject({ writingHost: "codex", writers: ["codex"] });
  });
});

describe("交出去之后：等接手 / 在写 / 认领中", () => {
  it("draft start 接手才算接上；之前看板说「等它接手」", async () => {
    const r = await startWriting(topic.id, "douyin", dir, with_("codex", "Codex"));
    if (!r.ok || !r.created) throw new Error();
    const before = (await getContent(r.content_id, dir))!;
    expect(handoffView(before)).toMatchObject({ label: "Codex", pickedUp: false, holder: null });
    await draftStart({ action: "start", contentId: r.content_id, host: "codex", dataDir: dir } as never);
    const after = (await getContent(r.content_id, dir))!;
    expect(after.writingHandoff).toMatchObject({ pickedUpBy: "codex" });
    expect(handoffView(after)).toMatchObject({ pickedUp: true });
  });

  it("没调 start 直接存了正文也算接手；显示实际接手的那个，不是原来交给的", () => {
    const at = new Date(Date.now() - 3600_000).toISOString();
    const base = { status: "drafting", claim: undefined, body: "" };
    expect(handoffView({ ...base, writingHandoff: { host: "codex", at } } as never)).toMatchObject({ pickedUp: false, label: "Codex" });
    expect(handoffView({ ...base, body: "写了一段", writingHandoff: { host: "codex", at } } as never)).toMatchObject({ pickedUp: true });
    expect(handoffView({ ...base, writingHandoff: { host: "codex", at, pickedUpAt: at, pickedUpBy: "claude-code" } } as never)).toMatchObject({ pickedUp: true, label: "Claude Code" });
  });

  it("别的会话认领着：照实说谁在写，「重新交给」被拒", async () => {
    const c = await saveContent({ title: "在写", body: "", platform: "douyin", status: "drafting", tags: [] }, dir);
    const now = Date.now();
    await updateContent(c.id, { writingHandoff: { host: "codex", at: new Date(now - 60_000).toISOString() },
      claim: { employee: "writer", host: "claude-code", token: "t", at: new Date(now).toISOString(), leaseUntil: new Date(now + 30 * 60_000).toISOString() } }, dir);
    const got = (await getContent(c.id, dir))!;
    expect(handoffView(got)).toMatchObject({ pickedUp: true, holder: "Claude Code" });
    expect(await handOff(c.id, { mode: "write" }, dir, with_("codex", "Codex"))).toMatchObject({ ok: false, code: "claim_held", holder: "Claude Code" });
  });

  it("交给 X 看：只读的那句话，不记交出时刻；过了写稿阶段不让「交给 X 写」", async () => {
    const c = await saveContent({ _provenance: HUMAN_WRITE, title: "待发", body: "正文", platform: "douyin", status: "drafting", tags: [] }, dir);
    const look = await handOff(c.id, { mode: "look" }, dir, with_("workbuddy", "WorkBuddy"));
    expect(look).toMatchObject({ ok: true, paste: true, prompt: expect.stringContaining("先不要改任何东西") });
    expect((await getContent(c.id, dir))?.writingHandoff).toBeUndefined();
    const late = await saveContent({ _provenance: HUMAN_WRITE, title: "待发", body: "正文", platform: "wechat_mp", status: "publish_ready", tags: [] }, dir);
    expect(await handOff(late.id, { mode: "write" }, dir, with_("codex", "Codex"))).toMatchObject({ ok: false, code: "wrong_stage" });
  });
});
