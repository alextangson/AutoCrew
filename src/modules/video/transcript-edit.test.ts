/**
 * 手工改字（转写纠错 spec §6）：纯函数的落点/拼装，加门上的版本链与并发。
 *
 * 门的部分**直接用注入口跑 `createCutGate`**，不走整条管线：这里验的是判定与产物
 * （三 base 锁、勾选不丢、clean 链、EEXIST 翻冲突），跑一遍 ASR + ffmpeg 要几分钟，
 * 而那些调度语义在 service.test.ts / service-gate.test.ts 已经有专测。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCutGate, type CutGate } from "./cut-gate.js";
import { VideoConflictError } from "./errors.js";
import {
  MAX_MANUAL_TEXT_CHARS,
  editUnitText,
  locateUnitWords,
  manualTextReason,
} from "./transcript-edit.js";
import { readEditUnits, readTranscriptClean, readVersioned, videoDir, writeVersioned } from "./video-store.js";
import type { TranscriptClean, TranscriptSegment, TranscriptWord, VideoCut, VideoEditUnits, VideoState } from "./types.js";

const w = (word: string, startMs: number, endMs: number): TranscriptWord => ({ w: word, startMs, endMs });

/**
 * 一句话被 AI 切成两个单元（`unit-0001` / `unit-0002`），第二句自成一个单元。
 * 「同一个 cseg 含多个单元」正是本刀最容易改错的形状——只许动目标那一段。
 */
const CSEG_1: TranscriptSegment = {
  id: "cseg-0001",
  text: "今天聊聊 deepsick，真的强",
  startMs: 0,
  endMs: 1800,
  words: [
    w("今", 0, 200),
    w("天", 200, 400),
    w("聊", 400, 600),
    w("聊", 600, 800),
    w("deepsick", 800, 1200),
    w("真", 1200, 1400),
    w("的", 1400, 1600),
    w("强", 1600, 1800),
  ],
};

const CSEG_2: TranscriptSegment = {
  id: "cseg-0002",
  text: "第二句原样。",
  startMs: 2500,
  endMs: 3500,
  words: [w("第", 2500, 2700), w("二", 2700, 2900), w("句", 2900, 3100), w("原", 3100, 3300), w("样", 3300, 3500)],
};

const UNITS: TranscriptSegment[] = [
  { id: "unit-0001", text: "今天聊聊deepsick", startMs: 0, endMs: 1200, words: CSEG_1.words.slice(0, 5) },
  { id: "unit-0002", text: "真的强", startMs: 1200, endMs: 1800, words: CSEG_1.words.slice(5) },
  { id: "unit-0003", text: "第二句原样", startMs: 2500, endMs: 3500, words: CSEG_2.words },
];

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe("manualTextReason", () => {
  it("空 / 纯标点 / 超长各有一句人话；正常文字放行", () => {
    expect(manualTextReason("   ")).toContain("取消勾选");
    expect(manualTextReason("……！？ 🙂")).toContain("一个字都不剩");
    expect(manualTextReason("今".repeat(MAX_MANUAL_TEXT_CHARS + 1))).toContain(`上限 ${MAX_MANUAL_TEXT_CHARS}`);
    expect(manualTextReason("今".repeat(MAX_MANUAL_TEXT_CHARS))).toBeNull();
    expect(manualTextReason(" 今天聊聊 DeepSeek ")).toBeNull();
  });
});

describe("locateUnitWords", () => {
  it("按词身份定位到「哪一句的哪一段」；同一句里的两个单元各归各位", () => {
    expect(locateUnitWords([CSEG_1, CSEG_2], UNITS[0].words)).toEqual({ segmentIndex: 0, from: 0, to: 5 });
    expect(locateUnitWords([CSEG_1, CSEG_2], UNITS[1].words)).toEqual({ segmentIndex: 0, from: 5, to: 8 });
    expect(locateUnitWords([CSEG_1, CSEG_2], UNITS[2].words)).toEqual({ segmentIndex: 1, from: 0, to: 5 });
  });

  it("词对不上（文字已经换过一版）或单元没有词 → null，交给调用方人话拒绝", () => {
    expect(locateUnitWords([CSEG_1], [w("今", 0, 999)])).toBeNull();
    expect(locateUnitWords([CSEG_1], [])).toBeNull();
  });
});

