/**
 * transcript-clean.test.ts —— agent 层：工具校验、分窗调用、失败隔离与降级。
 * 确定性部分（分词、对齐、防线）在 transcript-clean-align.test.ts。
 *
 * **LLM 一律注入假 runLoopImpl**，断言的是不变量（覆盖不漏不重、失败只丢那一窗、
 * 任何失败模式都产出一份可用的文字），不是模型说了什么。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCleanTool, runTranscriptClean } from "./transcript-clean.js";
import { cleanWindow, fakeRunLoop, seedEngineConfig, throwingRunLoop } from "./testkit.js";
import type { CleanGroup } from "./transcript-clean-align.js";
import type { TranscriptSegment } from "./types.js";

/** 逐字成词、每词 100ms 的分句 */
function evenSeg(id: string, chars: string, offsetMs: number): TranscriptSegment {
  return {
    id,
    text: chars,
    startMs: offsetMs,
    endMs: offsetMs + chars.length * 100,
    words: [...chars].map((c, i) => ({ w: c, startMs: offsetMs + i * 100, endMs: offsetMs + (i + 1) * 100 })),
  };
}

/** 两句 × 6 词 → 只出一个窗口 */
const TWO_SEGS = [evenSeg("seg-0001", "今天聊聊效率", 0), evenSeg("seg-0002", "这西是问题", 1000)];

/** 100 句 × 10 词 = 1000 词 → planWindows 切成 3 窗 */
const MANY_SEGS = Array.from({ length: 100 }, (_, i) => evenSeg(`seg-${i}`, "零一二三四五六七八九", i * 1000));

/** 「一个字都不改，原样交回来」——清洗最常见的正确答案 */
const identity = (msg: string): CleanGroup[] =>
  cleanWindow(msg).map((s) => ({ fromSeg: s.id, toSeg: s.id, text: s.text }));

/** 原样交回 + 补个句号：拿它区分「这一窗跑成了」和「这一窗被原样透传」 */
const punctuated = (msg: string): CleanGroup[] =>
  cleanWindow(msg).map((s) => ({ fromSeg: s.id, toSeg: s.id, text: `${s.text}。` }));

describe("submit_clean 的工具层校验（不合格返错误串自纠 §4）", () => {
  const call = (groups: unknown, window = TWO_SEGS) => {
    const captured: { groups: CleanGroup[] | null } = { groups: null };
    const out = buildCleanTool(captured, { window }).execute({ groups }) as string;
    return { out, captured };
  };
  const both = [
    { fromSeg: "seg-0001", toSeg: "seg-0001", text: "今天聊聊效率。" },
    { fromSeg: "seg-0002", toSeg: "seg-0002", text: "这些是问题。" },
  ];

  it("恰好覆盖本窗 → 收下", () => {
    const { out, captured } = call(both);
    expect(out).not.toMatch(/^Error/);
    expect(captured.groups).toEqual(both);
  });

  it("合并相邻两句也合法（合并的边界在应用层再判停顿）", () => {
    const { out, captured } = call([{ fromSeg: "seg-0001", toSeg: "seg-0002", text: "今天聊聊效率，这些是问题。" }]);
    expect(out).not.toMatch(/^Error/);
    expect(captured.groups).toHaveLength(1);
  });

  it("漏了一句 → 打回并点名漏的是哪句（模型才知道补什么）", () => {
    const { out, captured } = call([both[0]]);
    expect(out).toContain("漏掉了 seg-0002");
    expect(captured.groups).toBeNull();
  });

  it("两组盖同一句 → 打回", () => {
    expect(call([both[0], { ...both[1], fromSeg: "seg-0001" }]).out).toMatch(/^Error.*重叠/);
  });

  it("提交了上下文段落里的分句 → 打回（前后文只读）", () => {
    expect(call([{ fromSeg: "seg-0009", toSeg: "seg-0009", text: "别的话" }]).out).toContain("不属于本段");
  });

  it("区间倒挂 → 打回", () => {
    expect(call([{ fromSeg: "seg-0002", toSeg: "seg-0001", text: "反过来了" }]).out).toContain("倒挂");
  });

  it("空 text = 想删掉这句话 → 打回（清洗不删内容）", () => {
    expect(call([{ ...both[0], text: "  " }, both[1]]).out).toContain("不删内容");
  });

  it("只有标点的 text → 打回", () => {
    expect(call([{ ...both[0], text: "。。。" }, both[1]]).out).toContain("一个字都没有");
  });

  it("一组合并超过 6 句 → 当场打回（不留给应用层去弃改）", () => {
    const window = Array.from({ length: 7 }, (_, i) => evenSeg(`seg-${i}`, "今天", i * 1000));
    const { out } = call([{ fromSeg: "seg-0", toSeg: "seg-6", text: "今天今天今天今天今天今天今天" }], window);
    expect(out).toContain("超过上限 6");
  });

  it("groups 以 JSON 字符串到达（中转层口径）→ 照收，不打回", () => {
    const { out, captured } = call(JSON.stringify(both));
    expect(out).not.toMatch(/^Error/);
    expect(captured.groups).toEqual(both);
  });

  it("被打回时不落 captured：半成品绝不进产物", () => {
    expect(call([both[0]]).captured.groups).toBeNull();
  });
});

