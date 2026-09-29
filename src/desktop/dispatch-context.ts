/**
 * 按钮派活的结构化上下文（总编辑接本机 agent v1.1）：气泡只显示人话（「写抖音稿 ·《测试》」），
 * 选题编号、血缘、复用源稿、手写角度、「直接写」这些随轮次以结构化字段传进来，由这里拼成给模型看的那段话。
 * 两个后端共用：内置引擎把它拼在本轮 user 消息前，本机 agent 拼在 prompt 前；都不进对话历史。
 *
 * 两句话是**接口不是文案**（原 frontend/src/views/dispatch-brief.ts 的约定原样搬来）：
 * 手写方向「请原样放进 direction 参数」、直接写「请把这句原样放进 skip_reason 参数」。
 */
import { getContent, getTopic, type Topic } from "../storage/local-store.js";
import { platformLabel } from "./platform-label.js";

export interface DispatchInput {
  kind: "write";
  topicId?: string;
  title: string;
  platform: string;
  sourceId?: string;
  direction?: string;
  skipAngle?: boolean;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 边界上的外来值：只收白名单字段 */
export function parseDispatch(raw: unknown): DispatchInput | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== "write" || !str(o.title) || !str(o.platform)) return null;
  return {
    kind: "write",
    title: str(o.title),
    platform: str(o.platform),
    ...(str(o.topic_id) ? { topicId: str(o.topic_id) } : {}),
    ...(str(o.source_id) ? { sourceId: str(o.source_id) } : {}),
    ...(str(o.direction) ? { direction: str(o.direction) } : {}),
    ...(o.skip_angle === true ? { skipAngle: true } : {}),
  };
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

function sourceLine(source: { id: string; title: string; platform?: string }, platform: string): string {
  return `复用源稿：《${source.title}》（${platformLabel(source.platform ?? "")}，稿件编号 ${source.id}）。` +
    `先调用 get_draft（id：${source.id}）读取完整源稿，再调用 generate_script，` +
    `将源稿材料放入 research 参数，基于原稿事实和立意改写成${platformLabel(platform)}原生内容。` +
    "保留上述原 topic_id（如有），另存目标平台新稿，不覆盖源稿；" +
    "沿用现有写前角度选择、证据检查和审稿流程，不调用 adapt_platform";
}

/**
 * 拼给模型看的派活说明。选题已删（或不存在）→ 报错不发（U8）；
 * 源稿已删同理，免得模型对着一个不存在的 id 空转。
 */
export async function buildDispatchContext(d: DispatchInput, dataDir?: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const topic = d.topicId ? await getTopic(d.topicId, dataDir) : null;
  if (d.topicId && (!topic || topic.deletedAt)) return { ok: false, error: `选题《${d.title}》已不存在（可能被删了），这条派活没有发出。去灵感库确认后再派。` };
  const source = d.sourceId ? await getContent(d.sourceId, dataDir) : null;
  if (d.sourceId && (!source || source.deletedAt)) return { ok: false, error: `要复用的源稿（${d.sourceId}）已不存在，这条派活没有发出。` };
  let brief = `用选题《${d.title}》写一篇${platformLabel(d.platform)}原生版本`;
  const ctx = topic ? topicContext(topic, d.title) : [];
  if (source) ctx.push(sourceLine(source, d.platform));
  if (d.direction) ctx.push(`创作者手写角度(请原样放进 direction 参数)：${d.direction}（这是最高优先级的角度指引）`);
  if (ctx.length) brief += "。选题上下文——" + ctx.join("；");
  if (d.skipAngle) brief += "。用户已在工作台点了「直接写」,跳过角度点选(请把这句原样放进 skip_reason 参数)";
  return { ok: true, text: `【派活详情】${brief}\n\n` };
}
