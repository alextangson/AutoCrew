/**
 * rough-cut-units.test.ts —— 粗剪的确定性部分被逐条锁死。
 *
 * 这里全是纯函数：词流、健康检查、呈现、窗口划分、区间归一、单元划分、防清空。
 * 边界用例（半开区间、相邻、重叠、越界、零长度、空 drops、N==0、空 words 分句、
 * 窗口对齐 VAD、尾窗不足量）在这一层钉死，agent 那层就只用管外部调用怎么失败。
 */
import { describe, it, expect } from "vitest";
import {
  flattenWords,
  halveWindow,
  normalizeDrops,
  overDropGuard,
  planWindows,
  renderRange,
  renderWordStream,
  splitEditUnits,
  windowLabel,
  wordStreamHealth,
  WINDOW_MIN_WORDS,
  WINDOW_TARGET_WORDS,
  type RoughCutDrop,
  type WordStream,
} from "./rough-cut-units.js";
import type { TranscriptSegment } from "./types.js";

type W = [text: string, startMs: number, endMs: number];

function seg(id: string, words: W[], text?: string): TranscriptSegment {
  return {
    id,
    text: text ?? words.map(([w]) => w).join(""),
    startMs: words[0]?.[1] ?? 0,
    endMs: words[words.length - 1]?.[2] ?? 0,
    words: words.map(([w, startMs, endMs]) => ({ w, startMs, endMs })),
  };
}

/** 每词 100ms 的等长词流；`chars` 一个字一个词 */
function evenSeg(id: string, chars: string, offsetMs: number): TranscriptSegment {
  return seg(
    id,
    [...chars].map((c, i): W => [c, offsetMs + i * 100, offsetMs + (i + 1) * 100]),
  );
}

/** 两句 × 6 词，全部有词时间戳 */
const TWO_SEGS = [evenSeg("seg-0001", "今天聊聊效率", 0), evenSeg("seg-0002", "今天聊聊效率", 1000)];

describe("flattenWords", () => {
  it("words 为空的分句不进词流，其 text 也不参与任何单元（实测尾部 10 句就是这样）", () => {
    const stream = flattenWords([
      evenSeg("seg-0001", "abc", 0),
      { id: "seg-0002", text: "没有词时间戳的一句", startMs: 500, endMs: 900, words: [] },
      evenSeg("seg-0003", "de", 1000),
    ]);
    expect(stream.words.map((w) => w.w)).toEqual(["a", "b", "c", "d", "e"]);
    expect(stream.segStarts).toEqual([0, 3]);
  });

  it("空转写 → 空词流", () => {
    expect(flattenWords([])).toEqual({ words: [], segStarts: [] });
  });
});

describe("wordStreamHealth（前置健康检查 §2.5）", () => {
  it("N==0 → 拦下", () => {
    expect(wordStreamHealth([], flattenWords([]))).toContain("一个带时间戳的词都没有");
  });

  it("词覆盖不足 90% → 拦下（text 里有字拿不到词时间戳）", () => {
    const lossy = [seg("seg-0001", [["今", 0, 100]], "今天聊聊效率")];
    expect(wordStreamHealth(lossy, flattenWords(lossy))).toContain("覆盖率");
  });

  it("时间戳非单调 → 拦下", () => {
    const bad = [seg("seg-0001", [["甲", 0, 500], ["乙", 200, 600]])];
    expect(wordStreamHealth(bad, flattenWords(bad))).toContain("倒挂");
  });

  it("健康的词流放行", () => {
    expect(wordStreamHealth(TWO_SEGS, flattenWords(TWO_SEGS))).toBeNull();
  });
});

describe("renderWordStream（索引可寻址）", () => {
  const stream = flattenWords([evenSeg("seg-0001", "一二三四五六七八九十甲乙", 0), evenSeg("seg-0002", "丙丁", 2000)]);
  const lines = renderWordStream(stream).split("\n");

  it("行首索引严格等于该行首词的全局索引，任意词离最近锚点不超过 9 个词", () => {
    let cursor = 0;
    for (const line of lines) {
      const m = /^\[(\d+)\] (.*)$/.exec(line)!;
      expect(Number(m[1])).toBe(cursor);
      const body = m[2].replace(/^¶/, "");
      expect([...body].length).toBeLessThanOrEqual(10);
      cursor += [...body].length;
    }
    expect(cursor).toBe(stream.words.length);
  });

  it("行不跨分句，分句起点标 ¶", () => {
    expect(lines).toEqual(["[0] ¶一二三四五六七八九十", "[10] 甲乙", "[12] ¶丙丁"]);
  });
});

