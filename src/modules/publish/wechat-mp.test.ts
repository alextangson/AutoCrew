/**
 * wechat-mp.test.ts — 推送组装层:显式 coverPath(封面设计师选用封面)优先,
 * 跳过"文中第一图/fallback 生成"兜底。零网络:dryRun + 无 [IMAGE:] 稿件。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishWechatMpDraft, wechatPublishEnv } from "./wechat-mp.js";

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

  it("preparedImages → 复用稿件页已确认配图，不再调用生图链", async () => {
    const articlePath = path.join(dir, "draft.md");
    await fs.writeFile(articlePath, "# 标题\n\n[IMAGE: 正文中的第一张图]\n", "utf-8");
    const coverPath = path.join(dir, "封面.png");
    const preparedPath = path.join(dir, "approved-body-image.png");
    await fs.writeFile(coverPath, "cover-bytes");
    await fs.writeFile(preparedPath, "approved-image-bytes");

    const r = await publishWechatMpDraft({
      articlePath,
      dryRun: true,
      coverPath,
      preparedImages: [preparedPath],
    });
    expect(r.ok).toBe(true);
    expect(r.imageCount).toBe(1);
    expect(await fs.readFile(path.join(dir, "images", "img-01.png"), "utf-8")).toBe("approved-image-bytes");
    expect(await fs.readFile(r.publishInput, "utf-8")).toContain("![正文中的第一张图](images/img-01.png)");
  });
});

describe("wechatPublishEnv(凭证经 env 传给 publish.py,脚本 config.json 退居兜底)", () => {
  it("appid+secret 齐全 → 注入 WECHAT_APP_ID/SECRET;openComment → WECHAT_OPEN_COMMENT=1", () => {
    expect(wechatPublishEnv({ wechatAppId: "wx1", wechatAppSecret: "s1", openComment: true })).toEqual({
      WECHAT_APP_ID: "wx1",
      WECHAT_APP_SECRET: "s1",
      WECHAT_OPEN_COMMENT: "1",
    });
  });
  it("缺任一凭证 → 不注入半套;默认关留言 → 无 WECHAT_OPEN_COMMENT", () => {
    expect(wechatPublishEnv({ wechatAppId: "wx1" })).toEqual({});
    expect(wechatPublishEnv({})).toEqual({});
  });
});
