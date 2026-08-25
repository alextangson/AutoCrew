/**
 * transcript-clean-align.test.ts —— 清洗的确定性部分（转写纠错 spec §4）。
 *
 * 全是纯函数，所以逐条锁死边界：分词与 sidecar **逐样本同口径**、对齐后时间单调且不越界、
 * 合并不吞大停顿、防过拟合闸拦得住也别误杀。agent 层（分窗、并发、降级）在
 * transcript-clean.test.ts。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, runProcess } from "./proc.js";
import {
  MERGE_MAX_GAP_MS,
  applyCleanGroups,
  cleanWordCoverage,
  overfitReason,
  realignWords,
  tokenizeWordUnits,
  tokenWords,
} from "./transcript-clean-align.js";
import type { TranscriptSegment, TranscriptWord } from "./types.js";

const ASR_DIR = path.join(REPO_ROOT, "sidecars", "asr");
const CONTRACT_FILE = path.join(ASR_DIR, "word-units.contract.json");

interface ContractSample {
  text: string;
  units: string[];
}

const contract = JSON.parse(readFileSync(CONTRACT_FILE, "utf-8")) as { samples: ContractSample[] };

const w = (text: string, startMs: number, endMs: number): TranscriptWord => ({ w: text, startMs, endMs });

/** 逐字成词、每词 100ms 的分句（与 rough-cut 测试同一套写法） */
function evenSeg(id: string, chars: string, offsetMs: number, step = 100): TranscriptSegment {
  return {
    id,
    text: chars,
    startMs: offsetMs,
    endMs: offsetMs + chars.length * step,
    words: [...chars].map((c, i) => w(c, offsetMs + i * step, offsetMs + (i + 1) * step)),
  };
}

const shape = (words: readonly TranscriptWord[]): [string, number, number][] =>
  words.map((x) => [x.w, x.startMs, x.endMs]);

// ---------------------------------------------------------------------------

