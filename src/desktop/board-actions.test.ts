import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { initializeProjectLayout, resolveContentProject } from "../storage/content-project.js";
import { getContent, listContents, saveContent, saveTopic, softDeleteTopic, type Topic } from "../storage/local-store.js";
import { claudeLink, markPublished, startPrompt, startWriting, unmarkPublished } from "./board-actions.js";
import { founderAuthored } from "../modules/research/angle-gate.test-helper.js";
import { HUMAN_WRITE } from "../storage/first-body-guard.js";

let dir: string, topic: Topic, exitCode: number;
const spawnImpl = vi.fn(() => { const c = new EventEmitter(); setImmediate(() => c.emit("exit", exitCode)); return c; }) as unknown as typeof spawn;
const mac = { platform: "darwin" as const, spawnImpl, programDir: "/opt/autocrew" };

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-board-actions-")));
  await initializeProjectLayout(dir, "lib-deadbeef", "default");
  topic = await saveTopic({ title: "genoffice 开源：让 AI 直接生成 Word", tags: [], source: "radar:GitHub Trending" }, dir);
  await founderAuthored(dir, topic.id);
  exitCode = 0;
  vi.mocked(spawnImpl).mockClear();
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

it("开始写：建一篇写稿中的稿件，并用 open 打开预填了指令的 Claude 新会话", async () => {
  const r = await startWriting(topic.id, "douyin", dir, mac);
  expect(r).toMatchObject({ ok: true, created: true, opened: true });
  if (!r.ok) throw new Error();
  const saved = await getContent(r.content_id, dir);
  expect(saved).toMatchObject({ topicId: topic.id, status: "drafting", platform: "douyin", title: topic.title });
  const [cmd, args] = vi.mocked(spawnImpl).mock.calls[0] as unknown as [string, string[]];
  expect(cmd).toBe("open");
  const url = new URL(args[0]);
  expect(url.protocol).toBe("claude:");
  expect(url.searchParams.get("folder")).toBe("/opt/autocrew");
  const q = url.searchParams.get("q") ?? "";
  expect(q).toContain("这条视频开工");
  expect(q).toContain(topic.id);
  expect(q).toContain(r.content_id);
});

it("同一选题再点、两个标签页同时点：只建一篇、只开一次窗", async () => {
  const [a, b] = await Promise.all([startWriting(topic.id, "douyin", dir, mac), startWriting(topic.id, "douyin", dir, mac)]);
  const again = await startWriting(topic.id, "douyin", dir, mac);
  expect((await listContents(dir)).filter((c) => c.topicId === topic.id)).toHaveLength(1);
  expect(spawnImpl).toHaveBeenCalledTimes(1);
  const created = [a, b].filter((r) => r.ok && r.created);
  expect(created).toHaveLength(1);
  expect(again).toMatchObject({ ok: true, created: false });
  if (a.ok && again.ok) expect(again.content_id).toBe(a.content_id);
});

it("选题被删 → 明说，不建稿；坏 id → bad_request；非视频平台回落到抖音", async () => {
  await softDeleteTopic(topic.id, dir);
  expect(await startWriting(topic.id, "douyin", dir, mac)).toMatchObject({ ok: false, code: "topic_gone" });
  expect(await startWriting("../etc", "douyin", dir, mac)).toMatchObject({ ok: false, code: "bad_request" });
  const other = await saveTopic({ title: "另一条", tags: [] }, dir);
  await founderAuthored(dir, other.id);
  const r = await startWriting(other.id, "wechat_mp", dir, mac);
  if (!r.ok) throw new Error();
  expect((await getContent(r.content_id, dir))?.platform).toBe("douyin");
});

it("打不开 Claude：稿照建，回指令原文和原因让前端退回剪贴板", async () => {
  exitCode = 1;
  const r = await startWriting(topic.id, "douyin", dir, mac);
  expect(r).toMatchObject({ ok: true, created: true, opened: false });
  if (!r.ok) throw new Error();
  expect(r.open_error).toBeTruthy();
  expect(r.prompt).toContain(topic.id);
  expect((await startWriting(topic.id, "douyin", dir, { ...mac, platform: "linux" }))).toMatchObject({ created: false });
});

it("指令短：标题截断，链接里的 q 是编码过的", () => {
  const p = startPrompt("长".repeat(200), "topic-1-a", "content-1-b", "douyin");
  expect(Array.from(p).length).toBeLessThan(140);
  expect(claudeLink("a&b", "/x y")).toBe("claude://code/new?q=a%26b&folder=%2Fx%20y");
});

it("我发了：记手动发布并同步为已发布；撤销后没有别的平台发出去就退回待发布", async () => {
  const c = await saveContent({ _provenance: HUMAN_WRITE, title: "图文", body: "正文", status: "publish_ready", platform: "wechat_mp", tags: [] }, dir);
  const marked = await markPublished(c.id, "wechat_video", "https://channels.weixin.qq.com/x", dir);
  expect(marked).toMatchObject({ ok: true, content: { status: "published", manualPublications: [{ platform: "wechat_video", url: "https://channels.weixin.qq.com/x" }] } });
  const undone = await unmarkPublished(c.id, "wechat_video", dir);
  expect(undone).toMatchObject({ ok: true, content: { status: "publish_ready", manualPublications: [], publishedAt: null } });
});

it("撤销时计划里还有已提交的平台：留在已发布", async () => {
  const c = await saveContent({ _provenance: HUMAN_WRITE, title: "图文", body: "正文", status: "publish_ready", platform: "wechat_mp", tags: [] }, dir);
  const root = resolveContentProject(c.id, dir)!.project_root;
  await fs.mkdir(path.join(root, "06-publish"), { recursive: true });
  await fs.writeFile(path.join(root, "06-publish/publish-plan.json"), JSON.stringify({ platforms: [{ platform: "douyin", publication: { status: "scheduled", scheduled_at: "2099-01-01T00:00:00Z" } }] }));
  await markPublished(c.id, "wechat_video", undefined, dir);
  expect(await unmarkPublished(c.id, "wechat_video", dir)).toMatchObject({ ok: true, content: { status: "published" } });
});

it("我发了：链接不是 http(s)、还没到发布阶段都拒", async () => {
  const c = await saveContent({ _provenance: HUMAN_WRITE, title: "图文", body: "正文", status: "publish_ready", platform: "wechat_mp", tags: [] }, dir);
  expect(await markPublished(c.id, "douyin", "javascript:alert(1)", dir)).toMatchObject({ ok: false, code: "bad_request" });
  const early = await saveContent({ _provenance: HUMAN_WRITE, title: "草稿", body: "正文", status: "drafting", platform: "douyin", tags: [] }, dir);
  expect(await markPublished(early.id, "douyin", undefined, dir)).toMatchObject({ ok: false, code: "wrong_stage" });
});

it("我发了：非视频稿认过（approved，看板在待发布）可以记；视频稿 approved 还在待录制，拒", async () => {
  const mp = await saveContent({ _provenance: HUMAN_WRITE, title: "图文", body: "正文", status: "approved", platform: "wechat_mp", tags: [] }, dir);
  expect(await markPublished(mp.id, "wechat_mp", undefined, dir)).toMatchObject({ ok: true, content: { status: "published", manualPublications: [{ platform: "wechat_mp" }] } });
  const video = await saveContent({ _provenance: HUMAN_WRITE, title: "口播", body: "正文", status: "approved", platform: "douyin", tags: [] }, dir);
  expect(await markPublished(video.id, "douyin", undefined, dir)).toMatchObject({ ok: false, code: "wrong_stage" });
});
