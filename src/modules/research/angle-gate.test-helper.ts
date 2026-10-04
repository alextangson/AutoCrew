/** 测试用：模拟「选题会已开、创始人已拍板」，让开写入口的闸口放行（只在临时资料库里用） */
import { getTopic, saveTopic, updateTopic } from "../../storage/local-store.js";
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
  // 同真实的 select_angle：选卡取代之前的自定角度，只认最新一次决定
  await updateTopic(topicId, { selectedAngle: { ...topic.selectedAngle, chosenBy: "founder", founderWords: TEST_FOUNDER_WORDS }, founderAngle: undefined }, dataDir);
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
  // 测试里直接写进去的旧选卡：比自定角度新（或没有自定角度）才视为创始人后来改选了这张
  else if (topic.selectedAngle && topic.selectedAngle.chosenBy !== "founder"
    && (!topic.founderAngle || Date.parse(topic.selectedAngle.selectedAt) >= Date.parse(topic.founderAngle.chosenAt))) await founderStamped(dataDir, topicId);
}

/** 用固定 id 落一条选题并记创始人自定角度（引擎生成类测试的请求里写死了 topicId） */
export async function seedFounderTopic(dataDir: string, ids: string | string[], title = "测试选题"): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  for (const id of Array.isArray(ids) ? ids : [ids]) {
    await fs.mkdir(path.join(dataDir, "topics"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "topics", `${id}.json`), JSON.stringify({ id, title, description: "", tags: [], createdAt: "2026-01-01T00:00:00.000Z" }));
    await founderAuthored(dataDir, id);
  }
}

/** saveTopic + 创始人已定角度（只给测引擎内部行为、不测闸口的老测试用） */
export async function saveFounderTopic(topic: Parameters<typeof saveTopic>[0], dataDir: string): ReturnType<typeof saveTopic> {
  const saved = await saveTopic(topic, dataDir);
  await founderAuthored(dataDir, saved.id);
  return saved;
}