describe("分词：与 sidecar 的 WORD_UNIT_RE 同口径", () => {
  it.each(contract.samples)("TS 侧：$text", (sample) => {
    expect(tokenWords(tokenizeWordUnits(sample.text))).toEqual(sample.units);
  });

  /**
   * 契约的另一半：直接跑 `asr.py` 里的那个正则。两侧字面写法不同（JS 的 `\w` 恒为 ASCII，
   * 照抄 python 的 `[^\s\W_]` 会一个汉字都匹配不上），所以**必须验行为**，不能只看代码像不像。
   * 需要系统 python3（只用标准库，不进 sidecar 的 venv，也就不会拉 funasr）。
   */
  it("python 侧：asr.py 的正则对同一组样本给出同样的词", async () => {
    const script = [
      "import json, sys",
      "sys.path.insert(0, sys.argv[1])",
      "import asr",
      "samples = json.load(open(sys.argv[2], encoding='utf-8'))['samples']",
      "print(json.dumps([asr.WORD_UNIT_RE.findall(s['text']) for s in samples], ensure_ascii=False))",
    ].join("\n");
    const result = await runProcess({
      command: "python3",
      args: ["-c", script, ASR_DIR, CONTRACT_FILE],
      timeoutMs: 60_000,
    });
    expect(result.spawnError, "这条用例要跑 sidecars/asr/asr.py 的正则，需要系统 python3").toBeUndefined();
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(contract.samples.map((s) => s.units));
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe("realignWords：词级 LCS + 逐段局部重分", () => {
  const cases: { name: string; original: TranscriptWord[]; tokens: string[]; want: [string, number, number][] }[] = [
    {
      name: "两个错词合成一个专名（deep + sick → DeepSeek）：新词吃下这两个词的整段跨度",
      original: [w("今", 0, 100), w("天", 100, 200), w("deep", 200, 400), w("sick", 400, 600)],
      tokens: ["今", "天", "DeepSeek"],
      want: [["今", 0, 100], ["天", 100, 200], ["DeepSeek", 200, 600]],
    },
    {
      name: "一句里两处纠错：中间那段正确的词一毫秒都不动（前后缀锚定会把它们一起重分）",
      original: [w("这", 0, 100), w("西", 100, 200), w("是", 200, 300), w("一", 300, 400), w("各", 400, 500), w("问", 500, 600), w("题", 600, 700)],
      tokens: ["这", "些", "是", "一", "个", "问", "题"],
      want: [["这", 0, 100], ["些", 100, 200], ["是", 200, 300], ["一", 300, 400], ["个", 400, 500], ["问", 500, 600], ["题", 600, 700]],
    },
    {
      name: "只改写法（大小写）：norm 后相等即算对上，时间原样沿用、文字取新的",
      original: [w("deepseek", 0, 500)],
      tokens: ["DeepSeek"],
      want: [["DeepSeek", 0, 500]],
    },
    {
      name: "重复词被清洗删掉一遍：留下的词时间原样，删掉的时间跟着消失",
      original: [w("今", 0, 100), w("天", 100, 200), w("今", 200, 300), w("天", 300, 400), w("聊", 400, 500)],
      tokens: ["今", "天", "聊"],
      want: [["今", 0, 100], ["天", 100, 200], ["聊", 400, 500]],
    },
    {
      name: "凭空插入的词落成零宽，不去偷下一个词的时间",
      original: [w("今", 0, 100), w("天", 100, 200)],
      tokens: ["今", "啊", "天"],
      want: [["今", 0, 100], ["啊", 100, 100], ["天", 100, 200]],
    },
    {
      name: "新词比可用毫秒还多：允许零宽，但严格单调、绝不越出原跨度",
      original: [w("啊", 1000, 1002)],
      tokens: ["一", "二", "三", "四", "五"],
      want: [["一", 1000, 1000], ["二", 1000, 1001], ["三", 1001, 1001], ["四", 1001, 1002], ["五", 1002, 1002]],
    },
    {
      name: "重分按字数加权：拉丁串按字符数占时间，汉字一个字一份",
      original: [w("啊", 0, 900)],
      tokens: ["abc", "中"],
      want: [["abc", 0, 675], ["中", 675, 900]],
    },
    {
      name: "整段被删空 → 一个词都不产出（时间绝不凭空留给别人）",
      original: [w("今", 0, 100), w("天", 100, 200)],
      tokens: [],
      want: [],
    },
  ];

  it.each(cases)("$name", ({ original, tokens, want }) => {
    expect(shape(realignWords(original, tokens))).toEqual(want);
  });

  it("任何一种改法都保持单调不重叠、且困在原跨度里", () => {
    const original = [w("今", 100, 200), w("天", 200, 400), w("聊", 400, 500)];
    for (const tokens of [["今", "天", "聊"], ["明", "天", "聊", "聊"], ["A"], ["今", "天", "聊", "效", "率"]]) {
      const out = realignWords(original, tokens);
      expect(out.map((x) => x.w)).toEqual(tokens);
      for (const [i, word] of out.entries()) {
        expect(word.endMs).toBeGreaterThanOrEqual(word.startMs);
        if (i > 0) expect(word.startMs).toBeGreaterThanOrEqual(out[i - 1].endMs);
        expect(word.startMs).toBeGreaterThanOrEqual(100);
        expect(word.endMs).toBeLessThanOrEqual(500);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("防过拟合多重闸（任何一条超限 → 该组弃改）", () => {
  const words = (chars: string): TranscriptWord[] => [...chars].map((c, i) => w(c, i * 100, i * 100 + 100));

  it("短句里的一处纠错不被绝对闸误杀（「这西」→「这些」）", () => {
    expect(overfitReason(words("这西是"), ["这", "些", "是"], 1)).toBeNull();
  });

  it("短句被改了三处 → 拦下并说清改了几处（3 词最多允许 1 处）", () => {
    const reason = overfitReason(words("今天聊"), ["明", "日", "谈"], 1);
    expect(reason).toContain("短句改了 3 处");
  });

  it("长文本按比例判：35% 拦下、25% 放行（分母是较长的那一侧）", () => {
    const original = words("零一二三四五六七八九十甲乙丙丁戊己庚辛壬");
    const seven = ["Ａ", "Ｂ", "Ｃ", "Ｄ", "Ｅ", "Ｆ", "Ｇ", ...[..."七八九十甲乙丙丁戊己庚辛壬"]];
    expect(overfitReason(original, seven, 1)).toContain("改动占");
    const five = ["Ａ", "Ｂ", "Ｃ", "Ｄ", "Ｅ", ...[..."五六七八九十甲乙丙丁戊己庚辛壬"]];
    expect(overfitReason(original, five, 1)).toBeNull();
  });

  it("长度大变 = 在重写不是在纠错 → 拦下", () => {
    expect(overfitReason(words("今天聊聊"), [..."今天聊聊我们再多说几句话"], 1)).toContain("长度变了");
  });

  it("一组合并太多分句（模型想稀释比例）→ 拦下", () => {
    expect(overfitReason(words("今天"), ["今", "天"], 7)).toContain("超过上限 6");
  });

  it("改完一个词都不剩（纯标点）→ 拦下", () => {
    expect(overfitReason(words("今天"), [], 1)).toContain("一个词都不剩");
  });
});

// ---------------------------------------------------------------------------

describe("applyCleanGroups：group → cseg", () => {
  it("单句纠错：cseg 顺序编号，标点只进 text、不进 words，覆盖率满分", () => {
    const segs = [evenSeg("seg-0001", "这西是一各问题", 0)];
    const out = applyCleanGroups(segs, [{ fromSeg: "seg-0001", toSeg: "seg-0001", text: "这些是一个问题。" }]);
    expect(out.warnings).toEqual([]);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].id).toBe("cseg-0001");
    expect(out.segments[0].text).toBe("这些是一个问题。");
    expect(out.segments[0].words.map((x) => x.w)).toEqual([..."这些是一个问题"]);
    expect(cleanWordCoverage(out.segments)).toBe(1);
  });

  it("小停顿可以合并成一句：源区间取两句的外边界，词时间原样", () => {
    const segs = [evenSeg("seg-0001", "今天聊聊", 0), evenSeg("seg-0002", "效率很高", 500)];
    const out = applyCleanGroups(segs, [{ fromSeg: "seg-0001", toSeg: "seg-0002", text: "今天聊聊效率很高。" }]);
    expect(out.warnings).toEqual([]);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0]).toMatchObject({ id: "cseg-0001", text: "今天聊聊效率很高。", startMs: 0, endMs: 900 });
    expect(shape(out.segments[0].words).at(-1)).toEqual(["高", 800, 900]);
  });

  it("大停顿拒绝合并：拆回两个 cseg 各自应用文本，warning 说清为什么", () => {
    const segs = [evenSeg("seg-0001", "今天聊聊", 0), evenSeg("seg-0002", "效率很高", 1200)];
    const out = applyCleanGroups(segs, [{ fromSeg: "seg-0001", toSeg: "seg-0002", text: "今天聊聊效率很高。" }]);
    expect(out.segments.map((s) => [s.id, s.text, s.startMs, s.endMs])).toEqual([
      ["cseg-0001", "今天聊聊", 0, 400],
      ["cseg-0002", "效率很高。", 1200, 1600],
    ]);
    expect(out.warnings[0]).toContain(`${MERGE_MAX_GAP_MS}ms`);
    // 关键不变量：重分出来的词一个都没落进那段静音里（落进去就等于把静音剪进成片）
    expect(out.segments[0].words.every((x) => x.endMs <= 400)).toBe(true);
    expect(out.segments[1].words.every((x) => x.startMs >= 1200)).toBe(true);
  });

  it("大停顿两侧的错字照样各自纠正（拒绝的是合并，不是纠错）", () => {
    // VAD 把 "deep sick" 切在了词中间：前半留在上一句、后半开了下一句，中间还隔着 600ms
    const segs: TranscriptSegment[] = [
      { id: "seg-0001", text: "今天聊deep", startMs: 0, endMs: 700, words: [w("今", 0, 100), w("天", 100, 200), w("聊", 200, 300), w("deep", 300, 700)] },
      { id: "seg-0002", text: "sick很强", startMs: 1300, endMs: 1900, words: [w("sick", 1300, 1700), w("很", 1700, 1800), w("强", 1800, 1900)] },
    ];
    const out = applyCleanGroups(segs, [{ fromSeg: "seg-0001", toSeg: "seg-0002", text: "今天聊DeepSeek很强。" }]);
    expect(out.segments.map((s) => s.text)).toEqual(["今天聊DeepSeek", "很强。"]);
    expect(shape(out.segments[0].words)).toEqual([["今", 0, 100], ["天", 100, 200], ["聊", 200, 300], ["DeepSeek", 300, 700]]);
    expect(shape(out.segments[1].words)).toEqual([["很", 1700, 1800], ["强", 1800, 1900]]);
  });

  it("超闸的组弃改：这一段原样透传 + warning 点名时间码，其余组照常应用", () => {
    const segs = [evenSeg("seg-0001", "今天聊聊效率", 0), evenSeg("seg-0002", "这西是问题", 1000)];
    const out = applyCleanGroups(segs, [
      { fromSeg: "seg-0001", toSeg: "seg-0001", text: "明日谈谈效率" },
      { fromSeg: "seg-0002", toSeg: "seg-0002", text: "这些是问题。" },
    ]);
    expect(out.segments.map((s) => s.text)).toEqual(["今天聊聊效率", "这些是问题。"]);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/0:00-0:0[01].*短句改了/);
  });

  it("没被任何一组覆盖的分句（失败的窗口）原样透传，id 仍进 cseg 序列", () => {
    const segs = [evenSeg("seg-0001", "今天聊聊", 0), evenSeg("seg-0002", "这西是问题", 1000), evenSeg("seg-0003", "结束了", 2000)];
    const out = applyCleanGroups(segs, [{ fromSeg: "seg-0002", toSeg: "seg-0002", text: "这些是问题。" }]);
    expect(out.segments.map((s) => [s.id, s.text])).toEqual([
      ["cseg-0001", "今天聊聊"],
      ["cseg-0002", "这些是问题。"],
      ["cseg-0003", "结束了"],
    ]);
    expect(out.warnings).toEqual([]);
  });

  it("引用了对不上的分句 → 那一组被忽略并说出来，不静默吞掉", () => {
    const segs = [evenSeg("seg-0001", "今天聊聊", 0)];
    const out = applyCleanGroups(segs, [{ fromSeg: "seg-0009", toSeg: "seg-0009", text: "别的话" }]);
    expect(out.segments.map((s) => s.text)).toEqual(["今天聊聊"]);
    expect(out.warnings[0]).toContain("对不上");
  });
});
