/** Jev 直连（spec §12、E7）：密钥来源、600 权限、失败原因是人话且不含密钥、返回形状逐项核对 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JEV_ENDPOINT, JEV_MODEL, JevError, makeJevCaller, parseJevBody, resolveTypesafeKey, typesafeKeyFile, writeTypesafeKey, type JevQuestion } from "./jev-client.js";

let dir: string;
const saved = process.env.TYPESAFE_API_KEY;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "jev-")); delete process.env.TYPESAFE_API_KEY; });
afterEach(async () => { if (saved === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = saved; await fs.rm(dir, { recursive: true, force: true }); });

const Q: Record<string, JevQuestion> = { n: { type: "noul", instructions: "?" }, c: { type: "choice", instructions: "?", criteria: { 甲: null, 乙: null } } };
const GOOD = { model: JEV_MODEL, answers: { n: { type: "noul", noul: 0.9 }, c: { type: "choice", choice: "甲", probabilities: { 甲: 0.8, 乙: 0.2 }, confidence: 0.7 } }, usage: { input_tokens: 300, output_tokens: 10 } };
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("密钥", () => {
  it("环境变量优先，其次本机文件；都没有 → null", async () => {
    expect(await resolveTypesafeKey(dir)).toEqual({ key: null, source: null });
    await writeTypesafeKey("file-key", dir);
    expect(await resolveTypesafeKey(dir)).toEqual({ key: "file-key", source: "file" });
    process.env.TYPESAFE_API_KEY = "env-key";
    expect(await resolveTypesafeKey(dir)).toEqual({ key: "env-key", source: "env" });
  });

  it("设置页写的就是 secrets/typesafe-api-key，600 权限，不带换行", async () => {
    await writeTypesafeKey("  k-123  ", dir);
    const file = typesafeKeyFile(dir);
    expect(file).toBe(path.join(dir, "secrets", "typesafe-api-key"));
    expect(await fs.readFile(file, "utf8")).toBe("k-123");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await expect(writeTypesafeKey("   ", dir)).rejects.toThrow();
  });
});

describe("调用", () => {
  it("请求：钉 jev-1.13.0、Bearer 头、state 与 questions 原样", async () => {
    process.env.TYPESAFE_API_KEY = "k-test-12345678";
    let seen: { url: string; init: RequestInit } | null = null;
    const r = await makeJevCaller({ fetchImpl: (async (url: string, init: RequestInit) => { seen = { url, init }; return res(200, GOOD); }) as unknown as typeof fetch })({ a: 1 }, Q);
    expect(seen!.url).toBe(JEV_ENDPOINT);
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer k-test-12345678");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ model: "jev-1.13.0", state: { a: 1 }, questions: Q });
    expect(r.usage.input_tokens).toBe(300);
  });

  it.each([
    [401, /拒绝了密钥/], [429, /限流/], [503, /服务出错/], [422, /请求形状不对/],
  ])("HTTP %i → JevError 人话原因，不含密钥", async (status, re) => {
    process.env.TYPESAFE_API_KEY = "secret-k";
    const call = makeJevCaller({ fetchImpl: (async () => res(status, { error: "x" })) as unknown as typeof fetch });
    const err = await call({}, Q).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect(err.reason).toMatch(re);
    expect(err.reason).not.toContain("secret-k");
  });

  it("没密钥 / 超时 / 连不上 → JevError", async () => {
    await expect(makeJevCaller({ machineDir: dir })({}, Q)).rejects.toMatchObject({ reason: expect.stringMatching(/没配 TypeSafe 密钥/) });
    process.env.TYPESAFE_API_KEY = "k-test-12345678";
    const slow = (async (_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
    await expect(makeJevCaller({ fetchImpl: slow, timeoutMs: 20 })({}, Q)).rejects.toMatchObject({ reason: expect.stringMatching(/超时/) });
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(makeJevCaller({ fetchImpl: down })({}, Q)).rejects.toMatchObject({ reason: expect.stringMatching(/连不上/) });
  });

  it("返回形状不对：缺答案、类型不对、选项不在 criteria、概率越界、缺 usage", () => {
    expect(() => parseJevBody({ answers: { n: GOOD.answers.n } , usage: GOOD.usage }, Q, 1)).toThrow(/问题 c/);
    expect(() => parseJevBody({ ...GOOD, answers: { ...GOOD.answers, n: { type: "noul", noul: 1.5 } } }, Q, 1)).toThrow(/问题 n/);
    expect(() => parseJevBody({ ...GOOD, answers: { ...GOOD.answers, c: { ...GOOD.answers.c, choice: "丙" } } }, Q, 1)).toThrow(/问题 c/);
    expect(() => parseJevBody({ ...GOOD, usage: {} }, Q, 1)).toThrow(/usage/);
    expect(parseJevBody(GOOD, Q, 7).ms).toBe(7);
  });
});
