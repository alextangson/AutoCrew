/**
 * 冒烟用假 runLoop —— `--mock` 走这条，**一次真实 API 调用都不发**。
 *
 * 它不是「返回一段固定字符串」的桩：真实链路里稿子是模型**调工具**交回来的，
 * 而 submit_script 的 execute 里还挂着 Quality Gate。桩要是不调工具，
 * 冒烟就只能证明「参数解析没炸」，证明不了「管线跑得通」。
 * 所以这里按 agent 分派：写手/改稿调 submit_script，审稿调 submit_review。
 *
 * 假稿刻意造得**过得了公众号 gate**（≥1500 中文字符、≥3 处带量纲的数据、钩子不踩禁开头），
 * 这样冒烟走的就是「一轮过」的主路径，而不是 gate 修复的分支。
 */
import type { runLoop as RunLoop, LoopResult, LoopTool } from "../../../src/engine/loop.js";

const PARA = [
  "我在 2026 年 3 月接过这条线，第一周就发现问题不在模型，而在给模型的那张输入表：",
  "同样一段素材，换个人整理，出来的稿子差得像两个作者写的。我们统计过 12 篇稿子，",
  "返工率是 60%，平均每篇要来回 3 轮。真正管用的动作只有一个——把第一手材料写下来，",
  "而不是让模型自己去猜行业常识。这件事我花了 4 个月才承认。",
].join("");

/** 拼到指定中文字符数以上，保证过 minChars；重复段落不影响冒烟目的 */
function fillBody(minCjk: number): string {
  const chunks: string[] = [];
  let cjk = 0;
  for (let i = 0; cjk < minCjk; i++) {
    const p = `${i + 1}、${PARA}`;
    chunks.push(p);
    cjk += (p.match(/[一-鿿]/g) ?? []).length;
  }
  return chunks.join("\n\n");
}

const MOCK_PAYLOAD = {
  title: "【冒烟】输入贫瘠还是流程缺陷",
  hook: "去年我们烧掉 4 个月才承认：写不好不是模型笨，是我们没给料。",
  body: fillBody(1600),
  cta: "你手上那条线，第一手材料是写下来了，还是只在你脑子里？",
  hashtags: ["AI写作", "内容生产"],
};

/** 直写格没有工具，模型直接吐正文——假实现回一段同量级的文本 */
const MOCK_DIRECT_TEXT = `${MOCK_PAYLOAD.title}\n\n${MOCK_PAYLOAD.hook}\n\n${MOCK_PAYLOAD.body}\n\n${MOCK_PAYLOAD.cta}`;

function findTool(tools: LoopTool[] | undefined, name: string): LoopTool | undefined {
  return tools?.find((t) => t.name === name);
}

/**
 * 假 runLoop。按 logMeta.agent 分派；未知 agent 回退成「直接吐文本」。
 * 返回的 token 数是编的（冒烟只验形状，不验计费）。
 */
export function makeMockRunLoop(): typeof RunLoop {
  return async (_config, options): Promise<LoopResult> => {
    const agent = options.logMeta?.agent ?? "unknown";

    if (agent === "writer" || agent === "reviser") {
      const tool = findTool(options.tools, "submit_script");
      if (!tool) throw new Error("mock：写手轮没有 submit_script 工具——管线契约变了，冒烟需要同步更新");
      const reply = await tool.execute({ ...MOCK_PAYLOAD, hashtags: [...MOCK_PAYLOAD.hashtags] });
      if (reply.startsWith("Error:")) {
        throw new Error(`mock：假稿没过 submit_script 校验/Quality Gate：${reply}`);
      }
      return { finalMessage: "已提交", turns: 2, totalTokens: 4200, toolCallCount: 1, stopReason: "no_tool_calls" };
    }

    if (agent === "angle") {
      const tool = findTool(options.tools, "submit_angles");
      if (!tool) throw new Error("mock：立意轮没有 submit_angles 工具——契约变了，冒烟需要同步更新");
      const gains = { grow: "听懂了 harness 是什么，想关注", trust: "看到实测细节，收藏", convert: "知道找谁问" };
      const mk = (id: string, persona: "grow" | "trust" | "convert", thesis: string) => ({
        id, primaryPersona: persona, misconception: "Star 多等于能用", thesis, nextAction: "今晚花 20 分钟装一个插件", elements: ["新奇点", "爽点"],
        counterResponse: "rc 版不稳", firsthandAnchor: "我上次给它写了个插件", personaGains: gains, structure: "claim-case-claim", hookDraft: "两天十万星，我却先装了个插件", antiScope: "不讲论文",
        payoff: "Star 只说明多少人想看，不说明能不能用；今晚花 20 分钟装一个插件，你就知道它对你有没有用", evidenceNeeds: ["一个企业用开源框架上生产翻车的真实案例"],
      });
      const reply = await tool.execute({
        misconceptions: { grow: ["以为要会写代码才能用"], trust: ["以为是又一个框架"], convert: ["以为 Star 多就能上生产"] },
        candidates: [mk("a", "grow", "Star 和能不能用是两件事"), mk("b", "trust", "插件协议才是它真正的产品"), mk("c", "convert", "先拿它做内部工具再谈生产")],
      });
      if (reply.startsWith("Error:")) throw new Error(`mock：假立意没过校验：${reply}`);
      return { finalMessage: "已提交", turns: 2, totalTokens: 2500, toolCallCount: 1, stopReason: "no_tool_calls" };
    }

    if (agent === "reviewer") {
      const tool = findTool(options.tools, "submit_review");
      if (!tool) throw new Error("mock：审稿轮没有 submit_review 工具——管线契约变了，冒烟需要同步更新");
      await tool.execute({ verdict: "pass", issues: [] });
      return { finalMessage: "已审", turns: 2, totalTokens: 1800, toolCallCount: 1, stopReason: "no_tool_calls" };
    }

    return {
      finalMessage: MOCK_DIRECT_TEXT,
      turns: 1,
      totalTokens: 3100,
      toolCallCount: 0,
      stopReason: "no_tool_calls",
    };
  };
}
