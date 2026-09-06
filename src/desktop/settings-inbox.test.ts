import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getInboxSettings, getInboxSettingsRaw, setInboxSettings } from "./settings-inbox.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-inbox-settings-"));
  await setInboxSettings({ _rootDir: tmp, bot_token: "123:abc", allowed_user_ids: ["7"] });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

const read = async (): Promise<Record<string, unknown>> =>
  (await getInboxSettings({ _rootDir: tmp })).data as Record<string, unknown>;

describe("收件箱配置 · 每日选题摘要字段（摘要 spec §2.5）", () => {
  it("缺省 = 开、9 点（老配置文件里没有这两个键也照样有缺省）", async () => {
    expect(await read()).toMatchObject({ digestEnabled: true, digestHour: 9 });
    expect(await getInboxSettingsRaw(tmp)).not.toHaveProperty("digestHour");
  });

  it("digest_enabled / digest_hour 往返：写进去、读出来、落盘也是它", async () => {
    const res = await setInboxSettings({ _rootDir: tmp, digest_enabled: false, digest_hour: 21 });
    expect(res.ok).toBe(true);
    expect(await read()).toMatchObject({ digestEnabled: false, digestHour: 21 });
    expect(await getInboxSettingsRaw(tmp)).toMatchObject({ digestEnabled: false, digestHour: 21 });
  });

  it("前端把开关序列化成字符串也认（边界上兜死，不指望前端）", async () => {
    await setInboxSettings({ _rootDir: tmp, digest_enabled: "0", digest_hour: "6" });
    expect(await read()).toMatchObject({ digestEnabled: false, digestHour: 6 });
    await setInboxSettings({ _rootDir: tmp, digest_enabled: "1" });
    expect(await read()).toMatchObject({ digestEnabled: true });
  });

  it("小时超范围 / 非整数 / 非布尔一律当场拒，不写坏盘", async () => {
    for (const bad of [24, -1, 9.5, "晚上"]) {
      const res = await setInboxSettings({ _rootDir: tmp, digest_hour: bad });
      expect(res.ok).toBe(false);
      expect(String(res.error)).toContain("0–23");
    }
    const res = await setInboxSettings({ _rootDir: tmp, digest_enabled: "开" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("布尔");
    expect(await read()).toMatchObject({ digestEnabled: true, digestHour: 9 });
  });

  it("只提交摘要字段也算「有可写入的字段」（不必连 bot token 一起交）", async () => {
    const res = await setInboxSettings({ _rootDir: tmp, digest_hour: 7 });
    expect(res.ok).toBe(true);
    expect(await getInboxSettingsRaw(tmp)).toMatchObject({ botToken: "123:abc", digestHour: 7 });
  });
});
