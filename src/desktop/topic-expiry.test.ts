/**
 * topic-expiry.test.ts — 灵感库 3 天过期清理（创始人 2026-07-08 裁决）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expireStaleTopics, TOPIC_TTL_MS } from "./topic-expiry.js";
import { createWorkspace } from "./workspace-store.js";
import { saveTopic, listTopics, listTrash, saveContent, updateTopic } from "../storage/local-store.js";

let tmpHome: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-expiry-test-"));
  savedEnv = process.env.AUTOCREW_DATA_DIR;
  process.env.AUTOCREW_DATA_DIR = tmpHome;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.AUTOCREW_DATA_DIR;
  else process.env.AUTOCREW_DATA_DIR = savedEnv;
  await fs.rm(tmpHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

/** 直接改 topic 文件的 createdAt(saveTopic 总是写 now,测试需要旧时间戳) */
async function ageTopic(id: string, daysAgo: number, dataDir?: string): Promise<void> {
  const dir = dataDir ?? tmpHome;
  const p = path.join(dir, "topics", `${id}.json`);
  const t = JSON.parse(await fs.readFile(p, "utf-8"));
  t.createdAt = new Date(Date.now() - daysAgo * 24 * 3600_000).toISOString();
  await fs.writeFile(p, JSON.stringify(t, null, 2), "utf-8");
}

describe("expireStaleTopics", () => {
  it("超过 3 天未选用 → 移入回收站(软删可恢复);3 天内的不动", async () => {
    const stale = await saveTopic({ title: "过期灵感", description: "d", tags: [] });
    const fresh = await saveTopic({ title: "新鲜灵感", description: "d", tags: [] });
    await ageTopic(stale.id, 4);

    const r = await expireStaleTopics();

    expect(r.total).toBe(1);
    expect(r.expiredByWorkspace).toEqual({ default: 1 });
    const active = await listTopics();
    expect(active.map((t) => t.id)).toEqual([fresh.id]);
    const trash = await listTrash();
    expect(trash.topics.map((t) => t.id)).toEqual([stale.id]); // 可恢复,且参与查重防还魂
  });

  it("续期过的老灵感不被回收(深调研启动即续期一次)", async () => {
    const renewed = await saveTopic({ title: "正在深调研", description: "d", tags: [] });
    await ageTopic(renewed.id, 10);
    await updateTopic(renewed.id, { renewedAt: new Date().toISOString() });

    const r = await expireStaleTopics();

    expect(r.total).toBe(0);
    expect((await listTopics()).map((t) => t.id)).toEqual([renewed.id]);
  });

  it("有稿件血缘(content.topicId 指向)的到期灵感被保护,永不自动清理", async () => {
    const used = await saveTopic({ title: "被选上的灵感", description: "d", tags: [] });
    await ageTopic(used.id, 10);
    await saveContent({
      title: "由它写成的稿", body: "b", platform: "wechat_mp",
      status: "draft_ready", tags: [], hashtags: [], topicId: used.id,
    });

    const r = await expireStaleTopics();

    expect(r.total).toBe(0);
    expect(r.protectedByLineage).toBe(1);
    expect((await listTopics()).map((t) => t.id)).toEqual([used.id]);
  });

  it("多工作区全扫;事件落对应工作区 events.jsonl;ttl 可注入", async () => {
    const ws = await createWorkspace("Muse");
    const t = await saveTopic({ title: "子区旧灵感", description: "d", tags: [] }, ws.dataDir);
    await ageTopic(t.id, 1, ws.dataDir); // 1 天旧

    // 注入 12h ttl → 1 天旧的也过期
    const r = await expireStaleTopics({ ttlMs: 12 * 3600_000 });

    expect(r.expiredByWorkspace[ws.id]).toBe(1);
    const events = await fs.readFile(path.join(ws.dataDir, "events.jsonl"), "utf-8");
    expect(events).toMatch(/灵感库清理/);
    expect(TOPIC_TTL_MS).toBe(3 * 24 * 3600_000); // 默认 3 天(创始人裁决)钉死
  });
});
