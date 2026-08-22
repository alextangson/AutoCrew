/**
 * rough-cut.test.ts —— agent 层：工具校验、分窗调用、合并、失败隔离与降级。
 * 纯函数（词流/窗口划分/单元划分/防清空）在 rough-cut-units.test.ts。
 *
 * **LLM 一律注入假 runLoopImpl**，断言的是不变量（区间合法、keeps 是补集、时间戳一个
 * 字节都没动、哪一窗失败就只丢哪一窗），不是模型说了什么。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildRoughCutTool, runRoughCut } from "./rough-cut.js";
import { flattenWords, planWindows, type RoughCutDrop } from "./rough-cut-units.js";
import { fakeRunLoop, seedEngineConfig, throwingRunLoop, windowOf, type FakeTurns } from "./testkit.js";
import type { TranscriptSegment } from "./types.js";

type W = [text: string, startMs: number, endMs: number];

/** 每词 100ms 的等长词流；`chars` 一个字一个词 */
function evenSeg(id: string, chars: string, offsetMs: number): TranscriptSegment {
  return {
    id,
    text: chars,
    startMs: offsetMs,
    endMs: offsetMs + chars.length * 100,
    words: [...chars].map((c, i) => ({ w: c, startMs: offsetMs + i * 100, endMs: offsetMs + (i + 1) * 100 })),
  };
}

/** 两句 × 6 词，全部有词时间戳 —— 只出一个窗口 */
const TWO_SEGS = [evenSeg("seg-0001", "今天聊聊效率", 0), evenSeg("seg-0002", "今天聊聊效率", 1000)];

/** 100 句 × 10 词 = 1000 词 → planWindows 切成 3 窗 */
function manySegs(): TranscriptSegment[] {
  return Array.from({ length: 100 }, (_, i) => evenSeg(`seg-${i}`, "零一二三四五六七八九", i * 1000));
}

