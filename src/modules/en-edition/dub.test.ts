/**
 * Phase 3 验收（二）：配音与排时。ElevenLabs 全部 mock，测试里绝不打真的 API。
 * 边界：失败照原样报、不换声音；超时放慢 > 1.15 拒并叫宿主写短；清单永不重叠；只按批过的脚本配；字幕分条只用批过的文字。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { readInbox } from "../production/inbox-read.js";
import { decideItem } from "../production/inbox-decide.js";
import { executeEnEdition } from "../../tools/en-edition.js";
import { setDurationProbe } from "./dub.js";
import { setElevenLabsFetch, setKeychainReader } from "../voice/elevenlabs.js";
import { planTiming, slowdownRefusal } from "../voice/timing.js";
import { enSourceVideo, SEGMENTS } from "./en-test-fixtures.js";
import type { Env } from "../production/testkit.js";

let env: Env;
let id: string;
let calls: Array<{ url: string; body: Record<string, unknown>; key: string }>;
const run = (p: Record<string, unknown>) => executeEnEdition({ _dataDir: env.dir, content_id: id, ...p });

function alignment(text: string) {
  const chars = [...text];
  return { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.05), character_end_times_seconds: chars.map((_, i) => i * 0.05 + 0.04) };
}

/** 假 ElevenLabs：按文字回 mp3 字节 + 字级时间；durations 控制每段时长 */
function fakeApi(durations: number[], fail?: { status: number; body: string }) {
  calls = [];
  let n = 0;
  setDurationProbe(async () => durations[Math.min(n++, durations.length - 1)]);
  setElevenLabsFetch((async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body, key: String((init.headers as Record<string, string>)["xi-api-key"]) });
    if (fail) return new Response(fail.body, { status: fail.status });
    return new Response(JSON.stringify({ audio_base64: Buffer.from(`mp3:${body.text}`).toString("base64"), alignment: alignment(String(body.text)) }), { status: 200 });
  }) as typeof fetch);
}

beforeEach(async () => {
  const src = await enSourceVideo(["douyin", "youtube"]);
  env = src.env;
  process.env.ELEVENLABS_API_KEY = "sk-test-secret";
  process.env.ELEVENLABS_VOICE_ID = "voice-123";
  setKeychainReader(async () => null);
  const r = await executeEnEdition({ _dataDir: env.dir, op: "derive", content_id: src.id });
  id = String(r.content_id);
  await run({ op: "set_script", segments: SEGMENTS });
  const d = (await readInbox(env.dir, { withDrafts: true })).items.find((i) => i.type === "draft" && i.content_id === id)!;
  expect(await decideItem({ item_id: d.item_id, gen: d.gen, action: "approve_script", content_id: id }, env.dir)).toMatchObject({ ok: true });
});
afterEach(() => {
  setElevenLabsFetch(null); setDurationProbe(null); setKeychainReader(null);
  delete process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_VOICE_ID;
});

