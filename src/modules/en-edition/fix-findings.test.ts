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
