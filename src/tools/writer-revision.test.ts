import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { executeWriter } from "./writer.js";
import { executeEditorial } from "./editorial.js";
import { packPreparation } from "./writer-prepare.js";
import { readPack } from "./writer-pack.js";
import { claimContent } from "../storage/claims.js";
import { getContent, getTopic, listContents, listTopics, saveContent, saveTopic, type Content } from "../storage/local-store.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "writer-revision-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
const run = (args: Record<string, unknown>) => executeWriter({ _dataDir: dir, _host: "claude-test", ...args });
const draft = (overrides: Partial<Content> = {}) => saveContent({ _provenance: HUMAN_WRITE, title: "社区菜园的记录", body: "邻居们共同浇水，轮班时间写在公告板上。", status: "draft_ready", platform: "douyin", ...overrides }, dir);

describe("existing draft revision pack", () => {
  it.each([
    { name: "missing force", args: { force: false }, content: {} },
    { name: "invalid platform", args: { platform: "other" }, content: {} },
    { name: "different platform", args: { platform: "wechat_mp" }, content: {} },
    { name: "missing platform", args: {}, content: { platform: undefined } },
    { name: "noneditable status", args: {}, content: { status: "approved" as const } },
  ])("rejects $name before creating a topic or altering the draft", async ({ args, content }) => {
    const saved = await draft(content);
    expect(await run({ action: "pack", content_id: saved.id, force: true, ...args })).toMatchObject({ ok: false });
    expect(await listTopics(dir)).toHaveLength(0);
    expect(await getContent(saved.id, dir)).toEqual(saved);
  });

  it("checks another host's claim before any topic/pack mutation", async () => {
    const saved = await draft();
    await claimContent(saved.id, "writer", "other-host", dir);
    const before = await getContent(saved.id, dir);
    expect(await run({ action: "pack", content_id: saved.id, force: true })).toMatchObject({ ok: false, holder: { host: "other-host" } });
    expect(await listTopics(dir)).toHaveLength(0);
    expect(await getContent(saved.id, dir)).toEqual(before);
    expect(await readPack(saved.id, dir)).toBeNull();
  });

  it("associates one revision topic across concurrent packs and preserves original text", async () => {
    const saved = await draft();
    const results = await Promise.all([run({ action: "pack", content_id: saved.id, force: true }), run({ action: "pack", content_id: saved.id, force: true })]);
    // 同宿主两个会话并发领包（P6 §3.8）：先到的认领并拿到令牌，后到的没令牌 → claim_held，不另建选题
    const winner = results.find((r) => r.ok === true) as Record<string, unknown>;
    expect(winner).toMatchObject({ content_id: saved.id, claim_token: expect.stringMatching(/^clm-/) });
    expect(results.filter((r) => r.ok === false)).toEqual([expect.objectContaining({ code: "claim_held" })]);
    await packPreparation(saved.id);
    const content = await getContent(saved.id, dir);
    const topics = await listTopics(dir);
    expect(topics).toHaveLength(1);
    expect(content).toMatchObject({ title: saved.title, body: saved.body, topicId: topics[0].id });
    expect(await listContents(dir)).toHaveLength(1);
    const pack = await readPack(saved.id, dir);
    expect(pack).toMatchObject({ state: "ready", context: { req: { researchMode: "provided" } } });
    expect(pack?.ledger.entries).toEqual(expect.arrayContaining([expect.objectContaining({ source: "user_claim", quote: expect.stringContaining(saved.body) })]));
    const retried = await run({ action: "pack", content_id: saved.id, claim_token: winner.claim_token });
    expect(retried).toMatchObject({ ok: true, pack_id: pack?.packId });
    expect(await listTopics(dir)).toHaveLength(1);
    const another = await saveTopic({ title: "不相关选题", description: "不要换题", tags: [] }, dir);
    const beforeMismatch = await getContent(saved.id, dir);
    expect(await run({ action: "pack", content_id: saved.id, topic_id: another.id, force: true, claim_token: winner.claim_token })).toMatchObject({ ok: false });
    expect(await getContent(saved.id, dir)).toEqual(beforeMismatch);
  });

  it("inherits an existing association and supplied planning instead of creating a new topic", async () => {
    const topic = await saveTopic({ title: "已有菜园选题", description: "以共同浇水说明参与方式", tags: [] }, dir);
    const saved = await draft({ topicId: topic.id });
    const first = await run({ action: "pack", content_id: saved.id, force: true, direction: "从公告板进入", research_mode: "provided", research: saved.body, requirements: "保留公告板这个场景" });
    expect(first).toMatchObject({ ok: true, content_id: saved.id });
    await packPreparation(saved.id);
    expect(await listTopics(dir)).toHaveLength(1);
    expect((await getContent(saved.id, dir))?.topicId).toBe(topic.id);
    expect((await getTopic(topic.id, dir))?.title).toBe(topic.title);
    const second = await run({ action: "pack", content_id: saved.id, force: true, claim_token: first.claim_token });
    expect(second).toMatchObject({ ok: true });
    await packPreparation(saved.id);
    expect(await readPack(saved.id, dir)).toMatchObject({ context: { req: { direction: "从公告板进入", requirements: "保留公告板这个场景", research: saved.body } } });
  });

  it("asks for missing platform without inventing one, then supports the explicit platform", async () => {
    const saved = await draft({ platform: undefined });
    const inspected = await executeEditorial({ action: "inspect", content_id: saved.id, _dataDir: dir });
    // 记反馈也是写（P6 §3.8）：同一宿主记反馈时顺手认领，接着重领包带它回的令牌
    const feedback = { action: "feedback", content_id: saved.id, draft_hash: inspected.draft_hash, event_id: "legacy-feedback", feedback: "把轮班表写具体", user_confirmed: true, _dataDir: dir, _host: "claude-test" };
    const captured = await executeEditorial(feedback);
    expect(captured).toMatchObject({ ok: true, claim_token: expect.stringMatching(/^clm-/), next_action: { required_input: "platform", params: { research_mode: "provided", research: expect.stringContaining(saved.body) } } });
    const next = captured.next_action as { params: Record<string, unknown> };
    expect(await run(next.params)).toMatchObject({ ok: false, code: "needs_platform" });
    expect(await listTopics(dir)).toHaveLength(0);
    expect(await run({ ...next.params, platform: "douyin", claim_token: captured.claim_token })).toMatchObject({ ok: true, content_id: saved.id });
    await packPreparation(saved.id);
    const ready = await run({ action: "pack_status", content_id: saved.id });
    expect(ready).toMatchObject({ status: "ready", pack_md: expect.stringContaining("把轮班表写具体") });
    expect((await getContent(saved.id, dir))?.body).toBe(saved.body);
    expect(await executeEditorial(feedback)).toMatchObject({ replayed: true, next_action: { params: { content_id: saved.id, platform: "douyin" } } });
  });
});