describe("planWindows（沿 VAD 边界切窗，300-500 词一窗）", () => {
  /** 按分句词数造词流：每词 100ms，句间不留空 */
  function streamOf(segLens: number[]): WordStream {
    let t = 0;
    const segs = segLens.map((len, i) =>
      seg(
        `seg-${i}`,
        Array.from({ length: len }, (): W => {
          const w: W = ["字", t, t + 100];
          t += 100;
          return w;
        }),
      ),
    );
    return flattenWords(segs);
  }

  it("窗口边界一律落在原 VAD 分句边界上（模型永不拿到半句话）", () => {
    const stream = streamOf(Array(100).fill(10)); // 1000 词 / 100 句
    const wins = planWindows(stream);
    const legal = new Set([...stream.segStarts, stream.words.length]);
    for (const w of wins) {
      expect(legal.has(w.from), `from=${w.from}`).toBe(true);
      expect(legal.has(w.to), `to=${w.to}`).toBe(true);
    }
  });

  it("窗口首尾相接、无重叠、完整覆盖整条词流", () => {
    const wins = planWindows(streamOf(Array(100).fill(10)));
    expect(wins[0].from).toBe(0);
    expect(wins[wins.length - 1].to).toBe(1000);
    for (let i = 1; i < wins.length; i++) expect(wins[i].from).toBe(wins[i - 1].to);
  });

  it("除最后一窗外，每窗都达到目标词数（实测 2732 词 → 6-9 窗）", () => {
    const wins = planWindows(streamOf(Array(273).fill(10)));
    expect(wins.length).toBeGreaterThanOrEqual(6);
    expect(wins.length).toBeLessThanOrEqual(9);
    for (const w of wins.slice(0, -1)) expect(w.to - w.from).toBeGreaterThanOrEqual(WINDOW_TARGET_WORDS);
  });

  it("总词数不足一窗 → 只出一窗", () => {
    expect(planWindows(streamOf([10, 10, 10]))).toEqual([{ from: 0, to: 30 }]);
  });

  it("尾窗不足量且并得下 → 并回上一窗（不为二十个词单开一次调用）", () => {
    // 400 + 20：尾窗 20 词 < 150，且 420 <= 500
    const wins = planWindows(streamOf([...Array(40).fill(10), 20]));
    expect(wins).toEqual([{ from: 0, to: 420 }]);
  });

  it("尾窗不足量但并进去会超上限 → 维持独立（宁可短一窗，不可超预算）", () => {
    // 首窗 400 词，尾窗 120 词 < 150，但并起来 520 > 500 → 不并
    const wins = planWindows(streamOf([...Array(40).fill(10), 120]));
    expect(wins).toEqual([{ from: 0, to: 400 }, { from: 400, to: 520 }]);
    expect(wins[1].to - wins[1].from).toBeLessThan(WINDOW_MIN_WORDS);
  });

  it("单个分句本身超上限 → 自成一窗（VAD 已是最小粒度，再切就是切碎句子）", () => {
    const wins = planWindows(streamOf([700, 100]));
    expect(wins[0]).toEqual({ from: 0, to: 700 });
  });

  it("空词流 → 没有窗口（不产生一个跑不了的空调用）", () => {
    expect(planWindows({ words: [], segStarts: [] })).toEqual([]);
  });

  it("halveWindow 沿 VAD 边界就近对半（重试时把每次要写的输出量砍半）", () => {
    const stream = streamOf(Array(100).fill(10)); // 每 10 词一个分句边界
    expect(halveWindow(stream, { from: 0, to: 400 })).toEqual([
      { from: 0, to: 200 },
      { from: 200, to: 400 },
    ]);
    // 中点不落在分句边界上时取最近的那个（205 → 200）
    expect(halveWindow(stream, { from: 0, to: 410 })).toEqual([
      { from: 0, to: 200 },
      { from: 200, to: 410 },
    ]);
  });

  it("窗内没有可切的分句边界 → null（不硬切碎句子，调用方据此放弃重试）", () => {
    const stream = streamOf([400, 100]);
    expect(halveWindow(stream, { from: 0, to: 400 })).toBeNull();
  });

  it("对半后两段首尾相接、完整覆盖原窗，且都比原窗短", () => {
    const stream = streamOf(Array(100).fill(10));
    const win = { from: 100, to: 500 };
    const [a, b] = halveWindow(stream, win)!;
    expect(a.from).toBe(win.from);
    expect(b.to).toBe(win.to);
    expect(a.to).toBe(b.from);
    expect(a.to - a.from).toBeLessThan(win.to - win.from);
    expect(b.to - b.from).toBeLessThan(win.to - win.from);
  });

  it("windowLabel 报时间码区间——warning 要点名是哪一段没跑成", () => {
    const stream = streamOf([10, 10]);
    expect(windowLabel(stream, { from: 0, to: 20 })).toBe("0:00-0:02");
    expect(windowLabel({ words: [], segStarts: [] }, { from: 0, to: 0 })).toContain("词 0-0");
  });
});

describe("renderRange（分窗后仍用全局索引）", () => {
  it("只渲染指定区间，行首索引仍是全局值（不重新编号，免去偏移换算这一层错源）", () => {
    const stream = flattenWords([evenSeg("seg-0001", "一二三四五六七八九十甲乙", 0)]);
    expect(renderRange(stream, 10, 12)).toBe("[10] 甲乙");
  });
});

