/**
 * wechat-mp.test.ts — 推送组装层:显式 coverPath(封面设计师选用封面)优先,
 * 跳过"文中第一图/fallback 生成"兜底。零网络:dryRun + 无 [IMAGE:] 稿件。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishWechatMpDraft } from "./wechat-mp.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-wechatmp-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("publishWechatMpDraft coverPath", () => {
  it("显式 coverPath → 直接作为封面,无图稿件不再触发 fallback 生成(dryRun 命令含该封面)", async () => {
    const articlePath = path.join(dir, "draft.md");
    await fs.writeFile(articlePath, "# 标题\n\n正文没有配图标记\n", "utf-8");
    const coverPath = path.join(dir, "封面.png");
    await fs.writeFile(coverPath, "png-bytes");

    const r = await publishWechatMpDraft({ articlePath, dryRun: true, coverPath });
    expect(r.ok).toBe(true);
    expect(r.coverPath).toBe(coverPath);
    expect(String(r.command)).toContain(coverPath);
  });
});