describe("submit_rough_cut 的工具层校验（不合格返错误串自纠 §2.2）", () => {
  const stream = flattenWords(TWO_SEGS);
  const call = (drops: unknown[], allowOfftopic = true, window = { from: 0, to: 12 }) => {
    const captured: { drops: RoughCutDrop[] | null } = { drops: null };
    const out = buildRoughCutTool(captured, { stream, window, allowOfftopic }).execute({ drops }) as string;
    return { out, captured };
  };
  /** drops 以中转层给的原始形态（字符串）到达 */
  const raw = (drops: unknown) => {
    const captured: { drops: RoughCutDrop[] | null } = { drops: null };
    const out = buildRoughCutTool(captured, { stream, window: { from: 0, to: 12 }, allowOfftopic: true }).execute({ drops }) as string;
    return { out, captured };
  };
  const ok = { startWord: 0, endWordExclusive: 3, flag: "repeat", quote: "今天聊" };

  it("合法区间被收下，quote/note 不落盘", () => {
    const { out, captured } = call([{ ...ok, note: "这是重复的一遍" }]);
    expect(out).not.toMatch(/^Error/);
    expect(captured.drops).toEqual([{ startWord: 0, endWordExclusive: 3, flag: "repeat" }]);
  });

  it("空 drops 合法（AI 认为无需剔除）", () => {
    const { out, captured } = call([]);
    expect(out).not.toMatch(/^Error/);
    expect(captured.drops).toEqual([]);
  });

  // ↓ 回归：2026-08-22 真实素材实测暴露的 bug，用当时的原始 payload 形状钉住
  it("drops 被序列化成 JSON 字符串 → 照样收下，绝不静默当成「没有建议」", () => {
    const { out, captured } = raw(JSON.stringify([ok]));
    expect(out).not.toMatch(/^Error/);
    expect(captured.drops).toEqual([{ startWord: 0, endWordExclusive: 3, flag: "repeat" }]);
  });

  it("drops 字符串与直接传数组产出完全一致（字符串是中转层的常态，不是错误）", () => {
    const viaArray = call([ok]).captured.drops;
    const viaString = raw(JSON.stringify([ok])).captured.drops;
    expect(viaString).toEqual(viaArray);
  });

  it("note 里写了未转义的半角引号 → 照样解析出来，绝不因此打回（模型改不掉，打回只会烧完三轮）", () => {
    // 实测原样 payload（2026-08-22 真实素材跑挂的那三次）
    const payload =
      '[\n  {\n    "startWord": 0,\n    "endWordExclusive": 3,\n    "flag": "misread",\n' +
      '    "quote": "今天聊",\n    "note": "口误，应为"所以今天想"，但话未说完就改口重来"\n  }\n]';
    const { out, captured } = raw(payload);
    expect(out).not.toMatch(/^Error/);
    expect(captured.drops).toEqual([{ startWord: 0, endWordExclusive: 3, flag: "misread" }]);
  });

  it("真的解析不出来才打回，且说清是解析问题", () => {
    const { out, captured } = raw('[{"startWord":');
    expect(out).toMatch(/^Error/);
    expect(out).toContain("解析不了");
    expect(captured.drops).toBeNull();
  });

  it("解析得出但不是数组 → 打回", () => {
    expect(raw("{}").out).toContain("不是数组");
    expect(raw("123").out).toContain("不是数组");
  });

  it("drops 是数组/字符串以外的类型 → 打回，不悄悄变成空数组", () => {
    expect(call([]).captured.drops).toEqual([]); // 显式空数组才是「没得剔」
    for (const bad of [undefined, 42, { startWord: 0 }]) {
      const captured: { drops: RoughCutDrop[] | null } = { drops: null };
      const tool = buildRoughCutTool(captured, { stream, window: { from: 0, to: 12 }, allowOfftopic: true });
      const out = tool.execute({ drops: bad }) as string;
      expect(out, String(bad)).toMatch(/^Error/);
      expect(captured.drops, String(bad)).toBeNull();
    }
  });

  it("区间只有 2 个词、模型照 prompt 引了 8 个词 → 收下（验的是起点对不对，不是引够没有）", () => {
    // 实测原样：[1311,1313) 是「修改」，模型 quote 了「修改修改AI的能力」
    const short = { startWord: 0, endWordExclusive: 2, flag: "repeat", quote: "今天聊聊效率今天" };
    expect(call([short]).out).not.toMatch(/^Error/);
  });

  it("quote 比实际文本短也收下（少引几个词不算索引错）", () => {
    expect(call([{ ...ok, quote: "今天" }]).out).not.toMatch(/^Error/);
  });

  it("quote 只有一个字 → 打回（太短了核对不出索引对错）", () => {
    expect(call([{ ...ok, quote: "今" }]).out).toContain("太短");
  });

  it("含英文词的 quote：一个词多个字，按字数还是词数写都收（口径歧义不该由模型承担）", () => {
    const en = flattenWords([
      { id: "s1", text: "改AI能力", startMs: 0, endMs: 400, words: [
        { w: "改", startMs: 0, endMs: 100 }, { w: "AI", startMs: 100, endMs: 200 },
        { w: "能", startMs: 200, endMs: 300 }, { w: "力", startMs: 300, endMs: 400 },
      ] },
    ]);
    const run = (quote: string) => {
      const captured: { drops: RoughCutDrop[] | null } = { drops: null };
      const tool = buildRoughCutTool(captured, { stream: en, window: { from: 0, to: 4 }, allowOfftopic: true });
      return tool.execute({ drops: [{ startWord: 0, endWordExclusive: 2, flag: "misread", quote }] }) as string;
    };
    expect(run("改AI能力")).not.toMatch(/^Error/); // 比区间长
    expect(run("改AI")).not.toMatch(/^Error/); // 恰好区间
    expect(run("改a")).not.toMatch(/^Error/); // 大小写归一
    expect(run("能力改AI")).toMatch(/^Error/); // 真数错了
  });

  it("startWord/endWordExclusive 以字符串数字到达 → 转换后照常校验；转不动才打回", () => {
    expect(call([{ ...ok, startWord: "0", endWordExclusive: "3" }]).out).not.toMatch(/^Error/);
    for (const bad of ["abc", "零", Number.NaN, Number.POSITIVE_INFINITY, 1.5, null]) {
      expect(call([{ ...ok, startWord: bad }]).out, String(bad)).toContain("必须是整数");
    }
  });

  it("空数组与解析失败说的是两句不同的话（上一版把后者说成前者，丢了一整轮的建议）", () => {
    expect(call([]).out).toContain("无需剔除");
    expect(raw('[{"startWord":').out).toContain("解析不了");
  });

  it("越界被打回，并报出本窗的合法范围", () => {
    expect(call([{ ...ok, endWordExclusive: 99 }]).out).toContain("越界");
    expect(call([{ ...ok, startWord: -1 }]).out).toContain("越界");
  });

  it("落在上下文段落里的区间被打回：前后文只读，剔不得", () => {
    const out = call([{ startWord: 0, endWordExclusive: 3, flag: "repeat", quote: "今天聊" }], true, { from: 6, to: 12 }).out;
    expect(out).toContain("越界");
    expect(out).toContain("[6, 12)");
    expect(out).toContain("前后文只供判断");
  });

  it("零长度 / 倒挂区间被打回", () => {
    expect(call([{ ...ok, endWordExclusive: 0 }]).out).toContain("零长度");
    expect(call([{ startWord: 5, endWordExclusive: 2, flag: "repeat", quote: "率" }]).out).toContain("零长度");
  });

  it("真重叠被打回；首尾相接合法", () => {
    const overlap = [ok, { startWord: 2, endWordExclusive: 5, flag: "repeat", quote: "聊聊效" }];
    expect(call(overlap).out).toContain("重叠");
    const touching = [ok, { startWord: 3, endWordExclusive: 5, flag: "misread", quote: "聊效" }];
    expect(call(touching).out).not.toMatch(/^Error/);
  });

  it("flag 缺失或不认识 → 打回", () => {
    expect(call([{ startWord: 0, endWordExclusive: 3, quote: "今天聊" }]).out).toContain("flag");
    expect(call([{ ...ok, flag: "boring" }]).out).toContain("flag");
  });

  it("quote 对不上 → 打回，并把该索引处的真实文本还给它（防索引漂移的唯一实用手段）", () => {
    const drifted = call([{ ...ok, startWord: 3, endWordExclusive: 6, quote: "今天聊" }]).out;
    expect(drifted).toContain("索引数错了");
    expect(drifted).toContain("聊效率");
  });

  it("quote 缺失 → 打回", () => {
    expect(call([{ startWord: 0, endWordExclusive: 3, flag: "repeat" }]).out).toContain("quote");
  });

  it("scriptCoverage < 0.5 时 offtopic 被拒收，指路 repeat/misread", () => {
    const out = call([{ ...ok, flag: "offtopic" }], false).out;
    expect(out).toContain("offtopic");
    expect(out).toContain("repeat/misread");
    expect(call([ok], false).out).not.toMatch(/^Error/);
  });

  it("被打回时不落 captured：半成品绝不进产物", () => {
    expect(call([{ ...ok, endWordExclusive: 99 }]).captured.drops).toBeNull();
  });
});