describe("splitEditUnits（切点 = drop 边界 ∪ 分句边界）", () => {
  const stream = flattenWords(TWO_SEGS);

  it("区间半开：drop [0,3) 切走前三个词，索引 3 的词还在", () => {
    const { units, droppedIds } = splitEditUnits(stream, [{ startWord: 0, endWordExclusive: 3, flag: "repeat" }]);
    expect(units.map((u) => u.text)).toEqual(["今天聊", "聊效率", "今天聊聊效率"]);
    expect(units.map((u) => [u.startMs, u.endMs])).toEqual([[0, 300], [300, 600], [1000, 1600]]);
    expect(droppedIds).toEqual(["unit-0001"]);
  });

  it("drops 为空 → 单元退化成原分句切分（合法，全 keep）", () => {
    const { units, droppedIds, flags } = splitEditUnits(stream, []);
    expect(units.map((u) => u.text)).toEqual(["今天聊聊效率", "今天聊聊效率"]);
    expect(droppedIds).toEqual([]);
    expect(flags).toEqual([]);
  });

  it("相邻 drop 各自成单元，两个都被丢，中间不留空单元", () => {
    const drops: RoughCutDrop[] = [
      { startWord: 0, endWordExclusive: 2, flag: "repeat" },
      { startWord: 2, endWordExclusive: 4, flag: "misread" },
    ];
    const { units, droppedIds, flags } = splitEditUnits(stream, drops);
    expect(units.map((u) => u.text)).toEqual(["今天", "聊聊", "效率", "今天聊聊效率"]);
    expect(droppedIds).toEqual(["unit-0001", "unit-0002"]);
    expect(flags.map((f) => f.flag)).toEqual(["repeat", "misread"]);
  });

  it("drop 整段覆盖一个分句边界 → 跨界的那段整体被丢", () => {
    const { units, droppedIds } = splitEditUnits(stream, [{ startWord: 4, endWordExclusive: 8, flag: "repeat" }]);
    // 切点 {0,4,6,8,12}：分句边界 6 仍然把它切成两段，两段都在 drop 里
    expect(units.map((u) => u.text)).toEqual(["今天聊聊", "效率", "今天", "聊聊效率"]);
    expect(droppedIds).toEqual(["unit-0002", "unit-0003"]);
  });

  it("N==0 → 一个单元都不产（不崩）", () => {
    expect(splitEditUnits({ words: [], segStarts: [] }, [])).toEqual({ units: [], droppedIds: [], flags: [] });
  });

  it("词是原子：所有单元的词按顺序拼回去，与原词流逐个全等", () => {
    const { units } = splitEditUnits(stream, [{ startWord: 1, endWordExclusive: 5, flag: "misread" }]);
    expect(units.flatMap((u) => u.words)).toEqual(stream.words);
  });
});

describe("normalizeDrops（排序、去重、同 flag 相邻合并）", () => {
  it("乱序输入被排序", () => {
    const out = normalizeDrops([
      { startWord: 8, endWordExclusive: 10, flag: "repeat" },
      { startWord: 0, endWordExclusive: 2, flag: "repeat" },
    ]);
    expect(out.map((d) => d.startWord)).toEqual([0, 8]);
  });

  it("完全相同的区间去重", () => {
    const one = { startWord: 0, endWordExclusive: 2, flag: "repeat" } as const;
    expect(normalizeDrops([one, { ...one }])).toEqual([one]);
  });

  it("同 flag 相邻合并成一段；不同 flag 相邻各留各的（合并会丢掉一个标记）", () => {
    expect(
      normalizeDrops([
        { startWord: 0, endWordExclusive: 2, flag: "repeat" },
        { startWord: 2, endWordExclusive: 4, flag: "repeat" },
      ]),
    ).toEqual([{ startWord: 0, endWordExclusive: 4, flag: "repeat" }]);
    expect(
      normalizeDrops([
        { startWord: 0, endWordExclusive: 2, flag: "repeat" },
        { startWord: 2, endWordExclusive: 4, flag: "misread" },
      ]),
    ).toHaveLength(2);
  });
});

describe("overDropGuard（防清空按时长，不按句数 §2.3）", () => {
  const split = (droppedIds: string[]) => ({
    units: [evenSeg("unit-0001", "一二三四", 0), evenSeg("unit-0002", "五六七八", 1000)],
    droppedIds,
    flags: [],
  });

  it("恰好 50% 放行——spec 写的是「超过一半」", () => {
    expect(overDropGuard(split(["unit-0001"]))).toBeNull();
  });

  it("略超一半就拦下，落人话 warning", () => {
    const uneven = {
      units: [evenSeg("unit-0001", "一二三四五", 0), evenSeg("unit-0002", "六七八九", 1000)],
      droppedIds: ["unit-0001"],
      flags: [],
    };
    expect(overDropGuard(uneven)).toContain("超过一半");
  });

  it("一段都没丢 → 放行", () => {
    expect(overDropGuard(split([]))).toBeNull();
  });
});

