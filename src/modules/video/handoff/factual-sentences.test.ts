import { describe, it, expect } from "vitest";
import { factualSentences, findAttribution } from "./factual-sentences.js";

/**
 * 真实语料：content-1790393879117-j2v9ag（2026-09-26 抖音口播《深度思考开到最高，AI 反而更常会错你的意》）。
 * 旧正则按「说 / 一个 / 一次」把这些句子全判成数字/归因句，宿主只能把观点句挂到无关的外部证据上。
 */
const IDIOM_AND_ARTICLE_SENTENCES = [
  "先说这个开关到底管什么。",
  "豆包、DeepSeek 里，它就是一个叫「深度思考」的开关。",
  "刚才那组实测，从头到尾是同一个模型，只换了档位。",
  "开 low 还是开 max，背后是同一个脑子，会的东西一样多。",
  "往上拉，变的只有两样：交给你之前，它自己查几遍；你没说清楚的地方，它自己替你拿多少主意。",
  "那批难题里有一道，是做一个网页安检的小工具，专门拦住偷偷藏进网页里的恶意代码。",
  "low 那边，写一遍，拿一个例子试一下，就交了。",
  "low 那版，就一个记录页加一张简单的图；max 那版，多出来一张需求里压根没提的热力图。",
  "一句话里没说的，档位越高，它替你补得越多。",
  "但这组数的方向，跟前面说的对得上：查得多了，漏的就少；替你拿的主意多了，挑错的机会也多。",
  "它只干一件事：动手之前，一轮一轮地问你，把你没说清的全问出来，每个问题还附上它推荐的答案，你只管选。",
  "你用不着装什么技能，把这个意思变成一句话，贴在需求后面就行：先别动手，一轮一轮问我，把我没说清的都问出来，每个问题给我一个你推荐的答案。",
  "你只说「帮我写个活动复盘」，再贴上这句话。",
  "你回一个「对」，它再问下一轮。",
  "因为说不清才是常态。",
  "问自己一句：做成什么样算对，我能不能一句话说清楚。",
  "说不清，就先让它拷问你。",
  "你说不清的地方，就是它替你拿主意的地方。",
  "一眼就能说出「不是这个」，就补一句，再来一版。",
  "换一句话给它：逐条检查这份东西，数有没有算错，情况有没有漏掉，前后说法有没有打架，把问题列出来，先别改。",
  "第四步，要紧的东西交出去之前，换一个 AI 来挑刺。",
  "我自己用 AI 有条规矩，不让同一个 AI 既当运动员又当裁判员：一个出方案，另一个专门挑刺。",
  "它检查自己，只能拿自己那份理解去对；换一个没参与的来看，方向上的偏才看得出来。",
  "豆包写的，就贴给 DeepSeek；或者同一个 App 新开一个对话，把东西贴进去，只问一句：这份东西最可能错在哪？",
  "说到这儿你可能会想：我平时反复改、反复问，是不是用错了？",
  "多说几句我自己的想法。",
  "前面说，档位换不了脑子。",
  "上下文，说白了就是这件事的来龙去脉：老板到底在意什么，这个客户上回在微信里为啥不高兴，这份复盘最后是拿给谁看的。",
  "所以同一个 AI，有人用得飞快，有人用完还得自己重做一遍。",
  "你上一次点深度思考之前，它问过你问题吗？",
];

const NUMBER_SENTENCES: Array<[string, string[]]> = [
  ["Anthropic 做 Claude Code 的 Thariq，刚公开了一组实测：同一批难题，同一个模型，思考档位开到最低和开到最高，各做了 370 次。", ["370 次"]],
  ["low 用了 1.5 分钟；档位一路往上加，到了 max，做了 67 分钟。", ["1.5 分钟", "67 分钟"]],
  ["从 low 开到 max，漏了的，从 59 降到了 24，砍掉了一大截；歪了的，却从 25 涨到了 47。", ["59", "24", "25", "47"]],
  ["Thariq 的数据里，照章办事的那类任务，比如替一家公司把月底的贸易统计申报从头报到尾，档位一路往上拉，做成的也只从 12% 涨到 22%。", ["12%", "22%"]],
  ["拿重新设计一个设置菜单来说：low 用了 1 分钟，出了个能点的草图，意思到了，但看着不像真产品；max 用了 28 分钟，出来的样稿跟真的几乎一样，还附带了好几段流程演示。", ["1 分钟", "28 分钟"]],
  ["还是那组实测，做成的从 low 的 140，涨到了 max 的 214。", ["140", "214"]],
];

