import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getPublishSettings,
  setPublishSettings,
  getInboxSettings,
  setInboxSettings,
  getInboxSettingsRaw,
  onInboxSettingsChanged,
} from "./settings.js";

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-settings-test-"));
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("DEEPSEEK_BASE_URL", "");
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  vi.unstubAllEnvs();
});

describe("publish settings 公众号绑定(可视化配置)", () => {
  it("写 appid/secret/留言开关 → 读回掩码与状态,secret 永不回显", async () => {
    const w = await setPublishSettings({
      wechat_app_id: "wx1234567890abcdef",
      wechat_app_secret: "supersecretvalue42",
      open_comment: "1",
      _dataDir: testDir,
    });
    expect(w.ok).toBe(true);
    const r = await getPublishSettings({ _dataDir: testDir });
    const d = r.data as Record<string, unknown>;
    expect(d.wechatConfigured).toBe(true);
    expect(d.wechatAppIdMasked).toBe("wx12…cdef");
    expect(d.openComment).toBe(true);
    expect(JSON.stringify(r)).not.toContain("supersecretvalue");
  });

  it("未绑定时 wechatConfigured=false;open_comment 拒绝非法值", async () => {
    const r = await getPublishSettings({ _dataDir: testDir });
    const d = r.data as Record<string, unknown>;
    expect(d.wechatConfigured).toBe(false);
    const bad = await setPublishSettings({ open_comment: "maybe", _dataDir: testDir });
    expect(bad.ok).toBe(false);
  });
});

