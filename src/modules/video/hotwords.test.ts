/**
 * hotwords.test.ts —— 热词提取（转写纠错 spec §3）。
 *
 * 这个函数的产物有两个下游：送进 sidecar 的 `--hotword`，以及 transcribe 的 inputKey。
 * 后者意味着**同稿必同表**，所以除了「抽对了什么」，顺序与去重写法也一并钉死。
 * 中文稿抽不出词是显式取舍（LLM 清洗兜底），也在这里写明，免得后人当 bug 修。
 */
import { describe, it, expect } from "vitest";
import { extractHotwords, HOTWORD_ALGO_VERSION } from "./hotwords.js";

describe("extractHotwords", () => {
  it("中英混排：只抽拉丁词，中文一个不进", () => {
    expect(extractHotwords("今天聊聊 DeepSeek 和 Harness 这两个工具，深度求索很强")).toEqual([
      "DeepSeek",
      "Harness",
    ]);
  });

  it("按出现频次降序：说得越多越值得占额度", () => {
    const body = "Harness 只提一次。DeepSeek 很强，DeepSeek 又更新了，DeepSeek 真快。Claude 两次，Claude。";
    expect(extractHotwords(body)).toEqual(["DeepSeek", "Claude", "Harness"]);
  });

  it("同频保持首次出现顺序（inputKey 要拿它当键，顺序不能飘）", () => {
    expect(extractHotwords("Bravo 一次，Alpha 一次")).toEqual(["Bravo", "Alpha"]);
    expect(extractHotwords("Bravo 一次，Alpha 一次")).toEqual(extractHotwords("Bravo 一次，Alpha 一次"));
  });

  it("大小写不敏感去重，但保留首次出现的写法（字幕跟着热词写法走）", () => {
    expect(extractHotwords("DeepSeek 很强，deepseek 也行，DEEPSEEK 还是它")).toEqual(["DeepSeek"]);
  });

  it("词内 ' + - 不断词：C++ / GPT-4 / don't 整个抓下来", () => {
    expect(extractHotwords("用 C++ 写，配 GPT-4，don't 慌")).toEqual(["C++", "GPT-4", "don't"]);
  });

  it("单字母与数字开头的不进表（不是专名，只会挤掉真专名）", () => {
    expect(extractHotwords("I 用 a 4K 屏幕，2026 年，Notion 真好")).toEqual(["Notion"]);
  });

  it("上限 30 条：超出的按频次截掉，不是随机丢", () => {
    // 40 个互不相同的词，第 i 个出现 (40 - i) 次 → 频次序就是出现序
    const words = Array.from({ length: 40 }, (_, i) => `Word${i}`);
    const body = words.map((w, i) => `${w} `.repeat(40 - i)).join("");
    const got = extractHotwords(body);
    expect(got).toHaveLength(30);
    expect(got).toEqual(words.slice(0, 30));
  });

  it("空 body → 空数组（调用方据此不传 --hotword）", () => {
    expect(extractHotwords("")).toEqual([]);
  });

  it("纯中文 body → 空数组：中文专名不做确定性提取，交给 LLM 清洗兜底（显式取舍）", () => {
    expect(extractHotwords("今天聊聊深度求索这家公司，顺便讲讲字节跳动。")).toEqual([]);
  });

  it("纯标点/表情 → 空数组，不抛", () => {
    expect(extractHotwords("！！！…… 🎬🎬 —— 《》")).toEqual([]);
  });

  it("算法版本号是常量（改算法必须同时改它，否则旧转写会被错误复用）", () => {
    expect(HOTWORD_ALGO_VERSION).toBe("hot-1");
  });
});
