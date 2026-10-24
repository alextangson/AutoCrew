/**
 * Phase 3 Codex 审的回归：脚本是正文唯一来源、字幕文字只取批过的脚本、密钥不外泄、冻结时不留半截、
 * 中途失败重试不重复花钱、坏时间戳不缓存、放慢倍数不靠取整过关。ElevenLabs 全部 mock。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getContent, updateContent } from "../../storage/local-store.js";
import { readProductionDocOrEmpty, writeProductionDoc } from "../../storage/production-store.js";
import { executeContentSave } from "../../tools/content-save.js";
import { executeEnEdition } from "../../tools/en-edition.js";
import { setDurationProbe } from "./dub.js";
import { setElevenLabsFetch, setKeychainReader } from "../voice/elevenlabs.js";
import { planTiming, slowdownRefusal } from "../voice/timing.js";
import { alignApproved } from "./captions.js";
import { readEnScript } from "./script.js";
import { approveEnScript, enSourceVideo, fakeAlignment, fakeElevenLabs, SEGMENTS } from "./en-test-fixtures.js";
import type { Env } from "../production/testkit.js";

let env: Env;
let id: string;
const run = (p: Record<string, unknown>) => executeEnEdition({ _dataDir: env.dir, content_id: id, ...p });

beforeEach(async () => {
  const src = await enSourceVideo(["douyin", "youtube"]);
  env = src.env;
  process.env.ELEVENLABS_API_KEY = "sk-test-secret";
  process.env.ELEVENLABS_VOICE_ID = "voice-123";
  setKeychainReader(async () => null);
  id = String((await executeEnEdition({ _dataDir: env.dir, op: "derive", content_id: src.id })).content_id);
  expect(await run({ op: "set_script", segments: SEGMENTS })).toMatchObject({ ok: true });
});
afterEach(async () => {
  setElevenLabsFetch(null); setDurationProbe(null); setKeychainReader(null);
  delete process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_VOICE_ID;
  await env.cleanup();
});

describe("P1-1 脚本是正文唯一来源", () => {
  it("通用 content update 改英文版正文 → 拒", async () => {
    const r = await executeContentSave({ _dataDir: env.dir, action: "update", id, body: "Something else entirely." });
    expect(r).toMatchObject({ ok: false, code: "en_script_is_source" });
    expect((await getContent(id, env.dir))!.body).not.toBe("Something else entirely.");
  });

  it("正文被别的写口改过 → 不能批；批过之后被改 → 配音拒", async () => {
    await updateContent(id, { _provenance: { kind: "human" }, body: "Drifted body." }, env.dir);
    expect((await run({ op: "status" })).problems).toEqual(expect.arrayContaining([expect.stringMatching(/正文和英文脚本对不上/)]));
    expect(await approveEnScript(env, id)).toMatchObject({ ok: false });
    await run({ op: "set_script", segments: SEGMENTS });
    expect(await approveEnScript(env, id)).toMatchObject({ ok: true });
    await updateContent(id, { _provenance: { kind: "human" }, body: "Drifted again." }, env.dir);
    expect(await run({ op: "dub" })).toMatchObject({ ok: false, code: "body_script_mismatch" });
  });
});

describe("P1-2 字幕文字只取批过的脚本", () => {
  it("时间戳念出来的字和批过的对不上 → 字幕失败，不把服务商的字烧进去", async () => {
    await approveEnScript(env, id);
    fakeElevenLabs([3.5, 3.5, 9], (text, n) => n === 2
      ? new Response(JSON.stringify({ audio_base64: Buffer.from("x").toString("base64"), alignment: fakeAlignment("UNAPPROVED words were spoken instead here, totally different text") }), { status: 200 })
      : undefined);
    expect(await run({ op: "dub" })).toMatchObject({ ok: true });
    const r = await run({ op: "captions" });
    expect(r).toMatchObject({ ok: false, code: "captions_failed" });
    expect(String(r.error)).toMatch(/第 2 段字幕对不上/);
  });

  it("只差大小写 / 标点时：用批过的原文，时间借时间戳", () => {
    const timed = [{ word: "be", startS: 0, endS: 0.2 }, { word: "honest", startS: 0.3, endS: 0.6 }];
    expect(alignApproved("Be honest.", timed)).toEqual([{ word: "Be", startS: 0, endS: 0.2 }, { word: "honest.", startS: 0.3, endS: 0.6 }]);
    expect(alignApproved("Be honest.", [timed[0]])).toMatch(/2 个词.*1 个/);
  });
});

describe("P1-3 密钥不外泄", () => {
  it("密钥中间夹换行 → 拒，原因里没有密钥", async () => {
    await approveEnScript(env, id);
    process.env.ELEVENLABS_API_KEY = "sk-abc\nSECRETTAIL";
    const r = await run({ op: "dub" });
    expect(r).toMatchObject({ ok: false, code: "elevenlabs_key_invalid" });
    expect(JSON.stringify(r)).not.toContain("SECRETTAIL");
  });

  it("服务商返回里带着密钥 → 打码后再报", async () => {
    await approveEnScript(env, id);
    fakeElevenLabs([3], () => new Response("invalid key sk-test-secret for this voice", { status: 401 }));
    const r = await run({ op: "dub" });
    expect(String(r.error)).toContain("ElevenLabs HTTP 401: invalid key *** for this voice");
    expect(JSON.stringify(r)).not.toContain("sk-test-secret");
  });
});

describe("P2-4 剪辑中冻结", () => {
  it("冻结时 set_script → 拒，脚本和正文都不动", async () => {
    const before = await readEnScript(id, env.dir);
    const body = (await getContent(id, env.dir))!.body;
    const doc = await readProductionDocOrEmpty(id, env.dir);
    await writeProductionDoc(id, env.dir, { ...doc, frozen: { round: doc.round, body_hash: "x", path: "x", at: new Date().toISOString() } }, doc.revision ?? 0);
    const r = await run({ op: "set_script", segments: SEGMENTS.map((s, i) => (i === 0 ? { ...s, en: "Totally new line." } : s)) });
    expect(r).toMatchObject({ ok: false, code: "script_frozen" });
    expect(await readEnScript(id, env.dir)).toEqual(before);
    expect((await getContent(id, env.dir))!.body).toBe(body);
  });
});

describe("P2-8 / P2-9 中途失败与坏时间戳", () => {
  it("第 3 段失败后重试：前两段复用，不再花钱", async () => {
    await approveEnScript(env, id);
    const first = fakeElevenLabs([3.5, 3.5, 9], (_t, n) => (n === 3 ? new Response("boom", { status: 500 }) : undefined));
    expect(await run({ op: "dub" })).toMatchObject({ ok: false, code: "tts_failed" });
    expect(first).toHaveLength(3);
    const retry = fakeElevenLabs([9]);
    expect(await run({ op: "dub" })).toMatchObject({ ok: true });
    expect(retry.map((c) => c.text)).toEqual([SEGMENTS[2].en]);
  });

  it("时间戳数组不等长 / 缺失 → 报错、不缓存，下次重新配", async () => {
    await approveEnScript(env, id);
    const bad = { characters: ["a", "b"], character_start_times_seconds: [0], character_end_times_seconds: [0.1, 0.2] };
    fakeElevenLabs([3.5], () => new Response(JSON.stringify({ audio_base64: "eA==", alignment: bad }), { status: 200 }));
    const r = await run({ op: "dub" });
    expect(r).toMatchObject({ ok: false, code: "tts_failed" });
    expect(String(r.error)).toMatch(/时间戳缺失或不完整/);
    fakeElevenLabs([3.5], () => new Response(JSON.stringify({ audio_base64: "eA==" }), { status: 200 }));
    expect(String((await run({ op: "dub" })).error)).toMatch(/时间戳缺失或不完整/);
    const ok = fakeElevenLabs([3.5, 3.5, 9]);
    expect(await run({ op: "dub" })).toMatchObject({ ok: true });
    expect(ok).toHaveLength(3);
  });
});

describe("P3-11 放慢倍数不靠取整过关", () => {
  it("1.1504× 判超限", () => {
    const p = planTiming([{ index: 1, slotStartS: 0, slotEndS: 100, durationS: 115.04 }]);
    expect(p.tailSlowdown).toBeGreaterThan(1.15);
    expect(slowdownRefusal(p)).toMatch(/1\.150×/);
  });
});