describe("runRoughCut（LLM 一律注入假实现）", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-rough-cut-"));
    await seedEngineConfig(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const input = { dataDir: "", segments: TWO_SEGS, body: "今天聊聊效率" };

  it("提交合法建议 → origin llm，keeps 是补集，时间戳原样", async () => {
    const drops = [{ startWord: 6, endWordExclusive: 9, flag: "misread", quote: "今天聊" }];
    const out = await runRoughCut({ ...input, dataDir: dir }, { runLoopImpl: fakeRunLoop([{ drops }]) });
    expect(out.origin).toBe("llm");
    expect(out.warning).toBeUndefined();
    expect(out.units.flatMap((u) => u.words)).toEqual(flattenWords(TWO_SEGS).words);
    const kept = out.units.map((u) => u.id).filter((id) => !out.suggestedDrops.includes(id));
    expect(new Set([...kept, ...out.suggestedDrops]).size).toBe(out.units.length);
    expect(out.provenance?.model).toBe("test-strong");
  });

  it("drops 为空是合法结论：origin 仍是 llm，全 keep（AI 真的看过，只是认为不用剔）", async () => {
    const out = await runRoughCut({ ...input, dataDir: dir }, { runLoopImpl: fakeRunLoop([{ drops: [] }]) });
    expect(out.origin).toBe("llm");
    expect(out.suggestedDrops).toEqual([]);
    expect(out.warning).toBeUndefined();
    expect(out.units.map((u) => u.text)).toEqual(["今天聊聊效率", "今天聊聊效率"]);
  });

  it("第一轮索引数错被打回、第二轮改对 → 自纠成功", async () => {
    const wrong = [{ startWord: 0, endWordExclusive: 3, flag: "repeat", quote: "效率今" }];
    const right = [{ startWord: 0, endWordExclusive: 3, flag: "repeat", quote: "今天聊" }];
    const out = await runRoughCut(
      { ...input, dataDir: dir },
      { runLoopImpl: fakeRunLoop([{ drops: wrong }, { drops: right }]) },
    );
    expect(out.origin).toBe("llm");
    expect(out.suggestedDrops).toEqual(["unit-0001"]);
  });

  it("建议删除超过一半 → 不应用，全留版 + warning（不让模型自纠去凑比例）", async () => {
    const drops = [{ startWord: 0, endWordExclusive: 7, flag: "repeat", quote: "今天聊聊效率今" }];
    const out = await runRoughCut({ ...input, dataDir: dir }, { runLoopImpl: fakeRunLoop([{ drops }]) });
    expect(out.origin).toBe("raw");
    expect(out.suggestedDrops).toEqual([]);
    expect(out.warning).toContain("超过一半");
    expect(out.units.map((u) => u.id)).toEqual(["seg-0001", "seg-0002"]);
  });

  it("三轮都没通过校验 → 全留版 + warning，不抛错", async () => {
    const bad = [{ startWord: 0, endWordExclusive: 999, flag: "repeat", quote: "今天聊" }];
    const out = await runRoughCut(
      { ...input, dataDir: dir },
      { runLoopImpl: fakeRunLoop([{ drops: bad }, { drops: bad }, { drops: bad }]) },
    );
    expect(out.origin).toBe("raw");
    expect(out.warning).toContain("没跑成");
  });

  it("模型调用抛错 → 全留版 + warning，永不把异常抛给调用方", async () => {
    const out = await runRoughCut({ ...input, dataDir: dir }, { runLoopImpl: throwingRunLoop("relay 挂了") });
    expect(out).toMatchObject({ origin: "raw", suggestedDrops: [] });
    expect(out.warning).toContain("relay 挂了");
  });

  it("模型只写正文不调工具 → 点名这个失败模式（实测踩过的坑）", async () => {
    const out = await runRoughCut({ ...input, dataDir: dir }, { runLoopImpl: fakeRunLoop([]) });
    expect(out.origin).toBe("raw");
    expect(out.warning).toContain("没调用 submit_rough_cut");
  });

  it("词流不健康 → 根本不调模型", async () => {
    const out = await runRoughCut(
      { ...input, dataDir: dir, segments: [] },
      { runLoopImpl: throwingRunLoop("不该被调到") },
    );
    expect(out.warning).toContain("一个带时间戳的词都没有");
  });

  it("scriptCoverage < 0.5 时工具层拒 offtopic，模型只能改用 repeat", async () => {
    const offtopic = [{ startWord: 0, endWordExclusive: 3, flag: "offtopic", quote: "今天聊" }];
    const fallback = [{ startWord: 0, endWordExclusive: 3, flag: "repeat", quote: "今天聊" }];
    const out = await runRoughCut(
      { ...input, dataDir: dir, scriptCoverage: 0.3 },
      { runLoopImpl: fakeRunLoop([{ drops: offtopic }, { drops: fallback }]) },
    );
    expect(out.flags).toEqual([{ segmentId: "unit-0001", flag: "repeat" }]);
  });
});

