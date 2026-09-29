/** 设置页的 TypeSafe key（发布前把关 §12）：写本机 secrets/typesafe-api-key（600），不进 publish.json，读回只给来源不给值 */
import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getPublishSettings, setPublishSettings } from "./settings.js";

let dir: string;
const envBefore = { local: process.env.AUTOCREW_LOCAL_DIR, key: process.env.TYPESAFE_API_KEY };
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ts-settings-"));
  process.env.AUTOCREW_LOCAL_DIR = dir;
  delete process.env.TYPESAFE_API_KEY;
});
afterEach(async () => {
  if (envBefore.local === undefined) delete process.env.AUTOCREW_LOCAL_DIR; else process.env.AUTOCREW_LOCAL_DIR = envBefore.local;
  if (envBefore.key !== undefined) process.env.TYPESAFE_API_KEY = envBefore.key;
  await fs.rm(dir, { recursive: true, force: true });
});

it("只填 TypeSafe key 也能保存；值不回显，只报来源", async () => {
  expect(await getPublishSettings({ _dataDir: dir })).toMatchObject({ ok: true, data: { typesafeKeySource: null } });
  const r = await setPublishSettings({ _dataDir: dir, typesafe_api_key: "ts-secret-1" });
  expect(r).toMatchObject({ ok: true, data: { typesafeKeySource: "file" } });
  expect(JSON.stringify(r)).not.toContain("ts-secret-1");
  const file = path.join(dir, "secrets", "typesafe-api-key");
  expect(await fs.readFile(file, "utf8")).toBe("ts-secret-1");
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  const publishJson = await fs.readFile(path.join(dir, "publish.json"), "utf8").catch(() => "");
  expect(publishJson).not.toContain("ts-secret-1");
  expect(await setPublishSettings({ _dataDir: dir, typesafe_api_key: "  " })).toMatchObject({ ok: false });
});
