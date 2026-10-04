/** 测试用：模拟「选题会已开、创始人已拍板」，让开写入口的闸口放行（只在临时资料库里用） */
import { getTopic, updateTopic } from "../../storage/local-store.js";
import { topicHashOf } from "./research-job-store.js";

export const TEST_FOUNDER_WORDS = "就按这个写（测试里创始人的原话）";
export const TEST_FOUNDER_DIRECTION = "创始人在选题会上定的角度";

/** 记一条创始人自定角度；之后的 prepare/pack 要带同一句 direction 才算「自定角度已定」 */
export async function founderAuthored(dataDir: string, topicIds: string | string[], direction = TEST_FOUNDER_DIRECTION): Promise<void> {
  for (const id of Array.isArray(topicIds) ? topicIds : [topicIds]) {
    const topic = await getTopic(id, dataDir);
    const topicHash = topic ? topicHashOf(topic.title, topic.description ?? "") : "missing-topic";
    if (!topic) throw new Error(`测试选题不存在：${id}`);
    await updateTopic(id, { founderAngle: { direction, founderWords: TEST_FOUNDER_WORDS, chosenAt: "2026-10-04T00:00:00.000Z", topicHash } }, dataDir);
  }
}

/** 把选题上已有的 selectedAngle 盖成「创始人原话选的」 */
export async function founderStamped(dataDir: string, topicId: string): Promise<void> {
  const topic = await getTopic(topicId, dataDir);
  if (!topic?.selectedAngle) throw new Error(`测试选题 ${topicId} 还没有 selectedAngle`);
  await updateTopic(topicId, { selectedAngle: { ...topic.selectedAngle, chosenBy: "founder", founderWords: TEST_FOUNDER_WORDS } }, dataDir);
}

/**
 * 测试夹具：把这次调用当成「创始人已在选题会上拍板」——带 direction 就记成创始人自定角度，
 * 选题上已有的 selectedAngle 盖上创始人原话。只给不测闸口本身的老测试用；闸口有自己的专门测试。
 */
export async function asFounder(dataDir: string, params: Record<string, unknown>): Promise<void> {
  const topicId = typeof params.topic_id === "string" ? params.topic_id : "";
  if (!topicId) return;
  const topic = await getTopic(topicId, dataDir);
  if (!topic) return;
  const direction = typeof params.direction === "string" ? params.direction.trim() : "";
  if (direction) await founderAuthored(dataDir, topicId, direction);
  if (topic.selectedAngle && topic.selectedAngle.chosenBy !== "founder") await founderStamped(dataDir, topicId);
}
