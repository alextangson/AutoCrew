/**
 * orphan-reconcile.test.ts — server 重启孤儿占位稿清理（SESSION-8 §3.1）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reconcileOrphanDrafts } from "./orphan-reconcile.js";
import { createWorkspace } from "./workspace-store.js";
import { saveContent, getContent } from "../storage/local-store.js";
import {
  GENERATING_TITLE_PREFIX,
  INTERRUPTED_TITLE_PREFIX,
  RESEARCHING_TITLE_PREFIX,
} from "../modules/writing/generate-script.js";

let tmpHome: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-reconcile-test-"));
  savedEnv = process.env.AUTOCREW_DATA_DIR;
  process.env.AUTOCREW_DATA_DIR = tmpHome;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.AUTOCREW_DATA_DIR;
  else process.env.AUTOCREW_DATA_DIR = savedEnv;
  await fs.rm(tmpHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function placeholder(topic: string) {
  return {
    title: `${GENERATING_TITLE_PREFIX}${topic}`,
    body: "",
    platform: "wechat_mp",
    status: "drafting",
    tags: [],
    hashtags: [],
  };
}

describe("reconcileOrphanDrafts", () => {
  it("孤儿占位稿 → 标题换中断前缀 + lastError,status 保持 drafting(与运行时失败同形状)", async () => {
    const orphan = await saveContent(placeholder("AI 编辑部"));
    const r = await reconcileOrphanDrafts();

    expect(r.total).toBe(1);
    expect(r.markedByWorkspace).toEqual({ default: 1 });
    const c = await getContent(orphan.id);
    expect(c!.title).toBe(`${INTERRUPTED_TITLE_PREFIX}AI 编辑部`);
    expect(c!.lastError).toMatch(/server 重启/);
    expect(c!.status).toBe("drafting");
  });

  it("崩在等调研简报那一段的孤儿(［调研中］)同样被标中断——只认「生成中」就扫不到它", async () => {
    const orphan = await saveContent({
      ...placeholder("等简报时崩的稿"),
      title: `${RESEARCHING_TITLE_PREFIX}等简报时崩的稿`,
    });

    const r = await reconcileOrphanDrafts();

    expect(r.total).toBe(1);
    const c = await getContent(orphan.id);
    expect(c!.title).toBe(`${INTERRUPTED_TITLE_PREFIX}等简报时崩的稿`); // 按各自前缀长度剥
    expect(c!.lastError).toMatch(/server 重启/);
  });

  it("不误伤:手工 drafting 稿(无哨兵前缀)、已标失败的稿、非 drafting 稿都不动", async () => {
    const manual = await saveContent({
      title: "手工存的半成品", body: "草稿内容", platform: "wechat_mp",
      status: "drafting", tags: [], hashtags: [],
    });
    const alreadyFailed = await saveContent({
      ...placeholder("已失败的稿"),
      title: `${INTERRUPTED_TITLE_PREFIX}已失败的稿`,
      lastError: "空闲超时:45s 无字节",
    });
    const done = await saveContent({
      title: "成品稿", body: "正文", platform: "wechat_mp",
      status: "draft_ready", tags: [], hashtags: [],
    });

    const r = await reconcileOrphanDrafts();

    expect(r.total).toBe(0);
    expect((await getContent(manual.id))!.title).toBe("手工存的半成品");
    expect((await getContent(manual.id))!.lastError ?? null).toBeNull();
    expect((await getContent(alreadyFailed.id))!.lastError).toBe("空闲超时:45s 无字节");
    expect((await getContent(done.id))!.status).toBe("draft_ready");
  });

  it("多工作区全扫:子工作区的孤儿也被标记,事件落对应工作区的 events.jsonl", async () => {
    await saveContent(placeholder("默认区的稿"));
    const ws = await createWorkspace("Muse");
    const sub = await saveContent(placeholder("子区的稿"), ws.dataDir);

    const r = await reconcileOrphanDrafts();

    expect(r.total).toBe(2);
    expect(r.markedByWorkspace).toEqual({ default: 1, [ws.id]: 1 });
    const c = await getContent(sub.id, ws.dataDir);
    expect(c!.title).toBe(`${INTERRUPTED_TITLE_PREFIX}子区的稿`);
    const events = await fs.readFile(path.join(ws.dataDir, "events.jsonl"), "utf-8");
    expect(events).toMatch(/标记中断/);
  });

  it("幂等:第二次运行不再标记(lastError 已存在)", async () => {
    await saveContent(placeholder("反复重启"));
    await reconcileOrphanDrafts();
    const r2 = await reconcileOrphanDrafts();
    expect(r2.total).toBe(0);
  });
});
