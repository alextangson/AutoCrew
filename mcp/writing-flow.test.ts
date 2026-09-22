import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleMcpRequest } from "./server.js";
import { saveTopic, getContent, listContents } from "../src/storage/local-store.js";
import { packPreparation } from "../src/tools/writer-prepare.js";

let dataDir: string;
const access = { principal: { subject: "claude-desktop-test", plan: "local" as const }, host: "claude-desktop-test" };
beforeEach(async () => { dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-mcp-writing-flow-")); });
afterEach(async () => { await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
async function call(name: string, args: Record<string, unknown>) {
  const response = await handleMcpRequest({ id: 1, method: "tools/call", params: { name, arguments: args } }, access, dataDir);
  return (response!.result as { structuredContent: Record<string, any> }).structuredContent;
}

describe("Claude MCP writing journey without external model calls", () => {
  it("delivers the default workflow through MCP initialization, prompt and resource", async () => {
    const initialized = await handleMcpRequest({ id: 1, method: "initialize" }, access, dataDir);
    expect((initialized!.result as { instructions: string }).instructions).toContain("autocrew_workflow prepare");
    const guide = await handleMcpRequest({ id: 2, method: "resources/read", params: { uri: "autocrew://writing-guide" } }, access, dataDir);
    expect(JSON.stringify(guide)).toContain("quality_status");
    const prompt = await handleMcpRequest({ id: 3, method: "prompts/get", params: { name: "write_content", arguments: { requirements: "只写真实经历" } } }, access, dataDir);
    expect(JSON.stringify(prompt)).toContain("只写真实经历");
    expect(JSON.stringify(prompt)).toContain("workflow prepare");
  });

  it("cannot jump from a new topic straight to a pack, engine generation, or generic save", async () => {
    const topic = await saveTopic({ title: "门店返工", description: "观察团队的交接问题", tags: [] }, dataDir);
    const pack = await call("autocrew_writer", { action: "pack", topic_id: topic.id, platform: "douyin", direction: "写交接问题" });
    expect(pack).toMatchObject({ ok: false, needsResearch: true, preparation: { research: { status: "not_started" } } });
    expect(pack.next_action.params.action).toBe("prepare");
    const engine = await call("autocrew_generate", { action: "script", topic: topic.title, topic_id: topic.id, platform: "douyin" });
    expect(engine).toMatchObject({ ok: false, code: "host_writer_default" });
    const explicitEngine = await call("autocrew_generate", { action: "script", topic: topic.title, topic_id: topic.id, platform: "douyin", execution: "engine" });
    expect(explicitEngine).toMatchObject({ ok: false, needsResearch: true });
    const saved = await call("autocrew_content", { action: "save", title: "直接成稿", body: "未经准备的稿件" });
    expect(saved).toMatchObject({ ok: false, code: "writer_submission_required" });
    expect(await listContents(dataDir)).toHaveLength(0);
  });

  it("uses provided material explicitly, keeps the host as author and preserves natural full prose", async () => {
    const topic = await saveTopic({ title: "门店交接", description: "只写已经提供的亲历材料", tags: [] }, dataDir);
    const request = {
      topic_id: topic.id, platform: "douyin", research_mode: "provided",
      research: "团队先走访门店，再检查交接记录，发现问题在于责任归属。",
      direction: "按这次走访的真实顺序讲", requirements: "自然收尾，不要关注点赞引导",
    };
    const prepared = await call("autocrew_workflow", { ...request, action: "prepare" });
    expect(prepared).toMatchObject({ status: "ready_to_write", research: { status: "provided", autoResearched: false } });
    const started = await call("autocrew_writer", { ...request, action: "pack" });
    expect(started).toMatchObject({ status: "preparing", writing_source: { kind: "host" } });
    await packPreparation(started.content_id);
    const ready = await call("autocrew_writer", { action: "pack_status", content_id: started.content_id });
    expect(ready).toMatchObject({ status: "ready", preparation: { research: { status: "provided" } } });
    const body = "我们先走访门店。\n\n我们其次检查交接记录。\n\n我们发现责任不清，流程还没有形成闭环。";
    const submitted = await call("autocrew_writer", {
      action: "submit", content_id: started.content_id, pack_id: started.pack_id,
      attempt: 1, title: "交接记录里的问题", body, hashtags: [], review: "none",
    });
    expect(submitted).toMatchObject({ status: "accepted_unreviewed", saved: true, needs_attention: true });
    expect(submitted.quality_status).not.toBe("passed");
    expect((await getContent(started.content_id, dataDir))?.body).toBe(body);
    expect((await getContent(started.content_id, dataDir))?.writtenBy).toMatchObject({ kind: "host", host: access.host });
  });

  it("manual import remains available but cannot claim semantic approval", async () => {
    const imported = await call("autocrew_content", {
      action: "save", title: "用户已有稿", body: "用户已经写好的原稿。", status: "approved",
      source: "manual_import", import_reason: "用户给出自己的旧稿并要求归档",
    });
    expect(imported).toMatchObject({ ok: true, saved: true, quality_status: "unreviewed", needs_attention: true, content: { status: "draft_ready" } });
  });
});
