/**
 * Verifier findings (2026-10-24, full-media E2E run) for the English edition. A failing test here is a reproduced
 * problem, not a broken test — do not bend it to pass.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { readProductionDoc } from "../../storage/production-store.js";
import { getContent } from "../../storage/local-store.js";
import { founderDecision } from "../production/decisions.js";
import { put, record, waiveSliverCheck, type Env } from "../production/testkit.js";
import { listForChat } from "../production/chat-approval/present.js";
import { boardData } from "../../desktop/board-data.js";
import { executeEnEdition } from "../../tools/en-edition.js";
import { setDurationProbe, type DubManifest } from "./dub.js";
import { buildCues } from "./captions.js";
import type { EnScript } from "./script.js";
import { setElevenLabsFetch, setKeychainReader } from "../voice/elevenlabs.js";
import { approveEnScript, EN_SRT_40S, enSourceVideo, fakeElevenLabs, SEGMENTS } from "./en-test-fixtures.js";

let env: Env;
let id: string;
const run = (p: Record<string, unknown>) => executeEnEdition({ _dataDir: env.dir, content_id: id, ...p });

async function approveEnglishCut() {
  const cut = await record(env, { content_id: id, kind: "cut", path: await put(path.join(env.chatcut, "english.mp4"), "en-cut-v1"), request_id: "c-en", review: true });
  await record(env, { content_id: id, kind: "srt", path: await put(path.join(env.chatcut, "english.srt"), "1\n00:00:00,000 --> 00:00:02,000\nBe honest.\n"), for_cut: cut.fact_id, request_id: "s-en" });
  const sha = (await readProductionDoc(id, env.dir))!.facts.find((f) => f.id === cut.fact_id)!.sha256!;
  await waiveSliverCheck(env, id, sha);
  expect(await founderDecision(id, "approve_cut", { fact_id: cut.fact_id, sha256: sha }, env.dir)).toMatchObject({ ok: true });
}

describe("verifier findings: English edition flow", () => {
  beforeEach(async () => {
    const src = await enSourceVideo(["douyin", "youtube", "x"], EN_SRT_40S);
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

  it("P2 re-sending the identical script (a retry / double call) keeps the founder's script approval", async () => {
    await approveEnglishCut();
    expect((await run({ op: "status" })).approval).toMatch(/^已批准/);
    const again = await run({ op: "set_script", segments: JSON.stringify(SEGMENTS) });
    expect(again).toMatchObject({ ok: true });
    // nothing changed, so nothing the founder approved should be undone
    expect((await getContent(id, env.dir))!.status).not.toBe("draft_ready");
    expect((await run({ op: "status" })).approval).toMatch(/^已批准/);
  });

  it("P2 the captions receipt's burn_command survives a shell: the cues path (project dirs contain spaces) is one argument", async () => {
    const r = await run({ op: "captions" });
    expect(r).toMatchObject({ ok: true });
    const cmd = String(r.burn_command).replace(/<[^>]*>/g, "PLACEHOLDER.mp4");
    const { spawnSync } = await import("node:child_process");
    const argv = spawnSync("bash", ["-c", `show() { printf '%s\\n' "$@"; }; show ${cmd}`], { encoding: "utf8" }).stdout.split("\n");
    expect(String(r.captions_path)).toMatch(/ /); // precondition: the real project path has a space
    expect(argv).toContain(String(r.captions_path));
  });

  it("P2 the board does not ask an English edition for the Chinese 3:4 / 4:3 covers", async () => {
    await approveEnglishCut();
    const item = (await boardData(env.dir)).items.find((i) => i.id === id);
    expect(item).toBeDefined();
    // (builder) 原来按字符串切 4000 字，英文卡没有 draftRef 时会切进下一张中文源视频的卡；改成只看这一张卡
    const card = JSON.stringify(item);
    expect(card).not.toMatch(/封面\(3:4\)|封面\(4:3\)/);
    expect(item!.targets.map((t) => t.platform)).toEqual(["youtube", "x"]);
  });

  it("P3 the 英文发布包 chat brief starts with which video it is (title), not an empty line", async () => {
    await approveEnglishCut();
    await run({ op: "set_thumbnail", path: await put(path.join(env.outside, "t.png"), (await import("../production/testkit.js")).png(1280, 720, "t")) });
    const { executePrePublishTool } = await import("../../tools/pre-publish.js");
    await executePrePublishTool({ _dataDir: env.dir, action: "video_kit", content_id: id, platform: "youtube", kit: { post_title: "Why max effort makes AI drift", caption: "The data says otherwise.", tags: ["AI"], chapters: [{ at: "0:00", title: "The instinct" }, { at: "0:10", title: "The test" }, { at: "0:20", title: "Instead" }] } });
    await executePrePublishTool({ _dataDir: env.dir, action: "video_kit", content_id: id, platform: "x", kit: { post_text: "Max effort is not a free upgrade." } });
    const r = await listForChat(env.dir, { content_id: id });
    const item = (r.items as Array<Record<string, unknown>>).find((i) => String(i.item_id).startsWith("enpkg:"));
    expect(item).toBeDefined();
    const firstLine = String(item!.brief).replace(/^\d+\.\s*/, "").split("\n")[0];
    expect(firstLine.trim()).not.toBe("");
  });
});