describe("inbox settings(收件箱 · 全局根 inbox.json,不随工作区)", () => {
  const TOKEN = "8123456789:AAHveryverysecrettoken9876";
  const PROXY = "http://alice:hunter2@proxy.example.com:7890";
  // testDir 在这一组里当「全局根」用(_rootDir),不是工作区 dataDir
  const inboxPath = () => path.join(testDir, "inbox.json");
  const unsubs: Array<() => void> = [];

  afterEach(() => {
    while (unsubs.length) unsubs.pop()?.();
  });

  it("roundtrip:写全字段 → 落全局根 inbox.json,worker 侧读回原始值", async () => {
    const res = await setInboxSettings({
      _rootDir: testDir,
      bot_token: TOKEN,
      allowed_user_ids: ["7788990011", " 4455667788 ", "7788990011"],
      target_workspace_id: "ws-muse",
      proxy_url: "http://127.0.0.1:7890",
    });
    expect(res.ok).toBe(true);
    const d = res.data as Record<string, unknown>;
    expect(d.configured).toBe(true);
    expect(d.allowedUserIds).toEqual(["7788990011", "4455667788"]); // trim + 去重
    expect(d.targetWorkspaceId).toBe("ws-muse");

    // 落盘位置就是全局根,不是任何工作区子目录
    const onDisk = JSON.parse(await fs.readFile(inboxPath(), "utf-8"));
    expect(onDisk.botToken).toBe(TOKEN);

    const raw = await getInboxSettingsRaw(testDir);
    expect(raw?.botToken).toBe(TOKEN);
    expect(raw?.proxyUrl).toBe("http://127.0.0.1:7890");
    expect(raw?.allowedUserIds).toEqual(["7788990011", "4455667788"]);
  });

  it("未配置时 configured=false,raw 读回 null", async () => {
    const r = await getInboxSettings({ _rootDir: testDir });
    const d = r.data as Record<string, unknown>;
    expect(d.configured).toBe(false);
    expect(d.botTokenMasked).toBeNull();
    expect(d.allowedUserIds).toEqual([]);
    expect(d.targetWorkspaceId).toBe("default");
    expect(await getInboxSettingsRaw(testDir)).toBeNull();
  });

  it("读侧掩码:token 走既有掩码格式,proxy 只脱敏凭证段", async () => {
    await setInboxSettings({ _rootDir: testDir, bot_token: TOKEN, proxy_url: PROXY });
    const r = await getInboxSettings({ _rootDir: testDir });
    const d = r.data as Record<string, unknown>;
    expect(d.botTokenMasked).toBe("8123…9876");
    expect(d.proxyUrlMasked).toBe("http://***:***@proxy.example.com:7890");
    expect(JSON.stringify(r)).not.toContain("veryverysecret");
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  it("无凭证的代理串原样回显(不误伤)", async () => {
    await setInboxSettings({ _rootDir: testDir, bot_token: TOKEN, proxy_url: "socks5://127.0.0.1:1080" });
    const d = (await getInboxSettings({ _rootDir: testDir })).data as Record<string, unknown>;
    expect(d.proxyUrlMasked).toBe("socks5://127.0.0.1:1080");
  });

  it("掩码值原样回传不覆盖真值(token 与 proxy 都兜死)", async () => {
    await setInboxSettings({ _rootDir: testDir, bot_token: TOKEN, proxy_url: PROXY });
    const masked = (await getInboxSettings({ _rootDir: testDir })).data as Record<string, unknown>;

    const res = await setInboxSettings({
      _rootDir: testDir,
      bot_token: masked.botTokenMasked as string,
      proxy_url: masked.proxyUrlMasked as string,
      allowed_user_ids: ["12345"], // 只改了白名单
    });
    expect(res.ok).toBe(true);

    const raw = await getInboxSettingsRaw(testDir);
    expect(raw?.botToken).toBe(TOKEN);
    expect(raw?.proxyUrl).toBe(PROXY);
    expect(raw?.allowedUserIds).toEqual(["12345"]);
  });

  it("换 token 清掉 botId(交回 getMe 重新锁定);同 token 重存则保留", async () => {
    await setInboxSettings({ _rootDir: testDir, bot_token: TOKEN, bot_id: "8123456789" });
    expect((await getInboxSettingsRaw(testDir))?.botId).toBe("8123456789");

    await setInboxSettings({ _rootDir: testDir, bot_token: TOKEN }); // 原值重存
    expect((await getInboxSettingsRaw(testDir))?.botId).toBe("8123456789");

    await setInboxSettings({ _rootDir: testDir, bot_token: "9999999999:AAnewbotdifferenttoken00" });
    expect((await getInboxSettingsRaw(testDir))?.botId).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("落盘 600 权限,预存的松权限文件也收紧", async () => {
    await fs.writeFile(inboxPath(), JSON.stringify({ botToken: "old-token-value" }), { mode: 0o644 });
    await setInboxSettings({ _rootDir: testDir, bot_token: TOKEN });
    expect((await fs.stat(inboxPath())).mode & 0o777).toBe(0o600);
  });

  it("变更回调:保存后触发并拿到原始配置;无实变更不触发;退订后不再触发", async () => {
    const seen: string[] = [];
    unsubs.push(onInboxSettingsChanged((s) => seen.push(s.botToken)));

    await setInboxSettings({ _rootDir: testDir, bot_token: TOKEN });
    expect(seen).toEqual([TOKEN]);

    await setInboxSettings({ _rootDir: testDir, bot_token: TOKEN }); // 原值重存 = 无实变更
    expect(seen).toHaveLength(1);

    unsubs.pop()?.();
    await setInboxSettings({ _rootDir: testDir, allowed_user_ids: ["999"] });
    expect(seen).toHaveLength(1);
  });

  it("回调抛错不拖垮保存(配置已落盘)", async () => {
    unsubs.push(onInboxSettingsChanged(() => { throw new Error("worker 重启失败"); }));
    const res = await setInboxSettings({ _rootDir: testDir, bot_token: TOKEN });
    expect(res.ok).toBe(true);
    expect((await getInboxSettingsRaw(testDir))?.botToken).toBe(TOKEN);
  });

  it("坏输入当场拒:空 token / 非数字白名单 / 空 payload", async () => {
    expect((await setInboxSettings({ _rootDir: testDir, bot_token: "  " })).ok).toBe(false);
    const badIds = await setInboxSettings({ _rootDir: testDir, allowed_user_ids: ["@alexchat"] });
    expect(badIds.ok).toBe(false);
    expect(String(badIds.error)).toContain("@alexchat");
    expect((await setInboxSettings({ _rootDir: testDir, allowed_user_ids: [7788990011] })).ok).toBe(false);
    expect((await setInboxSettings({ _rootDir: testDir })).ok).toBe(false);
    // 拒掉的都没落盘
    expect(await getInboxSettingsRaw(testDir)).toBeNull();
  });

  it("justoneapi key(抖音解析):掩码读、掩码回传不覆盖真值、空串清空", async () => {
    const KEY = "jo-live-abcdefghijklmnop-9999";
    await setInboxSettings({ _rootDir: testDir, bot_token: TOKEN, justoneapi_key: KEY });

    const masked = (await getInboxSettings({ _rootDir: testDir })).data as Record<string, unknown>;
    expect(masked.justoneapiConfigured).toBe(true);
    expect(masked.justoneapiKeyMasked).toBe("jo-l…9999");
    expect(JSON.stringify(masked)).not.toContain("abcdefghijklmnop");
    expect((await getInboxSettingsRaw(testDir))?.justoneapiKey).toBe(KEY);

    // 掩码原样回传 = 用户没动这一格,真值必须留住
    await setInboxSettings({
      _rootDir: testDir,
      justoneapi_key: masked.justoneapiKeyMasked as string,
      allowed_user_ids: ["12345"],
    });
    expect((await getInboxSettingsRaw(testDir))?.justoneapiKey).toBe(KEY);

    // 空串 = 显式清空(与 proxy_url 同口径)
    await setInboxSettings({ _rootDir: testDir, justoneapi_key: "" });
    expect((await getInboxSettingsRaw(testDir))?.justoneapiKey).toBeUndefined();
    const cleared = (await getInboxSettings({ _rootDir: testDir })).data as Record<string, unknown>;
    expect(cleared.justoneapiConfigured).toBe(false);
    expect(cleared.justoneapiKeyMasked).toBeNull();
  });
});