describe("editUnitText", () => {
  it("只换目标区间：其余词与句中标点原样，分句源区间一毫秒不动", () => {
    const out = editUnitText(CSEG_1, 0, 5, "今天聊聊 DeepSeek");
    expect(out.segment.text).toBe("今天聊聊 DeepSeek，真的强");
    expect(out.segment.startMs).toBe(0);
    expect(out.segment.endMs).toBe(1800);
    // 后半句的三个词一个字段都没动
    expect(out.segment.words.slice(-3)).toEqual(CSEG_1.words.slice(5));
    // 改后的词只在原区间 [0, 1200] 里重分，时间不新造
    expect(out.words.map((x) => x.w)).toEqual(["今", "天", "聊", "聊", "DeepSeek"]);
    expect(out.words[0].startMs).toBe(0);
    expect(out.words.at(-1)!.endMs).toBe(1200);
  });

  it("改后半句：前半句连同那个逗号原样留着", () => {
    const out = editUnitText(CSEG_1, 5, 8, "真的很强");
    expect(out.segment.text).toBe("今天聊聊 deepsick，真的很强");
    expect(out.segment.words.slice(0, 5)).toEqual(CSEG_1.words.slice(0, 5));
    expect(out.words.map((x) => x.w)).toEqual(["真", "的", "很", "强"]);
  });

  it("词表覆盖不到的字（ASR 原样分句）不被吞：只替换对得上的那一段", () => {
    // text 里的「聊聊」没有词时间戳——真机上覆盖率 83% 的那种分句
    const raw: TranscriptSegment = {
      id: "seg-0001",
      text: "今天聊聊 FDE",
      startMs: 0,
      endMs: 1000,
      words: [w("今", 0, 200), w("天", 200, 400), w("FDE", 400, 1000)],
    };
    expect(editUnitText(raw, 2, 3, "FDE 是什么").segment.text).toBe("今天聊聊 FDE 是什么");
    expect(editUnitText(raw, 0, 2, "明天").segment.text).toBe("明天聊聊 FDE");
  });
});

// ---------------------------------------------------------------------------
// 门（cut-gate）
// ---------------------------------------------------------------------------

const CONTENT_ID = "content-20260825-abc123";

const BASE = { baseTranscriptRevision: 1, baseCleanRevision: 1, baseCutRevision: 2 };

let dir: string;
let vdir: string;
let state: VideoState;
let gate: CutGate;