describe("runTranscriptClean（LLM 一律注入假实现）", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-clean-"));
    await seedEngineConfig(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const input = { dataDir: "", segments: TWO_SEGS, body: "今天聊聊效率，这些是问题" };

  it("正常清洗 → 段 id 换成 cseg 序列，标点进 text，词时间原样", async () => {
    const groups: CleanGroup[] = [
      { fromSeg: "seg-0001", toSeg: "seg-0001", text: "今天聊聊效率，" },
      { fromSeg: "seg-0002", toSeg: "seg-0002", text: "这些是问题。" },
    ];
    const out = await runTranscriptClean({ ...input, dataDir: dir }, { runLoopImpl: fakeRunLoop([{ groups }]) });
    expect(out.warning).toBeUndefined();
    expect(out.segments.map((s) => [s.id, s.text])).toEqual([
      ["cseg-0001", "今天聊聊效率，"],
      ["cseg-0002", "这些是问题。"],
    ]);
    expect(out.segments[0].words).toEqual(TWO_SEGS[0].words);
    expect(out.segments[1].words.map((x) => x.w)).toEqual([..."这些是问题"]);
  });

  it("第一轮漏了一句被打回、第二轮补齐 → 自纠成功", async () => {
    const partial = [{ fromSeg: "seg-0001", toSeg: "seg-0001", text: "今天聊聊效率。" }];
    const out = await runTranscriptClean(
      { ...input, dataDir: dir },
      { runLoopImpl: fakeRunLoop((msg) => [{ groups: partial }, { groups: identity(msg) }]) },
    );
    expect(out.warning).toBeUndefined();
    expect(out.segments.map((s) => s.id)).toEqual(["cseg-0001", "cseg-0002"]);
  });

  it("模型只写正文不调工具 → 原样转写 + warning 点名这个失败模式", async () => {
    const out = await runTranscriptClean({ ...input, dataDir: dir }, { runLoopImpl: fakeRunLoop([]) });
    expect(out.segments).toEqual(TWO_SEGS);
    expect(out.warning).toContain("没调用 submit_clean");
  });

  it("模型调用抛错 → 原样转写 + warning，永不把异常抛给调用方", async () => {
    const out = await runTranscriptClean({ ...input, dataDir: dir }, { runLoopImpl: throwingRunLoop("relay 挂了") });
    expect(out.segments).toEqual(TWO_SEGS);
    expect(out.warning).toContain("relay 挂了");
  });

  it("三轮都没通过校验（连对半重试的子窗也没过）→ 原样转写 + warning，不抛错", async () => {
    // 引用一个压根不存在的分句：拆窗之后每个子窗也一样过不了校验，走到「全窗失败」这一格
    const bad = [{ fromSeg: "seg-9999", toSeg: "seg-9999", text: "别的话。" }];
    const out = await runTranscriptClean(
      { ...input, dataDir: dir },
      { runLoopImpl: fakeRunLoop([{ groups: bad }, { groups: bad }, { groups: bad }]) },
    );
    expect(out.segments).toEqual(TWO_SEGS);
    expect(out.warning).toContain("全部没跑成");
  });

  it("一个带时间戳的词都没有 → 根本不调模型，也不算降级", async () => {
    const out = await runTranscriptClean(
      { ...input, dataDir: dir, segments: [] },
      { runLoopImpl: throwingRunLoop("不该被调到") },
    );
    expect(out).toEqual({ segments: [] });
  });

  /**
   * 覆盖率自检是给**实现 bug** 准备的，不是给事实的缺口准备的：ASR 有时只给长词一个时间戳，
   * 原样透传的分句照单继承那个缺口。拿固定的 0.9 去卡它，会让「一组没采纳」变成「整条扔掉」。
   */
  it("事实本身缺词时间戳 → 不拿覆盖率去怪清洗，该说的仍是那一组没采纳", async () => {
    const sparse: TranscriptSegment[] = [
      { id: "seg-0001", text: "今天聊聊效率", startMs: 0, endMs: 600, words: [{ w: "今", startMs: 0, endMs: 100 }, { w: "天", startMs: 100, endMs: 200 }, { w: "效", startMs: 400, endMs: 500 }] },
    ];
    const groups = [{ fromSeg: "seg-0001", toSeg: "seg-0001", text: "明日谈谈产能" }];
    const out = await runTranscriptClean(
      { ...input, dataDir: dir, segments: sparse },
      { runLoopImpl: fakeRunLoop([{ groups }]) },
    );
    expect(out.segments.map((s) => [s.id, s.text])).toEqual([["cseg-0001", "今天聊聊效率"]]);
    expect(out.warning).toContain("没采纳");
    expect(out.warning).not.toContain("覆盖率");
  });

  it("模型把话改过头 → 那一组弃改（原文原样留着）+ warning，其余组照常应用", async () => {
    const groups: CleanGroup[] = [
      { fromSeg: "seg-0001", toSeg: "seg-0001", text: "明日谈谈产能" },
      { fromSeg: "seg-0002", toSeg: "seg-0002", text: "这些是问题。" },
    ];
    const out = await runTranscriptClean({ ...input, dataDir: dir }, { runLoopImpl: fakeRunLoop([{ groups }]) });
    expect(out.segments.map((s) => s.text)).toEqual(["今天聊聊效率", "这些是问题。"]);
    expect(out.warning).toContain("没采纳");
  });
});

