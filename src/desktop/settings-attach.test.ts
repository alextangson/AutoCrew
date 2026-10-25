/** settings:engine_attach_preset（spec 2026-10-25-tokencamel-touchpoint §4.3 / §8-5）：只多一条、只改一个指针。 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPresetEndpoint } from "./settings-attach.js";
import { getEngineSettings } from "./settings-engine.js";
import { setOfferPresetPathForTest } from "./settings-offer.js";

let dir: string;
const enginePath = () => path.join(dir, "engine.json");
const readEngine = async () => JSON.parse(await fs.readFile(enginePath(), "utf-8")) as Record<string, unknown>;
const revision = async () => ((await getEngineSettings({ _dataDir: dir })) as { data: { revision: string } }).data.revision;

const BASE = {
  version: 2,
  providers: [
    { id: "deepseek", name: "DeepSeek 官方", baseUrl: "https://api.deepseek.com", apiKey: "sk-ds-0001", models: ["deepseek-v4-pro", "deepseek-v4-flash"] },
    { id: "relay", name: "Claude 中转", baseUrl: "https://relay.example.com/claude", apiKey: "sk-relay-0002", models: ["claude-opus-4-8"] },
  ],
  main: { provider: "deepseek", strong: "deepseek-v4-pro", fast: "deepseek-v4-flash" },
  assignments: { writer: { provider: "relay", model: "claude-opus-4-8" } },
};

const attach = (over: Record<string, unknown>) =>
  attachPresetEndpoint({ _dataDir: dir, as: "fallback", api_key: "sk-camel-0003", strong: "DeepSeek-V4-Pro", fast: "DeepSeek-V4-Flash", ...over });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-attach-"));
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("DEEPSEEK_BASE_URL", "");
});
afterEach(async () => {
  setOfferPresetPathForTest();
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("settings:engine_attach_preset", () => {
  it("as fallback：只多一条、只改 fallback 指针，其余逐字段不变", async () => {
    await fs.writeFile(enginePath(), JSON.stringify(BASE));
    const r = await attach({ revision: await revision() });
    expect(r.ok).toBe(true);
    const after = await readEngine();
    const providers = after.providers as Array<Record<string, unknown>>;
    expect(providers.slice(0, 2)).toEqual(BASE.providers);
    expect(providers).toHaveLength(3);
    expect(providers[2]).toMatchObject({ id: "tokencamel", baseUrl: "https://api.tokencamel.com/v1", apiKey: "sk-camel-0003" });
    expect(after.main).toEqual(BASE.main);
    expect(after.assignments).toEqual(BASE.assignments);
    expect(after.fallback).toEqual({ provider: "tokencamel", strong: "DeepSeek-V4-Pro", fast: "DeepSeek-V4-Flash" });
  });

  it("E5：主指针坏了、表里还有别的端点 → 追加并指为主，其他端点原样保留", async () => {
    await fs.writeFile(enginePath(), JSON.stringify({ ...BASE, main: { provider: "gone", strong: "x", fast: "y" }, assignments: undefined }));
    expect(((await getEngineSettings({ _dataDir: dir })) as { data: { configured: boolean } }).data.configured).toBe(false);
    const r = await attach({ as: "main", revision: await revision() });
    expect(r.ok).toBe(true);
    const after = await readEngine();
    expect((after.providers as unknown[]).slice(0, 2)).toEqual(BASE.providers);
    expect(after.main).toEqual({ provider: "tokencamel", strong: "DeepSeek-V4-Pro", fast: "DeepSeek-V4-Flash" });
    expect(after.fallback).toBeUndefined();
  });

  it("空配置（没有文件）→ 新建只含这一条的表", async () => {
    const r = await attach({ as: "main", revision: "" });
    expect(r.ok).toBe(true);
    expect(((await readEngine()).providers as unknown[]).length).toBe(1);
  });

  it("E6：表里已有同 baseUrl → 不新建，提示已接过，文件不动", async () => {
    const withCamel = { ...BASE, providers: [...BASE.providers, { id: "mine", name: "我的骆驼", baseUrl: "https://api.tokencamel.com/v1", apiKey: "sk-old", models: ["m"] }] };
    await fs.writeFile(enginePath(), JSON.stringify(withCamel));
    const before = await fs.readFile(enginePath(), "utf-8");
    const r = await attach({ revision: await revision() });
    expect(r).toMatchObject({ ok: false, code: "already" });
    expect(String(r.error)).toContain("你已经接过 TokenCamel（端点名 我的骆驼）");
    expect(await fs.readFile(enginePath(), "utf-8")).toBe(before);
  });

  it("E7：已有 id tokencamel 但地址不同 → 新端点用 tokencamel-2", async () => {
    const taken = { ...BASE, providers: [...BASE.providers, { id: "tokencamel", name: "别的", baseUrl: "https://other.example.com/v1", apiKey: "sk-x", models: ["m"] }] };
    await fs.writeFile(enginePath(), JSON.stringify(taken));
    const r = await attach({ revision: await revision() });
    expect(r.ok).toBe(true);
    expect((r.data as { providerId: string }).providerId).toBe("tokencamel-2");
    expect((await readEngine()).fallback).toMatchObject({ provider: "tokencamel-2" });
  });

  it("E13：版本不一致拒绝；双击（同一 revision 并发两次）最终表里只有一条", async () => {
    await fs.writeFile(enginePath(), JSON.stringify(BASE));
    expect(await attach({ revision: "stale-0000" })).toMatchObject({ ok: false, code: "stale" });
    const rev = await revision();
    const [a, b] = await Promise.all([attach({ revision: rev }), attach({ revision: rev })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const camels = ((await readEngine()).providers as Array<{ baseUrl: string }>).filter((p) => p.baseUrl.includes("tokencamel"));
    expect(camels).toHaveLength(1);
  });

  it("没有预设 / 缺字段：拒绝且不写盘", async () => {
    expect((await attach({ as: "both", revision: "" })).ok).toBe(false);
    expect((await attach({ api_key: " ", revision: "" })).ok).toBe(false);
    setOfferPresetPathForTest(path.join(dir, "missing.json"));
    expect((await attach({ revision: "" })).ok).toBe(false);
    await expect(fs.access(enginePath())).rejects.toThrow();
  });
});
