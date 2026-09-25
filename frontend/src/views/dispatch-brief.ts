/**
 * 平台矩阵「生成」派给总编辑的那段话(纯函数,好测)。
 *
 * 两句话是**接口不是文案**,改动会改掉模型的行为:
 * - 手写方向那句点名「请原样放进 direction 参数」——direction 是最高优先级的角度来源
 *   (角度卡 spec §1.3),模型走结构化参数才压得住选中的角度卡;
 * - 「直接写」那句点名「请把这句原样放进 skip_reason 参数」——§1.6 明令跳过角度必须
 *   是显式动作 + 原话转述,落 run-log 可回溯,不是模型自己猜的一个布尔。
 */
import { platformLabel, type Content, type Topic } from "../lib";

export interface DispatchBriefInput {
  title: string;
  topic: Topic | null;
  /** 选题记录缺失时，仍沿用稿件上留存的血缘；真实 topic.id 优先。 */
  topicId?: string;
  /** 复用已有稿件时只传引用，由总编辑读取当前完整正文。 */
  source?: Pick<Content, "id" | "title" | "platform">;
  platform: string;
  direction: string;
  /** 用户在工作台显式点了「直接写」(§1.6 四选之一) */
  skipAngle: boolean;
}

function topicContext(t: Topic, title: string): string[] {
  const ctx: string[] = [`灵感库编号：${t.id}（开写时带上 topic_id,血缘别断）`];
  if (t.reason) ctx.push("入库理由：" + t.reason);
  if (t.description && t.description !== title) ctx.push("背景：" + t.description);
  if (typeof t.score === "number") ctx.push(`选题评分：${t.score}/100`);
  if (t.angles?.length) ctx.push(`可写角度：${t.angles.join("；")}`);
  if (t.link) ctx.push(`参考链接：${t.link}（先用 read_url 读原文再写，不要凭标题脑补）`);
  return ctx;
}

export function buildDispatchBrief(input: DispatchBriefInput): string {
  const { title, topic, direction } = input;
  let brief = `用选题《${title}》写一篇${platformLabel(input.platform)}原生版本`;
  const ctx = topic ? topicContext(topic, title) : [];
  if (!topic && input.topicId?.trim()) {
    ctx.push(`选题编号：${input.topicId.trim()}（选题记录暂缺，开写时仍带上原 topic_id,血缘别断）`);
  }
  if (input.source) {
    const source = input.source;
    ctx.push(
      `复用源稿：《${source.title}》（${platformLabel(source.platform)}，稿件编号 ${source.id}）。` +
      `先调用 get_draft（id：${source.id}）读取完整源稿，再调用 generate_script，` +
      `将源稿材料放入 research 参数，基于原稿事实和立意改写成${platformLabel(input.platform)}原生内容。` +
      "保留上述原 topic_id（如有），另存目标平台新稿，不覆盖源稿；" +
      "沿用现有写前角度选择、证据检查和审稿流程，不调用 adapt_platform",
    );
  }
  if (direction.trim()) {
    ctx.push(`创作者手写角度(请原样放进 direction 参数)：${direction.trim()}（这是最高优先级的角度指引）`);
  }
  if (ctx.length) brief += "。选题上下文——" + ctx.join("；");
  if (input.skipAngle) {
    brief += "。用户已在工作台点了「直接写」,跳过角度点选(请把这句原样放进 skip_reason 参数)";
  }
  return brief;
}