describe("分窗（沿 VAD 边界 300–500 词，失败只丢那一窗）", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-clean-win-"));
    await seedEngineConfig(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const input = () => ({ dataDir: dir, segments: MANY_SEGS, body: "零一二三四五六七八九" });

  it("1000 词切成多窗，每窗各自调用、结果拼回一条", async () => {
    const seen: string[][] = [];
    const out = await runTranscriptClean(input(), {
      runLoopImpl: fakeRunLoop((msg) => {
        seen.push(cleanWindow(msg).map((s) => s.id));
        return [{ groups: punctuated(msg) }];
      }),
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.flat()).toEqual(MANY_SEGS.map((s) => s.id)); // 窗口不重不漏，顺序即原顺序
    expect(out.warning).toBeUndefined();
    expect(out.segments).toHaveLength(100);
    expect(out.segments.every((s) => s.text.endsWith("。"))).toBe(true);
    expect(out.segments.at(-1)?.id).toBe("cseg-0100");
  });

  /**
   * 失败窗对半重试一层：救回来的那一半照常应用，没救回来的那一半只丢自己。
   * warning 必须点名时间码——人得知道去复核哪一段。
   */
  it("一窗失败 → 对半重试，只有没救回来的那半段落回原样并进 warning", async () => {
    const out = await runTranscriptClean(input(), {
      runLoopImpl: fakeRunLoop((msg) => (cleanWindow(msg)[0].id === "seg-40" ? [] : [{ groups: punctuated(msg) }])),
    });
    const plain = out.segments.filter((s) => !s.text.endsWith("。"));
    expect(plain).toHaveLength(20); // seg-40..seg-59 这半窗没跑成，原样透传
    expect(plain[0].startMs).toBe(40_000);
    expect(out.warning).toContain("0:40-1:00");
    expect(out.warning).toContain("没调用 submit_clean");
    expect(out.segments).toHaveLength(100);
  });
});
