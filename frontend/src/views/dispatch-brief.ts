/**
 * 平台矩阵「写 X 稿」派给总编辑的那一轮（纯函数,好测）。
 *
 * v1.1：气泡只显示人话（「写抖音稿 ·《测试》」）；选题编号、复用源稿、手写角度、「直接写」
 * 作为结构化 dispatch 随轮次传，服务端（src/desktop/dispatch-context.ts）拼成给模型的那段话——
 * 内置引擎和本机 agent 都吃同一份。原来拼在前端的提示词原样搬到了服务端。
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

export interface DispatchMessage {
  /** 气泡里显示的人话 */
  text: string;
  /** 随 chat:turn 传的结构化上下文 */
  dispatch: Record<string, unknown>;
}

export function buildDispatch(input: DispatchBriefInput): DispatchMessage {
  const topicId = input.topic?.id ?? input.topicId?.trim();
  const direction = input.direction.trim();
  const parts = [`写${platformLabel(input.platform)}稿 ·《${input.title}》`];
  if (input.source) parts.push(`复用《${input.source.title}》`);
  if (direction) parts.push(`角度：${direction}`);
  if (input.skipAngle) parts.push("直接写");
  return {
    text: parts.join(" · "),
    dispatch: {
      kind: "write",
      title: input.title,
      platform: input.platform,
      ...(topicId ? { topic_id: topicId } : {}),
      ...(input.source ? { source_id: input.source.id } : {}),
      ...(direction ? { direction } : {}),
      ...(input.skipAngle ? { skip_angle: true } : {}),
    },
  };
}