describe("verifier findings: English captions", () => {
  const manifestFor = (en: string): DubManifest => {
    const words = en.split(/\s+/).map((w, i) => ({ word: w, startS: i * 0.4, endS: i * 0.4 + 0.35 }));
    return { scriptHash: "h", voiceId: "v", modelId: "m", createdAt: "", lines: [{ index: 1, file: "f", sha256: "s", cacheKey: "k", durationS: 9, startS: 0, endS: 9, slotStartS: 0, slotEndS: 10, words }], sourceEndS: 10, dubEndS: 9, overrunS: -1, slowFromS: null, tailSlowdown: 1 };
  };
  const scriptFor = (en: string, keyword?: string): EnScript => ({ sourceCutHash: "x", segments: [{ index: 1, cueFrom: 1, cueTo: 1, zh: "中", en, startMs: 0, endMs: 10_000, swaps: [], ...(keyword ? { keyword } : {}) }] });

  it("P3 the yellow keyword is matched as a word, not inside another word (\"max\" must not light up \"maximum\")", () => {
    const en = "Push it to the maximum and it drifts. Max is not free.";
    const r = buildCues(manifestFor(en), scriptFor(en, "Max"));
    expect(r.ok).toBe(true);
    const text = (r as { cues: Array<{ lines: string[] }> }).cues.flatMap((c) => c.lines).join(" ");
    expect(text).toContain("[Max] is not free");
    const en2 = "We maxed it out, then set it to max.";
    const r2 = buildCues(manifestFor(en2), scriptFor(en2, "max"));
    expect((r2 as { cues: Array<{ lines: string[] }> }).cues.flatMap((c) => c.lines).join(" ")).not.toContain("[max]ed");
  });

  it("P3 a token longer than two caption lines never yields a 3-line cue or text that differs from the approved script", () => {
    const longToken = "docs.anthropic.com/en/docs/build-with-claude/extended-thinking-effort-levels-explained";
    const en = `Read ${longToken} today.`;
    const r = buildCues(manifestFor(en), scriptFor(en));
    // either refuse visibly, or produce cues that burn_captions.py accepts (1–2 lines, each ≤42) with the approved words intact
    if (!r.ok) return;
    for (const c of r.cues) {
      expect(c.lines.length).toBeLessThanOrEqual(2);
      for (const l of c.lines) expect(l.replace(/[[\]]/g, "").length).toBeLessThanOrEqual(42);
    }
    expect(r.cues.flatMap((c) => c.lines).join(" ").replace(/\s+/g, "")).toBe(en.replace(/\s+/g, ""));
  });
});
