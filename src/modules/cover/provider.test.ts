/**
 * provider.test.ts — 封面生图 provider 解析:默认 relay、凭证复用 publish.json、
 * 模型覆盖顺序、gemini 回退。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCoverProvider, saveCoverSettings } from "./provider.js";

let dir: string;
let savedEnvKey: string | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-coverprovider-"));
  savedEnvKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  if (savedEnvKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedEnvKey;
});

async function seedRelay(model?: string): Promise<void> {
  await fs.writeFile(
    path.join(dir, "publish.json"),
    JSON.stringify({ wechatMp: { imageApiKey: "sk-relay", imageBaseUrl: "https://relay.test/v1", ...(model ? { imageModel: model } : {}) } }),
    "utf-8",
  );
}

describe("resolveCoverProvider", () => {
  it("空目录 → 默认 relay 且不可用,hint 指向 设置·发布", async () => {
    const r = await resolveCoverProvider(dir);
    expect(r.provider).toBe("relay");
    expect(r.relay).toBeNull();
    expect(r.ok).toBe(false);
    expect(r.hint).toContain("设置·发布");
  });

  it("publish.json 配好 → relay 可用;模型顺序 cover.relayModel > publish.imageModel > gpt-image-2", async () => {
    await seedRelay();
    let r = await resolveCoverProvider(dir);
    expect(r.ok).toBe(true);
    expect(r.relay!.model).toBe("gpt-image-2");

    await seedRelay("seedream-pro");
    r = await resolveCoverProvider(dir);
    expect(r.relay!.model).toBe("seedream-pro");

    await saveCoverSettings({ relayModel: "gpt-image-2-hd" }, dir);
    r = await resolveCoverProvider(dir);
    expect(r.relay!.model).toBe("gpt-image-2-hd");
    expect(r.relay!.apiKey).toBe("sk-relay");
    expect(r.relay!.baseUrl).toBe("https://relay.test/v1");
  });

  it("provider=gemini:file key 优先于 env;都无则不可用带 hint", async () => {
    await saveCoverSettings({ provider: "gemini" }, dir);
    let r = await resolveCoverProvider(dir);
    expect(r.provider).toBe("gemini");
    expect(r.ok).toBe(false);
    expect(r.hint).toContain("Gemini");

    process.env.GEMINI_API_KEY = "AIza-env";
    r = await resolveCoverProvider(dir);
    expect(r.ok).toBe(true);
    expect(r.gemini).toMatchObject({ apiKey: "AIza-env", source: "env" });

    await saveCoverSettings({ geminiApiKey: "AIza-file" }, dir);
    r = await resolveCoverProvider(dir);
    expect(r.gemini).toMatchObject({ apiKey: "AIza-file", source: "file" });
  });

  it("publish.json 坏 JSON 不炸——relay 视为未配", async () => {
    await fs.writeFile(path.join(dir, "publish.json"), "{broken", "utf-8");
    const r = await resolveCoverProvider(dir);
    expect(r.relay).toBeNull();
    expect(r.ok).toBe(false);
  });
});