/** 门只读 state 与盘上的产物；写回来的状态原地更新，好让「连改两次」测得动 */
function buildGate(): CutGate {
  return createCutGate({
    dataDir: dir,
    requireState: async () => state,
    write: async (_id, mutate) => {
      state = { ...mutate(state), updatedAt: new Date().toISOString() };
      return state;
    },
    enqueue: () => {},
    enqueuePreview: () => {},
    describe: (s) => `${s.phase}/${s.state}`,
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-video-text-edit-"));
  vdir = videoDir(dir, CONTENT_ID);
  await writeVersioned(vdir, "transcript", 1, {
    schemaVersion: 1,
    source: "funasr",
    segments: [CSEG_1, CSEG_2],
  });
  await writeVersioned(vdir, "transcript-clean", 1, {
    schemaVersion: 1,
    transcriptRevision: 1,
    baseCleanRevision: null,
    origin: "llm",
    segments: [CSEG_1, CSEG_2],
    warning: "3:20-3:40 的清洗结果没采纳，这一段保持原样",
  } satisfies TranscriptClean);
  await writeVersioned(vdir, "edit-units", 2, {
    schemaVersion: 1,
    transcriptRevision: 1,
    cleanRevision: 1,
    origin: "llm",
    segments: UNITS,
    suggestedDrops: ["unit-0002"],
    flags: [{ segmentId: "unit-0002", flag: "repeat" }],
    provenance: { model: "test-strong", promptVersion: "rc-1", bodyHash: "abc", generatedAt: "2026-08-25T00:00:00.000Z" },
  } satisfies VideoEditUnits);
  await writeVersioned(vdir, "cut", 2, {
    transcriptRevision: 1,
    cleanRevision: 1,
    keeps: ["unit-0001", "unit-0003"],
    flags: [{ segmentId: "unit-0002", flag: "repeat" }],
    origin: "llm",
    baseCutRevision: 1,
  } satisfies VideoCut);
  state = {
    schemaVersion: 1,
    entryType: "aroll",
    phase: "cut",
    state: "awaiting_human",
    revisions: { transcript: 1, clean: 1, cut: 2 },
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
  gate = buildGate();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("cut-gate.editText 成功路径", () => {
  it("落 clean.v2（human）+ 同号的 cut/单元表 v3，勾选与标注一个不丢", async () => {
    const next = await gate.editText(CONTENT_ID, { ...BASE, unitId: "unit-0001", text: "今天聊聊 DeepSeek" });
    // 门不动，只推两个 revision——人还站在门上继续挑
    expect(`${next.phase}/${next.state}`).toBe("cut/awaiting_human");
    expect(next.revisions).toMatchObject({ transcript: 1, clean: 2, cut: 3 });

    const clean = (await readTranscriptClean(vdir, 2))!;
    expect(clean).toMatchObject({ origin: "human", baseCleanRevision: 1, transcriptRevision: 1 });
    // 手改版没有降级要报：上一版清洗的 warning 不跟着过来
    expect(clean.warning).toBeUndefined();
    expect(clean.segments[0].text).toBe("今天聊聊 DeepSeek，真的强");
    expect(clean.segments[1]).toEqual(CSEG_2);

    const units = (await readEditUnits(vdir, 3))!;
    expect(units.cleanRevision).toBe(2);
    expect(units.segments.map((s) => s.id)).toEqual(["unit-0001", "unit-0002", "unit-0003"]);
    expect(units.segments[0]).toMatchObject({ text: "今天聊聊 DeepSeek", startMs: 0, endMs: 1200 });
    expect(units.segments[0].words.map((x) => x.w)).toEqual(["今", "天", "聊", "聊", "DeepSeek"]);
    // 只动目标单元：另外两个单元原样
    expect(units.segments.slice(1)).toEqual(UNITS.slice(1));
    // AI 的只读证据原样携带
    expect(units.suggestedDrops).toEqual(["unit-0002"]);
    expect(units.provenance?.model).toBe("test-strong");

    const cut = (await readVersioned<VideoCut>(vdir, "cut", 3))!;
    expect(cut).toMatchObject({
      keeps: ["unit-0001", "unit-0003"],
      flags: [{ segmentId: "unit-0002", flag: "repeat" }],
      origin: "llm",
      cleanRevision: 2,
      baseCutRevision: 2,
    });
    // 旧版一个字没改（审计凭证）
    expect((await readTranscriptClean(vdir, 1))!.segments[0].text).toBe(CSEG_1.text);
  });

  it("同一个 cseg 里改第二个单元：第一个单元的词与文字一个字段不动", async () => {
    await gate.editText(CONTENT_ID, { ...BASE, unitId: "unit-0002", text: "真的很强" });
    const clean = (await readTranscriptClean(vdir, 2))!;
    expect(clean.segments[0].text).toBe("今天聊聊 deepsick，真的很强");
    expect(clean.segments[0].words.slice(0, 5)).toEqual(CSEG_1.words.slice(0, 5));
    const units = (await readEditUnits(vdir, 3))!;
    expect(units.segments[0]).toEqual(UNITS[0]);
    expect(units.segments[1].text).toBe("真的很强");
  });

  it("连改两次：第二次拿新版本号成功（链是 v2→v3），拿旧号是冲突", async () => {
    await gate.editText(CONTENT_ID, { ...BASE, unitId: "unit-0001", text: "今天聊聊 DeepSeek" });
    await expect(
      gate.editText(CONTENT_ID, { ...BASE, unitId: "unit-0001", text: "今天再聊 DeepSeek" }),
    ).rejects.toThrow(VideoConflictError);

    const next = await gate.editText(CONTENT_ID, {
      baseTranscriptRevision: 1,
      baseCleanRevision: 2,
      baseCutRevision: 3,
      unitId: "unit-0003",
      text: "第二句也改了",
    });
    expect(next.revisions).toMatchObject({ clean: 3, cut: 4 });
    const clean = (await readTranscriptClean(vdir, 3))!;
    expect(clean.baseCleanRevision).toBe(2);
    // 追溯链闭合：v3 基于 v2，而 v2 的第一句已经是改过的
    expect(clean.segments[0].text).toBe("今天聊聊 DeepSeek，真的强");
    // 句末那个句号在替换区间之外（它跟着最后一个词走），原样留着
    expect(clean.segments[1].text).toBe("第二句也改了。");
  });
});

describe("cut-gate.editText 的拒绝与冲突", () => {
  const cases: Array<[string, Partial<typeof BASE>]> = [
    ["转写版本对不上", { baseTranscriptRevision: 2 }],
    ["文字版本对不上", { baseCleanRevision: 2 }],
    ["选段版本对不上", { baseCutRevision: 3 }],
  ];

  it.each(cases)("%s → 冲突（一等结果），盘上不落任何新产物", async (_name, patch) => {
    await expect(
      gate.editText(CONTENT_ID, { ...BASE, ...patch, unitId: "unit-0001", text: "今天聊聊 DeepSeek" }),
    ).rejects.toThrow(VideoConflictError);
    expect(await readTranscriptClean(vdir, 2)).toBeNull();
    expect(await readEditUnits(vdir, 3)).toBeNull();
    expect(state.revisions).toMatchObject({ clean: 1, cut: 2 });
  });

  it("不在选段门上 → 人话拒绝（改字是门上的动作，不是随时能按的）", async () => {
    state = { ...state, phase: "render", state: "running" };
    await expect(
      gate.editText(CONTENT_ID, { ...BASE, unitId: "unit-0001", text: "今天聊聊 DeepSeek" }),
    ).rejects.toThrow(/还轮不到在门上改字/);
  });

  it.each([
    ["   ", /取消勾选/],
    ["，。！", /一个字都不剩/],
    ["今".repeat(MAX_MANUAL_TEXT_CHARS + 1), /上限/],
  ])("文字非法（%#）→ 人话拒绝，产物不落", async (text, matcher) => {
    await expect(gate.editText(CONTENT_ID, { ...BASE, unitId: "unit-0001", text })).rejects.toThrow(matcher);
    expect(await readTranscriptClean(vdir, 2)).toBeNull();
  });

  it("unit_id 不存在（上一代的老指针）→ 人话拒绝，不改到别的句子上", async () => {
    await expect(
      gate.editText(CONTENT_ID, { ...BASE, unitId: "unit-9999", text: "随便改" }),
    ).rejects.toThrow(/没有「unit-9999」这一句/);
  });

  it("单元的词在当前文字里定位不到 → 人话拒绝（宁可不改，不许改错地方）", async () => {
    await fs.rm(path.join(vdir, "edit-units.v2.json"));
    await writeVersioned(vdir, "edit-units", 2, {
      schemaVersion: 1,
      transcriptRevision: 1,
      cleanRevision: 1,
      origin: "llm",
      // 词的时间与当前文字对不上（另一代转写留下的单元表）
      segments: [{ id: "unit-0001", text: "今天", startMs: 0, endMs: 999, words: [w("今", 0, 999)] }],
      suggestedDrops: [],
      flags: [],
    } satisfies VideoEditUnits);
    await expect(
      gate.editText(CONTENT_ID, { ...BASE, unitId: "unit-0001", text: "明天" }),
    ).rejects.toThrow(/定位不到/);
  });

  it("并发双写抢同一个 clean 号 → EEXIST 翻成冲突，不是红色报错", async () => {
    // 另一处已经写掉了 clean.v2（写盘赢家），我们手里的 state 还停在 v1
    await writeVersioned(vdir, "transcript-clean", 2, {
      schemaVersion: 1,
      transcriptRevision: 1,
      baseCleanRevision: 1,
      origin: "human",
      segments: [CSEG_1, CSEG_2],
    } satisfies TranscriptClean);
    await expect(
      gate.editText(CONTENT_ID, { ...BASE, unitId: "unit-0001", text: "今天聊聊 DeepSeek" }),
    ).rejects.toThrow(VideoConflictError);
    // 输的那一方在第一步就被挡下，cut/单元表没被写脏
    expect(await readEditUnits(vdir, 3)).toBeNull();
    expect(await readVersioned<VideoCut>(vdir, "cut", 3)).toBeNull();
  });

  it("clean 号写成、cut 号被人抢走 → 冲突之外还要回删孤儿 clean（否则永久冲突）", async () => {
    // 跨进程错峰：后台 promote 占走了 edit-units.v3，而 clean.v2 还空着。
    // 第一步写成、第二步撞号——孤儿 clean.v2 若留在盘上，state.revisions.clean 停在 1，
    // 此后每次改字都重算出同一个 v2、必撞孤儿，「重载后重改」永远不会成真。
    await writeVersioned(vdir, "edit-units", 3, {
      schemaVersion: 1,
      transcriptRevision: 1,
      cleanRevision: 1,
      origin: "llm",
      segments: [],
      suggestedDrops: [],
      flags: [],
    } satisfies VideoEditUnits);
    await expect(
      gate.editText(CONTENT_ID, { ...BASE, unitId: "unit-0001", text: "今天聊聊 DeepSeek" }),
    ).rejects.toThrow(VideoConflictError);
    expect(await readVersioned<TranscriptClean>(vdir, "transcript-clean", 2)).toBeNull();
  });

  it("单句字数上限前后端手抄同值（只有注释约束的口径，一行锁死）", async () => {
    const lib = await fs.readFile(
      path.join(import.meta.dirname, "../../../frontend/src/lib.ts"),
      "utf-8",
    );
    const m = /VIDEO_TEXT_EDIT_MAX_CHARS = (\d+)/.exec(lib);
    expect(Number(m?.[1])).toBe(MAX_MANUAL_TEXT_CHARS);
  });

  it("老稿件没有清洗版（clean revision 为 0）→ 指路重跑转写，而不是崩", async () => {
    state = { ...state, revisions: { transcript: 1, cut: 2 } };
    await expect(
      gate.editText(CONTENT_ID, { ...BASE, baseCleanRevision: 0, unitId: "unit-0001", text: "明天" }),
    ).rejects.toThrow(/先重跑一次转写再改字/);
  });
});
