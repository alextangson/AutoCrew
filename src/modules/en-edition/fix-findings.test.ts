/** builder 修 verifier 发现时补的回归测试（verify-findings.test.ts 之外的边） */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { buildCues } from "./captions.js";
import type { DubManifest } from "./dub.js";
import type { EnScript } from "./script.js";
import { shellQuote } from "../../tools/en-edition-media.js";

const manifestFor = (en: string): DubManifest => {
  const words = en.split(/\s+/).map((w, i) => ({ word: w, startS: i * 0.4, endS: i * 0.4 + 0.35 }));
  return { scriptHash: "h", voiceId: "v", modelId: "m", createdAt: "", lines: [{ index: 1, file: "f", sha256: "s", cacheKey: "k", durationS: 30, startS: 0, endS: 30, slotStartS: 0, slotEndS: 30, words }], sourceEndS: 30, dubEndS: 30, overrunS: -1, slowFromS: null, tailSlowdown: 1 };
};
const scriptFor = (en: string, keyword?: string): EnScript => ({ sourceCutHash: "x", segments: [{ index: 1, cueFrom: 1, cueTo: 1, zh: "中", en, startMs: 0, endMs: 30_000, swaps: [], ...(keyword ? { keyword } : {}) }] });
const cuesOf = (en: string, kw?: string) => { const r = buildCues(manifestFor(en), scriptFor(en, kw)); if (!r.ok) throw new Error(r.error); return r.cues; };

describe("captions keyword + long token", () => {
  it("a two-word keyword is kept on one line when a balanced wrap would split it", () => {
    const en = "The harder the task the more you reach for max effort and it drifts";
    const lines = cuesOf(en, "max effort").flatMap((c) => c.lines);
    expect(lines.some((l) => l.includes("[max effort]"))).toBe(true);
  });

  it("a multi-word keyword near the line limit is still highlighted and the text stays intact", () => {
    const en = "abcdefghij abcdefghij abcdefghij abcdefghi keyword continues here";
    const cue = cuesOf(en, "abcdefghi keyword continues")[0];
    const marked = cue.lines.join("\n");
    expect(marked).toMatch(/\[/);
    expect(marked.replace(/[[\]]/g, "")).toBe(cue.lines.join("\n").replace(/[[\]]/g, ""));
  });

  it("an overlong token is refused with a reason telling the host to shorten that segment", () => {
    const r = buildCues(manifestFor(`see ${"x".repeat(50)} now`), scriptFor(`see ${"x".repeat(50)} now`));
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/第 1 段.*改短/);
  });
});

describe("shellQuote", () => {
  it("keeps a path with spaces, CJK and a single quote as one argument", () => {
    const p = "/Users/x/AutoCrew 资料库/它's 项目/captions.json";
    const out = spawnSync("bash", ["-c", `printf '%s\\n' ${shellQuote(p)}`], { encoding: "utf8" }).stdout.trim();
    expect(out).toBe(p);
  });
});

describe("dub timestamps + missing voice", () => {
  it("word times past the measured mp3 end are clamped to the audio duration", async () => {
    const { wordsFromAlignment } = await import("./dub.js");
    const chars = [..."ok go"];
    const words = wordsFromAlignment({ characters: chars, character_start_times_seconds: [0, 0.1, 0.2, 5.7, 5.8], character_end_times_seconds: [0.1, 0.2, 0.3, 5.8, 5.84] }, 10, 5.76);
    expect(words.at(-1)!.endS).toBe(15.76);
    expect(words.every((w) => w.endS >= w.startS)).toBe(true);
  });
});

describe("dub failure is remembered until a dub succeeds", () => {
  it("status says 配音失败 after a failed dub, and a missing voice id points at the settings page", async () => {
    const { enSourceVideo, SEGMENTS, approveEnScript, fakeElevenLabs, EN_SRT_40S } = await import("./en-test-fixtures.js");
    const { executeEnEdition } = await import("../../tools/en-edition.js");
    const { setElevenLabsFetch, setKeychainReader } = await import("../voice/elevenlabs.js");
    const { setDurationProbe } = await import("./dub.js");
    const src = await enSourceVideo(["douyin", "youtube"], EN_SRT_40S);
    const env = src.env;
    const before = { k: process.env.ELEVENLABS_API_KEY, v: process.env.ELEVENLABS_VOICE_ID, l: process.env.AUTOCREW_LOCAL_DIR };
    process.env.AUTOCREW_LOCAL_DIR = env.outside;
    try {
      process.env.ELEVENLABS_API_KEY = "sk-test"; delete process.env.ELEVENLABS_VOICE_ID;
      setKeychainReader(async () => null);
      const id = String((await executeEnEdition({ _dataDir: env.dir, op: "derive", content_id: src.id })).content_id);
      const run = (p: Record<string, unknown>) => executeEnEdition({ _dataDir: env.dir, content_id: id, ...p });
      await run({ op: "set_script", segments: SEGMENTS });
      expect(await approveEnScript(env, id)).toMatchObject({ ok: true });
      const noVoice = await run({ op: "dub" });
      expect(noVoice).toMatchObject({ ok: false, code: "elevenlabs_voice_missing" });
      expect(String(noVoice.error)).toContain("设置 → 接入更多 → 英文版配音");
      expect(String((await run({ op: "status" })).dub)).toMatch(/^配音失败：没配 ElevenLabs 声音 id/);
      process.env.ELEVENLABS_VOICE_ID = "v";
      fakeElevenLabs([9, 9, 19]);
      expect(await run({ op: "dub" })).toMatchObject({ ok: true });
      expect(String((await run({ op: "status" })).dub)).toMatch(/^已配音/);
    } finally {
      setElevenLabsFetch(null); setDurationProbe(null); setKeychainReader(null);
      for (const [k, v] of [["ELEVENLABS_API_KEY", before.k], ["ELEVENLABS_VOICE_ID", before.v], ["AUTOCREW_LOCAL_DIR", before.l]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await env.cleanup();
    }
  });
});