describe("分窗（实测教训：整条词流一次交给模型，它会 narrate 到截断，永远走不到 tool call）", () => {
  let dir: string;
  const segs = manySegs();
  const stream = flattenWords(segs);
  const windows = planWindows(stream);
  const long = { dataDir: "", segments: segs, body: "零一二三四五六七八九" };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocrew-rough-cut-win-"));
    await seedEngineConfig(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** 每窗剔掉自己开头的 3 个词 */
  const dropHead = (msg: string): FakeTurns => {
    const w = windowOf(msg);
    const quote = stream.words.slice(w.from, w.from + 3).map((x) => x.w).join("");
    return [{ drops: [{ startWord: w.from, endWordExclusive: w.from + 3, flag: "repeat", quote }] }];
  };

  it("1000 词切成多窗，每窗一次独立调用，全局索引不重新编号", async () => {
    expect(windows.length).toBeGreaterThan(1);
    const seen: Array<{ from: number; to: number }> = [];
    const out = await runRoughCut(
      { ...long, dataDir: dir },
      {
        runLoopImpl: fakeRunLoop((msg) => {
          seen.push(windowOf(msg));
          return dropHead(msg);
        }),
      },
    );
    expect(seen).toEqual(windows.map((w) => ({ from: w.from, to: w.to })));
    expect(out.origin).toBe("llm");
    expect(out.warning).toBeUndefined();
    // 各窗建议全部汇总进来，且用的是全局索引（剔除点就落在每窗起点）
    expect(out.suggestedDrops).toHaveLength(windows.length);
    const droppedStarts = out.units.filter((u) => out.suggestedDrops.includes(u.id)).map((u) => u.startMs);
    expect(droppedStarts).toEqual(windows.map((w) => stream.words[w.from].startMs));
  });

  it("跨窗相邻的建议在合并时接成一段（normalizeDrops 同 flag 相邻合并）", async () => {
    const boundary = windows[0].to;
    const out = await runRoughCut(
      { ...long, dataDir: dir },
      {
        runLoopImpl: fakeRunLoop((msg) => {
          const w = windowOf(msg);
          // 第一窗剔末尾 5 词，第二窗剔开头 5 词 —— 两段在窗边界上首尾相接
          const range =
            w.to === boundary ? { from: boundary - 5, to: boundary } : w.from === boundary ? { from: boundary, to: boundary + 5 } : null;
          if (!range) return [{ drops: [] }];
          const quote = stream.words.slice(range.from, range.from + 5).map((x) => x.w).join("");
          return [{ drops: [{ startWord: range.from, endWordExclusive: range.to, flag: "repeat", quote }] }];
        }),
      },
    );
    // 两窗各自的建议合并成一段连续的 10 词。单元仍是两个——窗边界同时也是 VAD 分句边界，
    // 而分句边界永远是切点（§2.1：保留区要切成人能逐条勾的粒度），这不是没合并。
    const dropped = out.units.filter((u) => out.suggestedDrops.includes(u.id));
    expect(dropped.flatMap((u) => u.words)).toHaveLength(10);
    expect(dropped[0].startMs).toBe(stream.words[boundary - 5].startMs);
    expect(dropped[dropped.length - 1].endMs).toBe(stream.words[boundary + 4].endMs);
    // 连续：前一段的结尾就是后一段的开头，中间没有漏掉的词
    for (let i = 1; i < dropped.length; i++) expect(dropped[i].startMs).toBe(dropped[i - 1].endMs);
  });

  it("单窗失败只丢那一窗：其余建议照常应用，warning 点名时间码", async () => {
    const bad = windows[1];
    const out = await runRoughCut(
      { ...long, dataDir: dir },
      {
        runLoopImpl: fakeRunLoop((msg) => {
          const w = windowOf(msg);
          // 整段都挂（含对半重试的两个子窗），这里测的是隔离不是重试
          if (w.from >= bad.from && w.to <= bad.to) throw new Error("这一窗中转 502");
          return dropHead(msg);
        }),
      },
    );
    expect(out.origin).toBe("llm");
    expect(out.suggestedDrops).toHaveLength(windows.length - 1);
    expect(out.warning).toContain("需手工复核");
    expect(out.warning).toContain("其余段落的建议已应用");
    // 时间码指向失败的那一段，人才知道去复核哪儿
    const startSec = Math.round(stream.words[bad.from].startMs / 1000);
    expect(out.warning).toContain(`${Math.floor(startSec / 60)}:${String(startSec % 60).padStart(2, "0")}`);
    // 失败窗口内的词一个都没被剔
    const droppedWordStarts = new Set(
      out.units.filter((u) => out.suggestedDrops.includes(u.id)).map((u) => u.startMs),
    );
    expect(droppedWordStarts.has(stream.words[bad.from].startMs)).toBe(false);
  });

  it("全窗失败 → 退回全留版，warning 说清是全部失败", async () => {
    const out = await runRoughCut(
      { ...long, dataDir: dir },
      { runLoopImpl: throwingRunLoop("端点全挂") },
    );
    expect(out.origin).toBe("raw");
    expect(out.suggestedDrops).toEqual([]);
    // 每个原窗都对半重试过一次，所以「全部没跑成」的段数是子窗粒度
    expect(out.warning).toContain(`${windows.length * 2} 段全部没跑成`);
    expect(out.warning).toContain("端点全挂");
    expect(out.units.map((u) => u.id)).toEqual(segs.map((s) => s.id));
  });

  it("某窗失败 → 对半重试；一半成一半败，各自独立结算", async () => {
    const bad = windows[1];
    const [left, right] = [
      { from: bad.from, to: (bad.from + bad.to) / 2 },
      { from: (bad.from + bad.to) / 2, to: bad.to },
    ];
    const seen: Array<{ from: number; to: number }> = [];
    const out = await runRoughCut(
      { ...long, dataDir: dir },
      {
        runLoopImpl: fakeRunLoop((msg) => {
          const w = windowOf(msg);
          seen.push(w);
          // 原窗必挂（模型只写正文）；对半后左半跑通、右半仍挂
          if (w.from === bad.from && w.to === bad.to) return [];
          if (w.from === right.from && w.to === right.to) return [];
          return dropHead(msg);
        }),
      },
    );
    // 拆了一层：3 个原窗 + 2 个子窗
    expect(seen).toHaveLength(windows.length + 2);
    expect(seen).toContainEqual(left);
    expect(seen).toContainEqual(right);

    // 成的那半照常应用：两个正常窗 + 左半 = 3 个建议
    expect(out.origin).toBe("llm");
    expect(out.suggestedDrops).toHaveLength(windows.length);
    const droppedStarts = out.units.filter((u) => out.suggestedDrops.includes(u.id)).map((u) => u.startMs);
    expect(droppedStarts).toContain(stream.words[left.from].startMs);

    // 挂的那半进 warning，且点的是**子窗**的时间码，不是原窗的
    expect(out.warning).toContain("需手工复核");
    const clock = (ms: number) => {
      const t = Math.round(ms / 1000);
      return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
    };
    expect(out.warning).toContain(clock(stream.words[right.from].startMs));
  });

  it("子窗再失败也不再拆：只拆一层，最坏耗时可控", async () => {
    const bad = windows[1];
    let calls = 0;
    const out = await runRoughCut(
      { ...long, dataDir: dir },
      {
        runLoopImpl: fakeRunLoop((msg) => {
          calls += 1;
          const w = windowOf(msg);
          return w.from >= bad.from && w.to <= bad.to ? [] : dropHead(msg);
        }),
      },
    );
    // 3 个原窗 + 2 个子窗，没有第三层
    expect(calls).toBe(windows.length + 2);
    expect(out.origin).toBe("llm");
    expect(out.warning).toContain("需手工复核");
  });

  it("窗内切不动（整窗一个分句）→ 不重试，直接认这一窗失败", async () => {
    const one = [evenSeg("seg-0", "零一二三四五六七八九".repeat(45), 0)]; // 450 词一个分句
    let calls = 0;
    const out = await runRoughCut(
      { dataDir: dir, segments: one, body: "零一二三四五六七八九" },
      {
        runLoopImpl: fakeRunLoop(() => {
          calls += 1;
          return [];
        }),
      },
    );
    expect(calls).toBe(1); // 没有重试
    expect(out.origin).toBe("raw");
    expect(out.warning).toContain("全部没跑成");
  });

  it("重试也全挂 → 退回全留版（子窗也算进「全部没跑成」）", async () => {
    const out = await runRoughCut({ ...long, dataDir: dir }, { runLoopImpl: fakeRunLoop([]) });
    expect(out.origin).toBe("raw");
    expect(out.suggestedDrops).toEqual([]);
    expect(out.warning).toContain("全部没跑成");
  });

  it("每窗都带前后各约 50 词的只读上下文，且标明不能剔（重录常跨窗边界）", async () => {
    const msgs: string[] = [];
    await runRoughCut(
      { ...long, dataDir: dir },
      {
        runLoopImpl: fakeRunLoop((msg) => {
          msgs.push(msg);
          return [{ drops: [] }];
        }),
      },
    );
    const middle = msgs[1];
    expect(middle).toContain("前文");
    expect(middle).toContain("后文");
    expect(middle).toContain("不能剔除");
    // 上下文用的也是全局索引：第二窗前文起点 = from - 50
    expect(middle).toContain(`[${windows[1].from - 50}]`);
  });
});
