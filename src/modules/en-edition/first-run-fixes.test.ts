/**
 * 2026-10-26 安克英文版首跑的回归：字幕 / 章节按英文时间线的实际摆放排（不是配音清单），长句拆行，
 * 章节按审过的英文成片片长核（不是配音结尾）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { updateContent } from "../../storage/local-store.js";
import { readProductionDoc } from "../../storage/production-store.js";
import { founderDecision } from "../production/decisions.js";
import { png, put, record, waiveSliverCheck, type Env } from "../production/testkit.js";
import { setProductionDeps } from "../production/roots.js";
import { executeEnEdition } from "../../tools/en-edition.js";
import { executePrePublishTool } from "../../tools/pre-publish.js";
import { withCallerSession } from "../../runtime/run-log.js";
import { setDurationProbe } from "./dub.js";
import { setElevenLabsFetch, setKeychainReader } from "../voice/elevenlabs.js";
import { approveEnScript, EN_SRT_40S, enSourceVideo, fakeElevenLabs, SEGMENTS } from "./en-test-fixtures.js";
import { buildCues, LINE_MAX } from "./captions.js";
import type { DubManifest } from "./dub.js";

let env: Env;
let id: string;
const run = (p: Record<string, unknown>) => executeEnEdition({ _dataDir: env.dir, content_id: id, ...p });
type Cue = { start: number; end: number; lines: string[] };
const cuesOf = async (r: Record<string, unknown>) => (JSON.parse(await fs.readFile(String(r.captions_path), "utf8")) as { cues: Cue[] }).cues;

beforeEach(async () => {
  const src = await enSourceVideo(["douyin", "youtube"], EN_SRT_40S);
  env = src.env;
  process.env.ELEVENLABS_API_KEY = "sk-test"; process.env.ELEVENLABS_VOICE_ID = "v";
  setKeychainReader(async () => null);
  id = String((await executeEnEdition({ _dataDir: env.dir, op: "derive", content_id: src.id })).content_id);
  await run({ op: "set_script", segments: SEGMENTS });
  expect(await approveEnScript(env, id)).toMatchObject({ ok: true });
  fakeElevenLabs([9, 9, 19]);
  expect(await run({ op: "dub" })).toMatchObject({ ok: true });
});
afterEach(async () => {
  setElevenLabsFetch(null); setDurationProbe(null); setKeychainReader(null);
  delete process.env.ELEVENLABS_API_KEY; delete process.env.ELEVENLABS_VOICE_ID;
  await env.cleanup();
});

describe("字幕 / 章节按实际摆放排", () => {
  it("没登记摆放：按配音清单排，并如实说是按清单排的", async () => {
    const r = await run({ op: "captions" });
    expect(r).toMatchObject({ ok: true, timing_source: "dub_manifest" });
    expect(String(r.timing_warning)).toContain("set_placements");
    expect(await run({ op: "chapters" })).toMatchObject({ ok: true, timing_source: "dub_manifest" });
  });

  it("登记了摆放：每段字幕和章节起点平移到实际起点；漏段 / 倒序被拒", async () => {
    expect(await run({ op: "set_placements", placements: [{ line: 1, start_s: 0 }] })).toMatchObject({ ok: false, code: "invalid_params" });
    expect(await run({ op: "set_placements", placements: [{ line: 1, start_s: 0 }, { line: 2, start_s: 30 }, { line: 3, start_s: 20 }] })).toMatchObject({ ok: false, code: "invalid_params" });
    const before = await cuesOf(await run({ op: "captions" }));
    // 第 2、3 段前各插了 B-roll（JSON 字符串也认）
    expect(await run({ op: "set_placements", placements: JSON.stringify([{ line: 1, start_s: 0 }, { line: 2, start_s: 15 }, { line: 3, start_s: 31.5 }]) })).toMatchObject({ ok: true, lines: 3 });
    const r = await run({ op: "captions" });
    expect(r).toMatchObject({ ok: true, timing_source: "placements" });
    expect(r.timing_warning).toBeUndefined();
    const after = await cuesOf(r);
    expect(after.map((c) => c.lines.join(" "))).toEqual(before.map((c) => c.lines.join(" ")));
    const seg2 = after.find((c) => c.lines.join(" ").startsWith("Tariq"))!;
    const seg3 = after.find((c) => c.lines.join(" ").startsWith("Same"))!;
    expect(seg2.start).toBeCloseTo(15, 3);
    expect(seg3.start).toBeCloseTo(31.5, 3);
    const ch = (await run({ op: "chapters" })).segment_starts as Array<{ segment: number; start_s: number }>;
    expect(ch.map((c) => c.start_s)).toEqual([0, 15, 31.5]);
  });

  it("配音重做过、摆放还是旧的：字幕 / 章节拒，不静默退回清单", async () => {
    await run({ op: "set_placements", placements: [{ line: 1, start_s: 0 }, { line: 2, start_s: 15 }, { line: 3, start_s: 31.5 }] });
    const f = path.join(path.dirname(String((await run({ op: "captions" })).captions_path)), "placements.json");
    const p = JSON.parse(await fs.readFile(f, "utf8")) as Record<string, unknown>;
    await fs.writeFile(f, JSON.stringify({ ...p, dubHash: "old" }));
    expect(await run({ op: "captions" })).toMatchObject({ ok: false, code: "placements_stale" });
    expect(await run({ op: "chapters" })).toMatchObject({ ok: false, code: "placements_stale" });
  });
});

describe("章节按审过的英文成片片长核", () => {
  async function approveEnglishCut() {
    await record(env, { content_id: id, kind: "aroll", path: await put(path.join(env.inbox, "英文参考.mov"), "ref"), request_id: "a-en" });
    const cut = await record(env, { content_id: id, kind: "cut", path: await put(path.join(env.chatcut, "english-long.mp4"), "en-cut"), request_id: "c-en", review: true });
    const sha = (await readProductionDoc(id, env.dir))!.facts.find((f) => f.id === cut.fact_id)!.sha256!;
    await waiveSliverCheck(env, id, sha);
    expect(await founderDecision(id, "approve_cut", { fact_id: cut.fact_id, sha256: sha }, env.dir)).toMatchObject({ ok: true });
  }
  const kit = (chapters: unknown) => executePrePublishTool({ _dataDir: env.dir, action: "video_kit", content_id: id, platform: "youtube",
    kit: { post_title: "Why max effort makes AI drift", caption: "The data says otherwise.", tags: ["AI"], chapters } });
  const CH = [{ at: "0:00", title: "Intro" }, { at: "0:20", title: "Test" }, { at: "0:45", title: "Outro" }];

  it("英文成片比配音长（补了 B-roll）：按成片 60 秒核，0:45 起的章节放行；没审过的成片时按配音结尾核会拒", async () => {
    const noCut = JSON.stringify(await kit(CH));
    expect(noCut).toContain("超过片长");
    setProductionDeps({ probe: async () => ({ durationMs: 60_000, width: 1920, height: 1080, audio: true }) });
    await approveEnglishCut();
    const r = await kit(CH);
    expect(JSON.stringify(r)).not.toContain("超过片长");
    expect(JSON.stringify(r)).not.toContain("不到 10 秒");
  });
});

describe("video_kit 认领：同一会话不锁自己", () => {
  it("同一会话第二次交包不带令牌也放行；另一个会话 claim_held", async () => {
    expect(await run({ op: "set_thumbnail", path: await put(path.join(env.outside, "thumb.png"), png(1280, 720, "t1")) })).toMatchObject({ ok: true });
    await updateContent(id, { claim: undefined }, env.dir); // 测试从「没人认领」开始
    const kit = (session: string) => withCallerSession(session, () => executePrePublishTool({ _dataDir: env.dir, _host: "claude-code", action: "video_kit", content_id: id, platform: "youtube",
      kit: { post_title: "Why max effort makes AI drift", caption: "The data says otherwise.", tags: ["AI"], chapters: [{ at: "0:00", title: "Intro" }, { at: "0:12", title: "Test" }, { at: "0:24", title: "Outro" }] } }));
    { const r1 = await kit("sess-aaa-111"); expect(r1, JSON.stringify(r1)).toMatchObject({ ok: true }); }
    { const r1 = await kit("sess-aaa-111"); expect(r1, JSON.stringify(r1)).toMatchObject({ ok: true }); }
    expect(await kit("sess-bbb-222")).toMatchObject({ ok: false, code: "claim_held" });
  });
});

describe("长句拆行（buildCues）", () => {
  it("一句 136 字符的英文拆成每行 ≤42、每条 ≤2 行，文字不丢", () => {
    const en = "Anker has 6,000-plus people; four to five thousand use its internal AI platform daily, with 2,000-plus tools staff built themselves.";
    const words = en.split(/\s+/).map((w, i) => ({ word: w, startS: i * 0.4, endS: i * 0.4 + 0.35 }));
    const m = { lines: [{ index: 1, words, startS: 0, endS: words.at(-1)!.endS }] } as unknown as DubManifest;
    const r = buildCues(m, { sourceCutHash: "x", segments: [{ index: 1, en }] } as never);
    expect(r.ok).toBe(true);
    const cues = (r as { cues: Cue[] }).cues;
    expect(cues.length).toBeGreaterThan(1);
    expect(cues.every((c) => c.lines.length <= 2 && c.lines.every((l) => l.length <= LINE_MAX))).toBe(true);
    expect(cues.map((c) => c.lines.join(" ")).join(" ")).toBe(en);
    // 装满一行再换行（和创始人认过的那份一样）
    expect(cues[0].lines[0]).toBe("Anker has 6,000-plus people; four to five");
  });

  it("句末一定收条：短句不和下一句并成一条", () => {
    const en = "Can we copy it? I think so. The messenger's still human.";
    const words = en.split(/\s+/).map((w, i) => ({ word: w, startS: i * 0.4, endS: i * 0.4 + 0.35 }));
    const m = { lines: [{ index: 1, words, startS: 0, endS: 9 }] } as unknown as DubManifest;
    const r = buildCues(m, { sourceCutHash: "x", segments: [{ index: 1, en }] } as never) as { cues: Cue[] };
    expect(r.cues.map((c) => c.lines)).toEqual([["Can we copy it?"], ["I think so."], ["The messenger's still human."]]);
  });
});
