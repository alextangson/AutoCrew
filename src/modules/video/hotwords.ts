/**
 * 热词提取（转写纠错三件套 spec §3 的「防」）。
 *
 * 口播稿正文里本来就写着正确的专有名词（DeepSeek、Harness、GPT-4），而 ASR 会把它们
 * 认成谐音词——真机验收上 "DeepSeek" 被认成 "deepsick"，错字还一路烧进成片字幕。
 * 所用模型是 SeACo-Paraformer（FunASR 的热词定制版），识别期就能按词表偏置，于是最
 * 便宜的修法是：开跑前把稿子里的专名抄给模型。
 *
 * **为什么只抽拉丁/数字词**：中文专名没有廉价的确定性提取——「深度求索」在正则眼里
 * 和任意四个汉字没区别，硬抽等于把整篇稿子当热词表，偏置被稀释反而更糟；上分词器又
 * 得为一个防御性功能背一整个词典。中文错认交给下游的 LLM 清洗兜底（spec §3/§4）。
 * 这是显式取舍，不是遗漏。
 *
 * 纯函数、无 IO、结果只由 body 决定：热词表要参与 transcribe 的 inputKey
 * （见 `HOTWORD_ALGO_VERSION`），同一篇稿子任何时候算出来都必须逐字节一样。
 */

/**
 * 提取算法的版本号，进 transcribe 的 inputKey。
 * 算法改了 = 送进模型的热词变了 = 转写结果可能不同，旧结果就不该再被复用。
 */
export const HOTWORD_ALGO_VERSION = "hot-1";

/** 上限 30：热词是偏置不是词典，表越长每个词分到的权重越低，会稀释掉真正想救的那几个 */
const MAX_HOTWORDS = 30;

/** 单字母（"I"、"a"）不是专名，进表只白占额度 */
const MIN_TOKEN_LENGTH = 2;

/**
 * 拉丁 token：**字母开头**（"4K"、"2026" 这类是内容不是专名，跟着进表只会挤掉真专名），
 * 词内允许字母数字与 `'` `+` `-`，于是 "C++"、"GPT-4"、"don't" 都能整个抓下来。
 */
const LATIN_TOKEN_RE = /[A-Za-z][A-Za-z0-9'+-]*/g;

/**
 * 从口播稿正文抽热词：频次降序、上限 30。body 为空或没有拉丁词 → 空数组
 * （调用方据此不传 `--hotword`，走缺省行为）。
 */
export function extractHotwords(body: string): string[] {
  const tally = new Map<string, { word: string; count: number }>();
  for (const token of body.match(LATIN_TOKEN_RE) ?? []) {
    if (token.length < MIN_TOKEN_LENGTH) continue;
    // 大小写不敏感去重、保留**首次出现**的写法：SeACo 的匹配对大小写不敏感，但输出会跟着
    // 热词的写法走——稿子里写 DeepSeek，字幕就该是 DeepSeek，而不是句尾那个 deepseek。
    const key = token.toLowerCase();
    const hit = tally.get(key);
    if (hit) hit.count += 1;
    else tally.set(key, { word: token, count: 1 });
  }
  // 频次降序：稿子里反复出现的词最值得占额度。同频保持首次出现顺序（Map 迭代序 + 稳定排序），
  // 同一篇稿子的结果因此完全确定——inputKey 要拿它做键，不能今天一个顺序明天一个顺序。
  return [...tally.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_HOTWORDS)
    .map((entry) => entry.word);
}
