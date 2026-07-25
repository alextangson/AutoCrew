/**
 * 对标拆解卡工作台 handlers（收件箱设计 §4）：`patterns:list / update / delete`。
 *
 * 三条纪律：
 * 1. **只许改 founderNote 与 applicablePlatforms**（§3.5）：其余字段是 LLM 拆解产物，
 *    改了就与来源对不上。白名单在 store 层兜死，这里只负责把 snake_case 入参翻译过去
 *    ——多余的键根本不组装进 patch，越不过边界。
 * 2. **删除是墓碑不是物理删**（§3.5）：deletePatternCard 写 deletedAt，同链接再转发时
 *    查重命中墓碑 → 回执「此前已删过」，而不是静默复活。
 * 3. **卡与台账同工作区**：拆解卡由消化管线写进 targetWorkspace，读侧必须同源，
 *    否则收件箱里的落点 `pat-xxx` 点进来会是空的。
 */
import { CLIPBOARD_PLATFORMS, type ClipboardPlatform } from "../modules/publish/clipboard-publisher.js";
import {
  deletePatternCard,
  listPatternCards,
  updatePatternCard,
  type PatternCardPatch,
} from "../modules/patterns/pattern-store.js";
import { inboxDataDir } from "./inbox-handlers.js";

type Payload = Record<string, unknown>;
type Reply = Record<string, unknown>;

const KNOWN_PLATFORMS = new Set<string>(CLIPBOARD_PLATFORMS);

function badPayload(payload: Payload): Reply | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "Invalid payload: expected object" };
  }
  return null;
}

function fail(err: unknown): Reply {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

function requireId(payload: Payload): string | null {
  return typeof payload.id === "string" && payload.id.trim() ? payload.id.trim() : null;
}

/** 未知平台当场拒，不静默丢——「改了没生效」是最难查的一类 bug */
function parsePlatforms(input: unknown): { list: ClipboardPlatform[] } | { error: string } {
  if (!Array.isArray(input)) return { error: "applicable_platforms 必须是字符串数组" };
  const list: ClipboardPlatform[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") return { error: "applicable_platforms 只接受字符串" };
    const clean = raw.trim();
    if (!clean) continue;
    if (!KNOWN_PLATFORMS.has(clean)) return { error: `未知的适用平台：${clean}` };
    if (!list.includes(clean as ClipboardPlatform)) list.push(clean as ClipboardPlatform);
  }
  return { list };
}

/** 默认排除墓碑，按 updatedAt 降序（store 已排好序） */
export async function patternsListHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  try {
    const cards = await listPatternCards({}, inboxDataDir(payload));
    return { ok: true, data: { cards, total: cards.length } };
  } catch (err) {
    return fail(err);
  }
}

export async function patternsUpdateHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const id = requireId(payload);
  if (!id) return { ok: false, error: "id 必填" };
  const patch: PatternCardPatch = {};
  if (payload.founder_note !== undefined) {
    if (typeof payload.founder_note !== "string") return { ok: false, error: "founder_note 必须是字符串（清空传空串）" };
    patch.founderNote = payload.founder_note.trim();
  }
  if (payload.applicable_platforms !== undefined) {
    const parsed = parsePlatforms(payload.applicable_platforms);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    patch.applicablePlatforms = parsed.list;
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "没有要保存的修改（只允许改 founder_note 与 applicable_platforms）" };
  }
  try {
    return { ok: true, data: { card: await updatePatternCard(id, patch, inboxDataDir(payload)) } };
  } catch (err) {
    return fail(err);
  }
}

export async function patternsDeleteHandler(payload: Payload): Promise<Reply> {
  const bad = badPayload(payload);
  if (bad) return bad;
  const id = requireId(payload);
  if (!id) return { ok: false, error: "id 必填" };
  try {
    const card = await deletePatternCard(id, inboxDataDir(payload));
    if (!card) return { ok: false, error: `拆解卡不存在：${id}` };
    return { ok: true, data: { card } };
  } catch (err) {
    return fail(err);
  }
}
