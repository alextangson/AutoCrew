/**
 * status.test.ts — `autocrew_status brief`：SessionStart hook 注入的一行待办（P6 §3.2）。
 * 钉的是四个桶的判据，尤其是和待办桌同口径的那两个（待写 = 写手桌 + drafting，已派工 = 剪辑师桌）。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeStatus } from "./status.js";
import {
  approveCoverVariant,
  saveContent,
  saveCoverReview,
  saveTopic,
  transitionStatus,
  updateContent,
  updateTopic,
  type ContentStatus,
} from "../storage/local-store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-status-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function seedTopic(title: string, withAngle = true): Promise<string> {
  const topic = await saveTopic({ title, description: "描述", tags: [] }, dir);
  if (withAngle) {
    await updateTopic(topic.id, {
      selectedAngle: {
        briefRevision: 1,
        angleId: "angle-1",
        card: { id: "angle-1", angle: "算一笔账", thesis: "省下的被吃回去了" } as never,
        selectedAt: new Date().toISOString(),
      },
    }, dir);
  }
  return topic.id;
}

async function seedContent(status: ContentStatus, platform: string, topicId?: string): Promise<string> {
  const c = await saveContent(
    { title: `稿-${status}-${platform}`, body: "正文", platform, status, tags: [], hashtags: [], ...(topicId ? { topicId } : {}) },
    dir,
  );
  return c.id;
}

/** 视频稿进待发布只有封面台一个入口（阶段门，强推也不让）：成片审过 → 封面定稿 → 封面台 → 待发布 */
async function seedPublishReady(platform: string): Promise<string> {
  const id = await seedContent("editing", platform);
  await updateContent(id, { videoDone: { renderedRevision: 1, at: "2026-09-25T00:00:00.000Z" } }, dir);
  await saveCoverReview(id, { platform, status: "review_pending", variants: [{ label: "a", imagePaths: { "3:4": "/tmp/a.png" } }] }, dir);
  await approveCoverVariant(id, "a", dir);
  expect(await transitionStatus(id, "cover_pending", undefined, dir)).toMatchObject({ ok: true });
  expect(await transitionStatus(id, "publish_ready", undefined, dir)).toMatchObject({ ok: true });
  return id;
}

describe("autocrew_status brief", () => {
  it("空数据目录：四个桶都是 0", async () => {
    const r = await executeStatus({ brief: true, _dataDir: dir });
    expect(r).toMatchObject({ ok: true, brief: "0 待写 / 0 等 A-roll / 0 已派工待登记 / 0 待发布" });
  });

  it("按判据分桶：待写 / 等 A-roll / 已派工待登记 / 待发布", async () => {
    // 待写：已选立意没稿（含只剩归档稿的）+ 退回修订 + 包已发出没回稿
    await seedTopic("有立意没稿");
    await seedContent("archived", "douyin", await seedTopic("只剩归档稿"));
    await seedTopic("没选立意", false);
    await seedContent("revision", "wechat_mp");
    await seedContent("drafting", "douyin");
    // 等 A-roll：视频稿 draft_ready / approved；公众号的 approved 不算
    await seedContent("draft_ready", "douyin", await seedTopic("已有稿的选题"));
    await seedContent("approved", "xiaohongshu");
    await seedContent("approved", "wechat_mp");
    // 已派工待登记：在剪辑台、这一版成片还没审过；审过片的不算
    await seedContent("editing", "douyin");
    const reviewed = await seedContent("editing", "wechat_video");
    await updateContent(reviewed, { videoDone: { renderedRevision: 1, at: "2026-09-25T00:00:00.000Z" } }, dir);
    // 待发布：不分平台
    await seedContent("publish_ready", "wechat_mp");
    await seedPublishReady("douyin");
    const shipped = await seedPublishReady("douyin");
    expect(await transitionStatus(shipped, "published", { force: true }, dir)).toMatchObject({ ok: true });

    const r = await executeStatus({ brief: true, _dataDir: dir });
    expect(r).toMatchObject({
      ok: true,
      brief: "4 待写 / 2 等 A-roll / 1 已派工待登记 / 2 待发布",
      counts: { to_write: 4, awaiting_aroll: 2, dispatched: 1, publish_ready: 2 },
    });
  });

  it("不带 brief 的 overview 照旧", async () => {
    await seedContent("publish_ready", "wechat_mp");
    const r = await executeStatus({ _dataDir: dir });
    expect(r).toMatchObject({ ok: true, action: "overview", contents: 1, contentsByStatus: { publish_ready: 1 } });
    expect(r).not.toHaveProperty("brief");
  });
});