/** [句子, 标记里必须出现的来源] */
const ATTRIBUTION_SENTENCES: Array<[string, string]> = [
  ["国内有技术号管它叫「智商等级」，说烧脑的任务直接拉满。", "技术号"],
  ["Thariq 自己的总结，也正好是这两样。", "Thariq"],
  ["high 那边，Thariq 把全过程翻出来看：它先站到对面，把自己的第一版狠狠挑了一遍刺；接着一遍一遍地测；最后干脆自己造了一大堆稀奇古怪的网页去砸它。", "Thariq"],
  ["这个分类，是让另一个 AI 当裁判打的，原文自己就注明了只是近似，我不拿它当定律。", "原文"],
  ["可 Thariq 说，这一回更愿意用 low，先看懂 AI 想往哪走。", "Thariq"],
  ["前三步，跟 Thariq 在文章里写的顺序几乎一样：先让 AI 反过来提问，把没想到的细节问全；再用 low 做出来，自己看一遍，不对就在 low 上接着改；最后开 high 去验收。", "Thariq"],
];

describe("factualSentences — 真实口播稿", () => {
  it.each(IDIOM_AND_ARTICLE_SENTENCES)("口语「说」、行文量词不需要出处：%s", (sentence) => {
    expect(factualSentences(sentence)).toEqual([]);
  });

  it.each(NUMBER_SENTENCES)("真实数字要出处：%s", (sentence, numbers) => {
    expect(factualSentences(sentence).map((s) => s.numbers)).toEqual([numbers]);
  });

  it.each(ATTRIBUTION_SENTENCES)("明确归因要出处（含不带「说」的）：%s", (sentence, source) => {
    const [hit] = factualSentences(sentence);
    expect(hit?.attribution).toContain(source);
  });

  it("没有归因标记的转述留给写稿侧自核，不按主语猜", () => {
    expect(factualSentences("Thariq 把这两种错分开数了。")).toEqual([]);
  });

  it("定位是整句的 UTF-16 下标，跨段落只挑需要出处的句子", () => {
    const body = [IDIOM_AND_ARTICLE_SENTENCES[0], NUMBER_SENTENCES[0][0], IDIOM_AND_ARTICLE_SENTENCES[27], ATTRIBUTION_SENTENCES[4][0]].join("\n\n");
    const found = factualSentences(body);
    expect(found.map((s) => body.slice(s.start, s.end))).toEqual([NUMBER_SENTENCES[0][0], ATTRIBUTION_SENTENCES[4][0]]);
  });
});

describe("findAttribution — 常见归因句式", () => {
  it.each([
    "据报道，OpenAI 下个月发新模型。",
    "据 The Information 报道，Anthropic 在融资。",
    "听说 DeepSeek 要开源新模型。",
    "雷军说过一句话：站在风口上，猪都能飞。",
    "黄仁勋公开表示，每个人都会是程序员。",
    "他跟我说，先别急着上线。",
    "有人说 AI 会取代程序员。",
    "很多人认为深度思考越高越好。",
    "在 Karpathy 看来，提示词工程会消失。",
    "用 Karpathy 的话说，英语是最热门的编程语言。",
    "Karpathy 的原话是：英语是新的编程语言。",
    "研究显示，想得越久越容易跑偏。",
    "这篇文章指出，档位越高越慢。",
    "官方称：新版本更稳。",
    "Altman 昨天发了条推，说 GPT-6 快了。",
    "Thariq 在博客里介绍了他的做法。",
    "根据 Anthropic 的数据，max 档更慢。",
    "在视频里 Thariq 说，先问清楚。",
    "Thariq 后来说，这一回更愿意用 low。",
  ])("识别：%s", (sentence) => {
    expect(findAttribution(sentence)).toBeTruthy();
  });

  it.each([
    "我认为你应该先想清楚。",
    "你可能会认为开到最高就对了。",
    "在我看来，上下文才是关键。",
    "我在视频里说过这个问题。",
    "你在文档里写清楚要求。",
    "说实话，我也踩过这个坑。",
    "换句话说，档位不是智商。",
    "对我来说，这个开关没用。",
    "俗话说，磨刀不误砍柴工。",
    "它会指出你漏掉的地方。",
    "请指出文中所有错误。",
    "看完报告，你就知道了。",
    "这说明方向是对的。",
    "不得不承认，它比我快。",
    "上周我发了条视频，说了一下这个问题。",
    "有句话你肯定听过：别用战术上的勤奋，掩盖战略上的懒惰。",
    "AI 的看法不一定对。",
    "复盘的结论要先写。",
    "反过来说，查得多也不一定好。",
    "也在这一步强调一下背景。",
  ])("不误判：%s", (sentence) => {
    expect(findAttribution(sentence)).toBeUndefined();
  });

  it("行文量词不算数，真实量照算（与写稿数字硬门同一口径）", () => {
    expect(factualSentences("一次问一个问题，同一个问题问三遍。")).toEqual([]);
    expect(factualSentences("第 3 步最关键，GPT-5 比 GPT-4 聪明。")).toEqual([]);
    expect(factualSentences("今天聊聊我怎么用 AI 工具省下每天两小时。")[0]?.numbers).toEqual(["两小时"]);
    expect(factualSentences("七成企业还没用上 AI。")[0]?.numbers).toEqual(["七成"]);
  });
});