describe("ElevenLabs 配音", () => {
  it("每段一次调用，eleven_v4 + 选定的声音参数；清单顺排、留 0.15 秒、不早于时间槽", async () => {
    fakeApi([3.95, 4.4, 9]);
    const r = await run({ op: "dub" });
    expect(r).toMatchObject({ ok: true, lines: 3 });
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain("/voice-123/with-timestamps");
    expect(calls[0].body).toMatchObject({ model_id: "eleven_v4", voice_settings: { stability: 0.3, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true } });
    const m = JSON.parse(await fs.readFile(String(r.manifest_path), "utf8"));
    expect(m.lines.map((l: { startS: number }) => l.startS)).toEqual([0, 4.1, 8.65]);
    expect(m.lines[0].words[0]).toMatchObject({ word: "Be", startS: 0 });
    // 同样的文字和设置再配一次：复用，不再花钱
    await run({ op: "dub" });
    expect(calls).toHaveLength(3);
  });

  it("API 失败 → 原样报 HTTP 状态和返回原文，不写清单，不换声音", async () => {
    fakeApi([3], { status: 401, body: '{"detail":{"status":"invalid_api_key"}}' });
    const r = await run({ op: "dub" });
    expect(r).toMatchObject({ ok: false, code: "tts_failed" });
    expect(String(r.error)).toContain('ElevenLabs HTTP 401: {"detail":{"status":"invalid_api_key"}}');
    expect(calls).toHaveLength(1);
    // verifier P3：失败要一直看得见（以前这里是「还没配音」，失败在下一轮就没了）
    expect(String((await run({ op: "status" })).dub)).toMatch(/^配音失败：第 1 段配音失败：ElevenLabs HTTP 401/);
  });

  it("尾段要放慢 > 1.15× → 拒，叫宿主把脚本写短；字幕 / 章节也不给", async () => {
    fakeApi([3.5, 4, 14]);
    const r = await run({ op: "dub" });
    expect(r).toMatchObject({ ok: false, code: "overrun_too_long" });
    expect(String(r.error)).toMatch(/超过上限 1\.15×.*写短/);
    expect(await run({ op: "captions" })).toMatchObject({ ok: false, code: "overrun_too_long" });
  });

  it("没配密钥 / 声音 id → 拒，说去哪配", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    expect(await run({ op: "dub" })).toMatchObject({ ok: false, code: "elevenlabs_key_missing" });
    process.env.ELEVENLABS_API_KEY = "k";
    delete process.env.ELEVENLABS_VOICE_ID;
    expect(await run({ op: "dub" })).toMatchObject({ ok: false, code: "elevenlabs_voice_missing" });
  });

  it("字幕：文字来自批过的脚本，每条 ≤2 行、标黄词只标一次；章节候选第一个是 0:00", async () => {
    fakeApi([3.5, 4.2, 9]);
    await run({ op: "dub" });
    const r = await run({ op: "captions" });
    expect(r).toMatchObject({ ok: true });
    const { cues } = JSON.parse(await fs.readFile(String(r.captions_path), "utf8")) as { cues: Array<{ start: number; end: number; lines: string[] }> };
    expect(cues.every((c) => c.lines.length <= 2 && c.lines.every((l) => l.replace(/[[\]]/g, "").length <= 42))).toBe(true);
    expect(cues.flatMap((c) => c.lines).join(" ").match(/\[the opposite\]/g)).toHaveLength(1);
    expect(cues.map((c) => c.lines.join(" ").replace(/[[\]]/g, "")).join(" ")).toBe(SEGMENTS.map((s) => s.en).join(" "));
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end);
    expect(((await run({ op: "chapters" })).segment_starts as Array<{ at: string }>)[0].at).toBe("0:00");
  });
});

describe("排时（纯函数）", () => {
  it("永不重叠：后一条至少晚 0.15 秒；不早于自己的时间槽", () => {
    const p = planTiming([
      { index: 1, slotStartS: 0, slotEndS: 2, durationS: 3 },
      { index: 2, slotStartS: 2, slotEndS: 4, durationS: 3 },
      { index: 3, slotStartS: 10, slotEndS: 12, durationS: 1 },
    ]);
    expect(p.lines.map((l) => [l.startS, l.endS])).toEqual([[0, 3], [3.15, 6.15], [10, 11]]);
    for (let i = 1; i < p.lines.length; i++) expect(p.lines[i].startS - p.lines[i - 1].endS).toBeGreaterThanOrEqual(0.15 - 1e-9);
    expect(p.tailSlowdown).toBe(1);
  });

  it("超出源结尾：从第一段拖出槽的地方开始放慢；≤1.15 放行，>1.15 拒", () => {
    const ok = planTiming([{ index: 1, slotStartS: 0, slotEndS: 10, durationS: 5 }, { index: 2, slotStartS: 10, slotEndS: 20, durationS: 11 }]);
    expect(ok).toMatchObject({ slowFromS: 10, tailSlowdown: 1.1 });
    expect(slowdownRefusal(ok)).toBeNull();
    const bad = planTiming([{ index: 1, slotStartS: 0, slotEndS: 10, durationS: 5 }, { index: 2, slotStartS: 10, slotEndS: 20, durationS: 12 }]);
    expect(bad.tailSlowdown).toBeGreaterThan(1.15);
    expect(slowdownRefusal(bad)).toMatch(/第 2 段/);
  });
});
