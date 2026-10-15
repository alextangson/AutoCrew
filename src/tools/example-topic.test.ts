/** O20：试跑示例——选题带 example，其下稿继承；不进数据回流 / 采纳 / diff 学习 / 手册统计；一键连稿删 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { executeTopicCreate, deleteExampleTopic } from "./topic-create.js";
import { getContent, listContents, listTopics, saveContent, updateContent } from "../storage/local-store.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";
import { matchDraft } from "../modules/flywheel/outcome-store.js";
import { listDiffs, recordDiff } from "../modules/learnings/diff-tracker.js";
import { deriveAndRecordAdoption } from "../modules/learnings/adoption-derive.js";
import { computeStats } from "../modules/playbook/stats.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "example-topic-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

async function exampleDraft(example = true) {
  const t = await executeTopicCreate({ action: "create", title: "示例：用 AI 写周报", description: "试跑", tags: [], ...(example ? { example: true } : {}), _dataDir: dir });
  const topic = (t as { topic: { id: string; example?: boolean } }).topic;
  const c = await saveContent({ _provenance: HUMAN_WRITE, title: "用 AI 写周报", body: "正文", platform: "wechat_mp", status: "drafting", tags: [], topicId: topic.id }, dir);
  return { topic, c };
}

it("topic create marks example; drafts under it inherit; normal topics don't", async () => {
  const { topic, c } = await exampleDraft();
  expect(topic.example).toBe(true);
  expect(c.example).toBe(true);
  const plain = await exampleDraft(false);
  expect(plain.topic.example).toBeUndefined();
  expect(plain.c.example).toBeUndefined();
});

it("one-click delete moves the example topic and its drafts to the trash; refuses non-example topics", async () => {
  const { topic, c } = await exampleDraft();
  const r = await deleteExampleTopic(topic.id, dir);
  expect(r).toMatchObject({ ok: true, removed: { topic: topic.id, contents: [c.id] } });
  expect((await listTopics(dir)).find((t) => t.id === topic.id)).toBeUndefined();
  expect((await listContents(dir)).find((x) => x.id === c.id)).toBeUndefined();
  const plain = await exampleDraft(false);
  expect(await deleteExampleTopic(plain.topic.id, dir)).toMatchObject({ ok: false, code: "not_example" });
});

it("metrics pull-back never matches an example draft, even if published", async () => {
  const { c } = await exampleDraft();
  await updateContent(c.id, { status: "published", publishedAt: new Date().toISOString() }, dir);
  expect(await matchDraft("wechat_mp", "用 AI 写周报", null, dir)).toBeNull();
});

it("edits on an example draft are not recorded as learning diffs; adoption not derived", async () => {
  const { c } = await exampleDraft();
  await recordDiff(c.id, "human", "body", "a", "b", dir);
  expect(await listDiffs({ contentId: c.id }, dir)).toEqual([]);
  expect(await deriveAndRecordAdoption(c.id, dir)).toBeNull();
  expect((await getContent(c.id, dir))?.adoption).toBeUndefined();
});

it("playbook stats skip example drafts", () => {
  const draft = (example: boolean) => ({ id: "c1", ...(example ? { example } : {}), draftPath: { angle: {} }, status: "drafting" }) as never;
  expect(computeStats({ playbooks: [] } as never, [draft(false)], []).unattributed).toBe(1);
  expect(computeStats({ playbooks: [] } as never, [draft(true)], []).unattributed).toBe(0);
});

it("outcome ingestion refuses example drafts even with an explicit content id (codex P2)", async () => {
  const { recordOutcome } = await import("../modules/flywheel/outcome-store.js");
  const { c } = await exampleDraft();
  const r = await recordOutcome({ contentId: c.id, platform: "douyin", platformTitle: "用 AI 写周报", publishedAt: null,
    metricDate: "2026-10-15", metrics: { views: 10 }, source: "paste" } as never, dir);
  expect(r).toMatchObject({ ok: false });
  expect(r.error).toContain("示例");
});

it("engine-only trial: generate:script with founder words + direction passes the angle gate on the example topic (O19)", async () => {
  const { founderAngleFromPayload } = await import("../desktop/ipc.js");
  const { newDraftAngleRefusal } = await import("../modules/research/angle-gate.js");
  const t = await executeTopicCreate({ action: "create", title: "示例", description: "d", tags: [], example: true, _dataDir: dir });
  const id = (t as { topic: { id: string } }).topic.id;
  expect(await newDraftAngleRefusal(id, dir)).toMatchObject({ code: "needs_founder_angle" });
  expect(await founderAngleFromPayload(id, { direction: "讲周报", founder_words: "就讲周报怎么省时间" }, dir)).toBeNull();
  expect(await newDraftAngleRefusal(id, dir)).toBeNull();
  expect(await founderAngleFromPayload("topic-nope", { direction: "x", founder_words: "y" }, dir)).toMatchObject({ code: "topic_not_found" });
});

it("IPC topic:create carries the example flag", async () => {
  const { topicCreateHandler } = await import("../desktop/ipc.js");
  const r = await topicCreateHandler({ title: "示例题", source: "setup", example: true, _dataDir: dir });
  expect((r as { topic?: { example?: boolean } }).topic?.example ?? (r as { data?: { example?: boolean } }).data?.example).toBe(true);
});
